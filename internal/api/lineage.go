package api

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/Accelerate-Biotech/LabRatLDE/internal/audit"
	"github.com/Accelerate-Biotech/LabRatLDE/internal/domain"
)

// insertNode creates a lineage node and audits it.
func insertNode(ctx context.Context, tx pgx.Tx, p Principal, kind domain.NodeKind, label string, attrs map[string]any) (string, error) {
	id, err := insertNodeRow(ctx, tx, p, kind, label, attrs)
	if err != nil {
		return "", err
	}
	return id, auditNodeCreated(ctx, tx, p, id, kind, label, attrs)
}

// insertNodeRow creates a lineage node. The caller must audit it with
// auditNodeCreated in the same transaction. It takes no chain lock, which is why
// an upload uses it directly (SPEC-023-R02).
func insertNodeRow(ctx context.Context, tx pgx.Tx, p Principal, kind domain.NodeKind, label string, attrs map[string]any) (string, error) {
	if !kind.Valid() || label == "" {
		return "", badRequest("lineage node needs a valid kind and a label")
	}
	if attrs == nil {
		attrs = map[string]any{}
	}
	var id string
	if err := tx.QueryRow(ctx, `
		INSERT INTO lineage_nodes (tenant_id, kind, label, attrs, created_by)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		p.Tenant, kind, label, attrs, p.Actor).Scan(&id); err != nil {
		return "", err
	}
	return id, nil
}

func auditNodeCreated(ctx context.Context, tx pgx.Tx, p Principal, id string, kind domain.NodeKind, label string, attrs map[string]any) error {
	if attrs == nil {
		attrs = map[string]any{}
	}
	_, err := audit.Append(ctx, tx, p.Tenant, audit.Entry{
		Actor: p.Actor, Action: "lineage.node_created", EntityType: "lineage_node", EntityID: id,
		Payload: map[string]any{"kind": kind, "label": label, "attrs": attrs},
	})
	return err
}

// insertEdge links two nodes and audits it. The database trigger rejects
// cycles with SQLSTATE LDE01, which the API surfaces as 409.
func insertEdge(ctx context.Context, tx pgx.Tx, p Principal, e domain.Edge) error {
	// The edge trigger locks the run. Take the chain lock first, as signing does.
	if err := audit.LockChain(ctx, tx, p.Tenant); err != nil {
		return err
	}
	if !e.Relation.Valid() {
		return badRequest("unknown relation %q", e.Relation)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO lineage_edges (tenant_id, from_id, to_id, relation, created_by)
		VALUES ($1, $2, $3, $4, $5)`,
		p.Tenant, e.From, e.To, e.Relation, p.Actor); err != nil {
		return err
	}
	_, err := audit.Append(ctx, tx, p.Tenant, audit.Entry{
		Actor: p.Actor, Action: "lineage.edge_created", EntityType: "lineage_edge",
		EntityID: e.From + ">" + e.To, Payload: e,
	})
	return err
}

func (s *Server) createNode(w http.ResponseWriter, r *http.Request) {
	ctx, p := r.Context(), principal(r.Context())
	var req struct {
		Kind  domain.NodeKind `json:"kind"`
		Label string          `json:"label"`
		Attrs map[string]any  `json:"attrs"`
		// SchemaVersionID is optional: the version the attrs must match.
		SchemaVersionID string `json:"schema_version_id"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if req.SchemaVersionID != "" && !validUUID(req.SchemaVersionID) {
		s.fail(w, r, badRequest("schema_version_id must be a uuid"))
		return
	}
	var id string
	err := s.db.WithTenant(ctx, p.Tenant, p.As, func(tx pgx.Tx) (err error) {
		id, err = insertSchemaNode(ctx, tx, p, req.Kind, req.Label, req.Attrs, req.SchemaVersionID)
		return err
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	node := domain.Node{ID: id, Kind: req.Kind, Label: req.Label, Attrs: req.Attrs}
	if req.SchemaVersionID != "" {
		node.SchemaVersionID = &req.SchemaVersionID
	}
	writeJSON(w, http.StatusCreated, node)
}

func (s *Server) createEdge(w http.ResponseWriter, r *http.Request) {
	ctx, p := r.Context(), principal(r.Context())
	var e domain.Edge
	if err := decodeJSON(w, r, &e); err != nil {
		s.fail(w, r, err)
		return
	}
	if !validUUID(e.From) || !validUUID(e.To) {
		s.fail(w, r, badRequest("from and to must be lineage node uuids"))
		return
	}
	if err := s.db.WithTenant(ctx, p.Tenant, p.As, func(tx pgx.Tx) error { return insertEdge(ctx, tx, p, e) }); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, e)
}

// getLineage returns the provenance closure around a node.
//
//	?direction=upstream|downstream|both   (default upstream: "where did this come from?")
func (s *Server) getLineage(w http.ResponseWriter, r *http.Request) {
	ctx, p := r.Context(), principal(r.Context())
	id := r.PathValue("id")
	if !validUUID(id) {
		s.fail(w, r, notFound("lineage node"))
		return
	}
	direction := r.URL.Query().Get("direction")
	switch direction {
	case "":
		direction = "upstream"
	case "upstream", "downstream", "both":
	default:
		s.fail(w, r, badRequest("direction must be upstream, downstream, or both"))
		return
	}

	g := domain.NewGraph()
	err := s.db.WithTenant(ctx, p.Tenant, p.As, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			WITH RECURSIVE
			up (id) AS (
				SELECT $1::uuid
				UNION SELECT e.from_id FROM lineage_edges e JOIN up ON e.to_id = up.id
			),
			down (id) AS (
				SELECT $1::uuid
				UNION SELECT e.to_id FROM lineage_edges e JOIN down ON e.from_id = down.id
			)
			SELECT id, kind, label, attrs, schema_version_id, created_at FROM lineage_nodes
			WHERE id IN (SELECT id FROM up   WHERE $2 IN ('upstream', 'both')
			             UNION
			             SELECT id FROM down WHERE $2 IN ('downstream', 'both'))`, id, direction)
		if err != nil {
			return err
		}
		defer rows.Close()
		var ids []string
		for rows.Next() {
			var n domain.Node
			if err := rows.Scan(&n.ID, &n.Kind, &n.Label, &n.Attrs, &n.SchemaVersionID, &n.CreatedAt); err != nil {
				return err
			}
			ids = append(ids, n.ID)
			if err := g.AddNode(n); err != nil {
				return err
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(ids) == 0 {
			return notFound("lineage node")
		}

		edges, err := tx.Query(ctx, `
			SELECT from_id, to_id, relation FROM lineage_edges
			WHERE from_id = ANY($1::uuid[]) AND to_id = ANY($1::uuid[])`, ids)
		if err != nil {
			return err
		}
		defer edges.Close()
		for edges.Next() {
			var e domain.Edge
			if err := edges.Scan(&e.From, &e.To, &e.Relation); err != nil {
				return err
			}
			if err := g.AddEdge(e); err != nil {
				return err
			}
		}
		return edges.Err()
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, struct {
		Root  string        `json:"root"`
		Nodes []domain.Node `json:"nodes"`
		Edges []domain.Edge `json:"edges"`
	}{id, g.Nodes(), g.Edges()})
}
