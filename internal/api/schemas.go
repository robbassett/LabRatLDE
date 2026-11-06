package api

import (
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Accelerate-Biotech/LabRatLDE/internal/audit"
	"github.com/Accelerate-Biotech/LabRatLDE/internal/domain"
)

var (
	schemaNamespaceRE = regexp.MustCompile(`^~?[a-z0-9][a-z0-9._@+-]{0,127}$`)
	schemaNameRE      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,127}$`)
)

// schemaInvalid is a refusal with a list of reasons (SPEC-009-R05). fail
// answers 422 with {error, errors}.
type schemaInvalid struct {
	subject  string
	problems []domain.SchemaProblem
}

func (e *schemaInvalid) Error() string {
	parts := make([]string, len(e.problems))
	for i, p := range e.problems {
		if p.Pointer == "" {
			parts[i] = p.Message
		} else {
			parts[i] = p.Pointer + " " + p.Message
		}
	}
	return e.subject + ": " + strings.Join(parts, "; ")
}

// validNodeKindOrRunParams checks a schema's applies_to.
func validNodeKindOrRunParams(s string) bool {
	return s == "run_params" || domain.NodeKind(s).Valid()
}

type schemaRecord struct {
	ID        string    `json:"id"`
	Namespace string    `json:"namespace"`
	Name      string    `json:"name"`
	AppliesTo string    `json:"applies_to"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

type schemaVersionRef struct {
	ID     string `json:"id"`
	Major  int    `json:"major"`
	Minor  int    `json:"minor"`
	SHA256 string `json:"sha256"`
}

type schemaVersionSummary struct {
	ID          string     `json:"id"`
	Major       int        `json:"major"`
	Minor       int        `json:"minor"`
	Status      string     `json:"status"`
	Author      string     `json:"author"`
	AuthorID    *string    `json:"author_id"`
	SHA256      string     `json:"sha256"`
	CreatedAt   time.Time  `json:"created_at"`
	PublishedAt *time.Time `json:"published_at"`
}

// createSchema registers a schema name. Its versions come later.
func (s *Server) createSchema(w http.ResponseWriter, r *http.Request) {
	ctx, p := r.Context(), principal(r.Context())
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		AppliesTo string `json:"applies_to"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	switch {
	case !schemaNamespaceRE.MatchString(req.Namespace):
		s.fail(w, r, badRequest("namespace must match %s", schemaNamespaceRE))
		return
	case !schemaNameRE.MatchString(req.Name):
		s.fail(w, r, badRequest("name must match %s", schemaNameRE))
		return
	case !validNodeKindOrRunParams(req.AppliesTo):
		s.fail(w, r, badRequest("applies_to must be a node kind or run_params"))
		return
	}
	sc := schemaRecord{Namespace: req.Namespace, Name: req.Name, AppliesTo: req.AppliesTo, CreatedBy: p.Actor}
	err := s.db.WithTenant(ctx, p.Tenant, p.As, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO schemas (tenant_id, namespace, name, applies_to, created_by)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, created_at`,
			p.Tenant, sc.Namespace, sc.Name, sc.AppliesTo, sc.CreatedBy,
		).Scan(&sc.ID, &sc.CreatedAt); err != nil {
			return err
		}
		_, err := audit.Append(ctx, tx, p.Tenant, audit.Entry{
			Actor: p.Actor, Action: "schema.created", EntityType: "schema", EntityID: sc.ID,
			Payload: map[string]any{"namespace": sc.Namespace, "name": sc.Name, "applies_to": sc.AppliesTo},
		})
		return err
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, sc)
}

// listSchemas pages through schemas, oldest first, each with its highest
// published version.
//
//	GET /v1/schemas?applies_to=&cursor=<uuid>&limit=<1..200>
func (s *Server) listSchemas(w http.ResponseWriter, r *http.Request) {
	ctx, p := r.Context(), principal(r.Context())
	cursor, limit, err := readPage(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	appliesTo := r.URL.Query().Get("applies_to")
	if appliesTo != "" && !validNodeKindOrRunParams(appliesTo) {
		s.fail(w, r, badRequest("applies_to must be a node kind or run_params"))
		return
	}
	type item struct {
		schemaRecord
		LatestPublished *schemaVersionRef `json:"latest_published"`
	}
	items := []item{}
	err = s.db.WithTenant(ctx, p.Tenant, p.As, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT s.id, s.namespace, s.name, s.applies_to, s.created_by, s.created_at,
			       v.id, v.major, v.minor, encode(v.sha256, 'hex')
			FROM schemas s
			LEFT JOIN LATERAL (
				SELECT id, major, minor, sha256 FROM schema_versions
				WHERE schema_id = s.id AND status = 'published'
				ORDER BY major DESC, minor DESC LIMIT 1
			) v ON true
			WHERE ($1::text = '' OR s.applies_to = $1)
			  AND ($2::text = '' OR (s.created_at, s.id) > (SELECT created_at, id FROM schemas WHERE id = NULLIF($2::text, '')::uuid))
			ORDER BY s.created_at, s.id
			LIMIT $3`, appliesTo, cursor, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var it item
			var vID, vSHA *string
			var vMajor, vMinor *int
			if err := rows.Scan(&it.ID, &it.Namespace, &it.Name, &it.AppliesTo, &it.CreatedBy, &it.CreatedAt,
				&vID, &vMajor, &vMinor, &vSHA); err != nil {
				return err
			}
			if vID != nil {
				it.LatestPublished = &schemaVersionRef{ID: *vID, Major: *vMajor, Minor: *vMinor, SHA256: *vSHA}
			}
			items = append(items, it)
		}
		return rows.Err()
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var last string
	if n := len(items); n > 0 {
		last = items[n-1].ID
	}
	writeJSON(w, http.StatusOK, page{Items: items, NextCursor: nextCursor(len(items), limit, last)})
}

// getSchema returns one schema with its versions, highest first, without their text.
func (s *Server) getSchema(w http.ResponseWriter, r *http.Request) {
	ctx, p := r.Context(), principal(r.Context())
	ns, name := r.PathValue("ns"), r.PathValue("name")
	out := struct {
		schemaRecord
		Versions []schemaVersionSummary `json:"versions"`
	}{Versions: []schemaVersionSummary{}}
	err := s.db.WithTenant(ctx, p.Tenant, p.As, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			SELECT id, namespace, name, applies_to, created_by, created_at
			FROM schemas WHERE namespace = $1 AND name = $2`, ns, name,
		).Scan(&out.ID, &out.Namespace, &out.Name, &out.AppliesTo, &out.CreatedBy, &out.CreatedAt)
		if err != nil {
			return err // pgx.ErrNoRows is 404
		}
		rows, err := tx.Query(ctx, `
			SELECT id, major, minor, status, author, author_id, encode(sha256, 'hex'), created_at, published_at
			FROM schema_versions WHERE schema_id = $1 ORDER BY major DESC, minor DESC`, out.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v schemaVersionSummary
			if err := rows.Scan(&v.ID, &v.Major, &v.Minor, &v.Status, &v.Author, &v.AuthorID, &v.SHA256, &v.CreatedAt, &v.PublishedAt); err != nil {
				return err
			}
			out.Versions = append(out.Versions, v)
		}
		return rows.Err()
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
