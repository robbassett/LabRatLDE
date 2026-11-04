package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Accelerate-Biotech/LabRatLDE/internal/audit"
	"github.com/Accelerate-Biotech/LabRatLDE/internal/domain"
)

// manifest is what a signature binds to (SPEC-008-R02). It holds nothing
// time-dependent, so the same record always renders the same bytes. Arrays
// are sorted by id.
type manifest struct {
	Format            string            `json:"format"`
	RunID             string            `json:"run_id"`
	ExperimentID      string            `json:"experiment_id"`
	ProtocolVersionID string            `json:"protocol_version_id"`
	ProtocolSHA256    string            `json:"protocol_sha256"`
	State             string            `json:"state"`
	Params            json.RawMessage   `json:"params"`
	RunRev            int               `json:"run_rev"`
	NodeRev           int               `json:"node_rev"`
	Inputs            []manifestInput   `json:"inputs"`
	Datasets          []manifestDataset `json:"datasets"`
	Notes             []manifestNote    `json:"notes"`
}

type manifestInput struct {
	NodeID string `json:"node_id"`
	Rev    int    `json:"rev"`
}

type manifestDataset struct {
	NodeID string  `json:"node_id"`
	Rev    int     `json:"rev"`
	Count  *int64  `json:"count"`
	SHA256 *string `json:"sha256"`
}

type manifestNote struct {
	NoteID     string `json:"note_id"`
	NodeID     string `json:"node_id"`
	Rev        int    `json:"rev"`
	BodySHA256 string `json:"body_sha256"`
}

// buildManifest renders the run's manifest as canonical JSON and returns its
// text and lowercase-hex SHA-256. It reads only.
func buildManifest(ctx context.Context, tx pgx.Tx, runID string) (text []byte, sha string, err error) {
	m := manifest{Format: "labrat.run-manifest.v1", RunID: runID,
		Inputs: []manifestInput{}, Datasets: []manifestDataset{}, Notes: []manifestNote{}}
	var nodeID string
	err = tx.QueryRow(ctx, `
		SELECT r.experiment_id, r.protocol_version_id, encode(pv.sha256, 'hex'), r.state, r.node_id, r.params
		FROM runs r JOIN protocol_versions pv ON pv.id = r.protocol_version_id
		WHERE r.id = $1`, runID,
	).Scan(&m.ExperimentID, &m.ProtocolVersionID, &m.ProtocolSHA256, &m.State, &nodeID, &m.Params)
	if err != nil {
		return nil, "", err
	}
	if m.RunRev, err = latestRev(ctx, tx, "run", runID); err != nil {
		return nil, "", err
	}
	if m.NodeRev, err = latestRev(ctx, tx, "lineage_node", nodeID); err != nil {
		return nil, "", err
	}

	rows, err := tx.Query(ctx, `
		SELECT n.id, COALESCE((SELECT max(rev) FROM record_revisions
		                       WHERE entity_type = 'lineage_node' AND entity_id = n.id), 0)
		FROM lineage_edges e
		JOIN lineage_nodes n ON n.id = e.from_id
		WHERE e.to_id = $1 AND e.relation = 'used' AND n.kind <> 'protocol'
		ORDER BY n.id`, nodeID)
	if err != nil {
		return nil, "", err
	}
	for rows.Next() {
		var in manifestInput
		if err := rows.Scan(&in.NodeID, &in.Rev); err != nil {
			rows.Close()
			return nil, "", err
		}
		m.Inputs = append(m.Inputs, in)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	rows, err = tx.Query(ctx, `
		SELECT n.id, COALESCE((SELECT max(rev) FROM record_revisions
		                       WHERE entity_type = 'lineage_node' AND entity_id = n.id), 0),
		       (a.payload::jsonb->>'count')::bigint, a.payload::jsonb->>'sha256'
		FROM lineage_edges e
		JOIN lineage_nodes n ON n.id = e.to_id
		LEFT JOIN audit_events a ON a.entity_type = 'dataset' AND a.entity_id = n.id::text AND a.action = 'instrument.ingested'
		WHERE e.from_id = $1 AND e.relation = 'wasGeneratedBy'
		ORDER BY n.id`, nodeID)
	if err != nil {
		return nil, "", err
	}
	for rows.Next() {
		var ds manifestDataset
		if err := rows.Scan(&ds.NodeID, &ds.Rev, &ds.Count, &ds.SHA256); err != nil {
			rows.Close()
			return nil, "", err
		}
		m.Datasets = append(m.Datasets, ds)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	// Annotations are left out: they never alter the sealed record.
	rows, err = tx.Query(ctx, `
		SELECT nt.id, nt.node_id,
		       COALESCE((SELECT max(rev) FROM record_revisions WHERE entity_type = 'note' AND entity_id = nt.id), 0),
		       encode(sha256(convert_to(nt.body, 'UTF8')), 'hex')
		FROM notes nt
		WHERE NOT nt.annotation
		  AND (nt.node_id = $1 OR nt.node_id IN
		       (SELECT e.to_id FROM lineage_edges e WHERE e.from_id = $1 AND e.relation = 'wasGeneratedBy'))
		ORDER BY nt.id`, nodeID)
	if err != nil {
		return nil, "", err
	}
	for rows.Next() {
		var n manifestNote
		if err := rows.Scan(&n.NoteID, &n.NodeID, &n.Rev, &n.BodySHA256); err != nil {
			rows.Close()
			return nil, "", err
		}
		m.Notes = append(m.Notes, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	text, err = audit.Canonicalize(m)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(text)
	return text, hex.EncodeToString(sum[:]), nil
}

// getManifest shows the manifest a signature would bind to now, with the
// latest valid signature's hash and what changed since (R02, R19).
//
//	GET /v1/runs/{id}/manifest
func (s *Server) getManifest(w http.ResponseWriter, r *http.Request) {
	ctx, p := r.Context(), principal(r.Context())
	id := r.PathValue("id")
	if !validUUID(id) {
		s.fail(w, r, notFound("run"))
		return
	}
	type previous struct {
		Step   int    `json:"step"`
		SHA256 string `json:"sha256"`
	}
	res := struct {
		Manifest string          `json:"manifest"`
		SHA256   string          `json:"sha256"`
		Previous *previous       `json:"previous"`
		Changes  []domain.Change `json:"changes"`
	}{Changes: []domain.Change{}}
	err := s.db.WithTenant(ctx, p.Tenant, p.As, func(tx pgx.Tx) error {
		text, sha, err := buildManifest(ctx, tx, id)
		if err != nil {
			return err
		}
		res.Manifest, res.SHA256 = string(text), sha

		var prev previous
		var prevText string
		err = tx.QueryRow(ctx, `
			SELECT s.step, encode(s.manifest_sha256, 'hex'), m.manifest
			FROM signatures s JOIN signature_manifests m ON m.id = s.manifest_id
			WHERE s.entity_type = 'run' AND s.entity_id = $1 AND s.invalidated_at IS NULL
			ORDER BY s.signed_at DESC LIMIT 1`, id).Scan(&prev.Step, &prev.SHA256, &prevText)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		} else if err != nil {
			return err
		}
		var from, to map[string]any
		if err := json.Unmarshal([]byte(prevText), &from); err != nil {
			return err
		}
		if err := json.Unmarshal(text, &to); err != nil {
			return err
		}
		res.Previous, res.Changes = &prev, domain.Diff(from, to)
		return nil
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// signature is a signature's JSON. A signature is valid until a committed
// correction invalidates it.
type signature struct {
	ID                     string     `json:"id"`
	Step                   int        `json:"step"`
	Meaning                string     `json:"meaning"`
	Signer                 string     `json:"signer"`
	PrintedName            string     `json:"printed_name"`
	SignedAt               time.Time  `json:"signed_at"`
	ManifestSHA256         string     `json:"manifest_sha256"`
	Comment                *string    `json:"comment"`
	ReauthMethod           string     `json:"reauth_method"`
	Valid                  bool       `json:"valid"`
	InvalidatedAt          *time.Time `json:"invalidated_at"`
	InvalidatedByChangeSet *string    `json:"invalidated_by_change_set"`
	InvalidatedReason      *string    `json:"invalidated_reason"`
}

// loadSignatures returns a run's signatures, oldest first. It is never nil.
func loadSignatures(ctx context.Context, tx pgx.Tx, runID string) ([]signature, error) {
	rows, err := tx.Query(ctx, `
		SELECT s.id, s.step, s.meaning, p.handle, s.printed_name, s.signed_at, encode(s.manifest_sha256, 'hex'),
		       s.comment, s.reauth_method, s.invalidated_at IS NULL, s.invalidated_at, s.invalidated_by_change_set::text, cs.reason
		FROM signatures s
		JOIN principals p ON p.id = s.signer_id
		LEFT JOIN change_sets cs ON cs.id = s.invalidated_by_change_set
		WHERE s.entity_type = 'run' AND s.entity_id = $1
		ORDER BY s.signed_at, s.id`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []signature{}
	for rows.Next() {
		var s signature
		if err := rows.Scan(&s.ID, &s.Step, &s.Meaning, &s.Signer, &s.PrintedName, &s.SignedAt, &s.ManifestSHA256,
			&s.Comment, &s.ReauthMethod, &s.Valid, &s.InvalidatedAt, &s.InvalidatedByChangeSet, &s.InvalidatedReason); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// maxAuthTimeSkew is how far in the future an auth_time may be, for clock skew
// between the IdP and this server. signRun records no later than the current time.
const maxAuthTimeSkew = 60 * time.Second

// checkReauth proves the signer logged in just now (SPEC-008-R04). In prod
// the ID token must come from the issuer, for the UI client and the caller's
// own subject, with an auth_time no older than the configured age. In dev no
// token is needed. It writes nothing. It returns when the login happened and
// how it was proved.
func (s *Server) checkReauth(ctx context.Context, tx pgx.Tx, p Principal, token string) (time.Time, string, error) {
	if s.cfg.Env != "prod" {
		var now time.Time
		err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now)
		return now, "dev", err
	}
	if s.reauth == nil {
		return time.Time{}, "", &httpError{http.StatusNotImplemented, "signing needs LDE_OIDC_UI_CLIENT_ID to be configured"}
	}
	if token == "" {
		return time.Time{}, "", unauthorized("reauth_token is required")
	}
	tok, err := s.reauth.Verify(ctx, token)
	if err != nil {
		s.log.Info("reauth token rejected", "err", err)
		return time.Time{}, "", unauthorized("invalid reauth_token")
	}
	var claims struct {
		AuthTime *int64 `json:"auth_time"`
	}
	if err := tok.Claims(&claims); err != nil || claims.AuthTime == nil {
		return time.Time{}, "", unauthorized("reauth_token has no auth_time")
	}
	var issuer, subject string
	if err := tx.QueryRow(ctx, `SELECT issuer, subject FROM principals WHERE id = $1`, p.As.ID).Scan(&issuer, &subject); err != nil {
		return time.Time{}, "", err
	}
	if tok.Issuer != issuer || tok.Subject != subject {
		return time.Time{}, "", unauthorized("reauth_token is for someone else")
	}
	at := time.Unix(*claims.AuthTime, 0)
	age := time.Since(at)
	if age > s.cfg.SignReauthMaxAge || age < -maxAuthTimeSkew {
		return time.Time{}, "", unauthorized("log in again to sign: your login is not recent enough")
	}
	return at, "oidc", nil
}

var sha256HexRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

// signRun applies the next signature of a run's policy.
//
//	POST /v1/runs/{id}/signatures   {"step": 1, "meaning": "author", "manifest_sha256": "...", "comment": "...", "reauth_token": "..."}
func (s *Server) signRun(w http.ResponseWriter, r *http.Request) {
	ctx, p := r.Context(), principal(r.Context())
	id := r.PathValue("id")
	if !validUUID(id) {
		s.fail(w, r, notFound("run"))
		return
	}
	var req struct {
		Step           int    `json:"step"`
		Meaning        string `json:"meaning"`
		ManifestSHA256 string `json:"manifest_sha256"`
		Comment        string `json:"comment"`
		ReauthToken    string `json:"reauth_token"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if strings.TrimSpace(req.Meaning) == "" {
		s.fail(w, r, badRequest("meaning is required"))
		return
	}
	if req.Step < 1 {
		s.fail(w, r, badRequest("step must be 1 or more"))
		return
	}
	if !sha256HexRE.MatchString(req.ManifestSHA256) {
		s.fail(w, r, badRequest("manifest_sha256 must be 64 lowercase hex characters"))
		return
	}
	var comment *string
	if req.Comment != "" {
		comment = &req.Comment
	}

	var out signature
	err := s.db.WithTenant(ctx, p.Tenant, p.As, func(tx pgx.Tx) error {
		reauthAt, method, err := s.checkReauth(ctx, tx, p, req.ReauthToken)
		if err != nil {
			return err
		}
		// The chain lock comes before the run lock: edits take them in this
		// order, and the opposite order deadlocks.
		if err := audit.LockChain(ctx, tx, p.Tenant); err != nil {
			return err
		}
		var from domain.RunState
		if err := tx.QueryRow(ctx, `SELECT state FROM runs WHERE id = $1 FOR UPDATE`, id).Scan(&from); err != nil {
			return err
		}
		text, sha, err := buildManifest(ctx, tx, id)
		if err != nil {
			return err
		}
		if sha != req.ManifestSHA256 {
			return &httpError{http.StatusConflict, "the record changed since you viewed it: review the new manifest and sign again"}
		}
		var manifestID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO signature_manifests (tenant_id, run_id, manifest) VALUES ($1, $2, $3) RETURNING id`,
			p.Tenant, id, string(text)).Scan(&manifestID); err != nil {
			return err
		}
		// The database stamps signer, printed name and time; these are placeholders.
		var sigID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO signatures (tenant_id, entity_type, entity_id, step, meaning, signer_id, printed_name, signed_at,
			                        manifest_id, manifest_sha256, comment, reauth_at, reauth_method)
			VALUES ($1, 'run', $2, $3, $4, $5, '', now(), $6, decode($7, 'hex'), $8, LEAST($9::timestamptz, clock_timestamp()), $10)
			RETURNING id`,
			p.Tenant, id, req.Step, req.Meaning, p.As.ID, manifestID, sha, comment, reauthAt, method).Scan(&sigID); err != nil {
			return err
		}
		if _, err := audit.Append(ctx, tx, p.Tenant, audit.Entry{
			Actor: p.Actor, Action: "signature.applied", EntityType: "signature", EntityID: sigID, Reason: req.Meaning,
			Payload: map[string]any{"run_id": id, "step": req.Step, "manifest_sha256": sha, "comment": comment},
		}); err != nil {
			return err
		}
		var to domain.RunState
		if err := tx.QueryRow(ctx, `SELECT state FROM runs WHERE id = $1`, id).Scan(&to); err != nil {
			return err
		}
		if to == domain.RunSigned {
			if _, err := audit.Append(ctx, tx, p.Tenant, audit.Entry{
				Actor: p.Actor, Action: "run.signed", EntityType: "run", EntityID: id, Reason: req.Meaning,
				Payload: map[string]any{"from": from, "to": to},
			}); err != nil {
				return err
			}
		}
		sigs, err := loadSignatures(ctx, tx, id)
		if err != nil {
			return err
		}
		for _, sg := range sigs {
			if sg.ID == sigID {
				out = sg
			}
		}
		return nil
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// listSignatures returns a run's signatures, oldest first.
//
//	GET /v1/runs/{id}/signatures
func (s *Server) listSignatures(w http.ResponseWriter, r *http.Request) {
	ctx, p := r.Context(), principal(r.Context())
	id := r.PathValue("id")
	if !validUUID(id) {
		s.fail(w, r, notFound("run"))
		return
	}
	var items []signature
	err := s.db.WithTenant(ctx, p.Tenant, p.As, func(tx pgx.Tx) error {
		var one int
		if err := tx.QueryRow(ctx, `SELECT 1 FROM runs WHERE id = $1`, id).Scan(&one); err != nil {
			return err
		}
		var err error
		items, err = loadSignatures(ctx, tx, id)
		return err
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
