package storage_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Accelerate-Biotech/LabRatLDE/internal/audit"
	"github.com/Accelerate-Biotech/LabRatLDE/internal/storage"
)

// These tests exercise the guarantees that live in the database itself.
// Run them with: make test-integration  (needs `docker compose up -d`).
func openTestDB(t *testing.T) *storage.DB {
	t.Helper()
	url := os.Getenv("LDE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("LDE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	db, err := storage.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if err := db.Migrate(ctx, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	return db
}

func newTenant(t *testing.T, db *storage.DB) string {
	t.Helper()
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6], b[8] = (b[6]&0x0f)|0x40, (b[8]&0x3f)|0x80
	id := fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
	if err := db.EnsureTenant(context.Background(), id, "t-"+id[:8], "test"); err != nil {
		t.Fatal(err)
	}
	testers.Store(id, newPrincipal(t, db, id, "it@lab", "human", "scientist", "reviewer", "qa", "admin"))
	return id
}

// testers maps each newTenant tenant to its it@lab principal.
var testers sync.Map

// as returns the principal the tests act as in tenant.
func as(tenant string) storage.Principal {
	p, _ := testers.Load(tenant)
	return p.(storage.Principal)
}

// newPrincipal creates a principal (subject = handle at https://idp.test)
// holding roles, granted by itself, as the owner, with the audit events its
// rows need.
func newPrincipal(t *testing.T, db *storage.DB, tenant, handle, kind string, roles ...string) storage.Principal {
	t.Helper()
	ctx := context.Background()
	var p storage.Principal
	err := db.WithOwner(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, insertPrincipal, tenant, kind, handle).Scan(&p.ID); err != nil {
			return err
		}
		_, err := audit.Append(ctx, tx, tenant, audit.Entry{
			Actor: "system:test", Action: "principal.created", EntityType: "principal", EntityID: p.ID,
			Payload: map[string]any{"handle": handle, "kind": kind},
		})
		for _, role := range roles {
			if err != nil {
				return err
			}
			_, err = grantRole(ctx, tx, tenant, "system:test", p.ID, p.ID, role, "fixture", true)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// grantRole inserts a tenant-wide grant of role to principalID and, when
// audited, its role.granted event. As lde_app the trigger replaces grantedBy.
func grantRole(ctx context.Context, tx pgx.Tx, tenant, actor, principalID, grantedBy, role, reason string, audited bool) (string, error) {
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO role_grants (tenant_id, principal_id, role, reason, granted_by)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`, tenant, principalID, role, reason, grantedBy).Scan(&id); err != nil {
		return "", err
	}
	if !audited {
		return id, nil
	}
	_, err := audit.Append(ctx, tx, tenant, audit.Entry{
		Actor: actor, Action: "role.granted", EntityType: "role_grant", EntityID: id, Reason: reason,
		Payload: map[string]any{"principal_id": principalID, "role": role},
	})
	return id, err
}

func appendN(t *testing.T, db *storage.DB, tenant string, n int) {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < n; i++ {
		err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
			_, err := audit.Append(ctx, tx, tenant, audit.Entry{
				Actor: "it@lab", Action: "test.event", EntityType: "test", EntityID: fmt.Sprint(i),
				Reason: "ünïcödé reason", Payload: map[string]any{"i": i, "html": "<b>&</b>"},
			})
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

// SPEC-001-R07
func TestDatabaseAndEngineAgreeOnChain(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	var fixtureEvents int64 // newTenant's principal and role grants
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE tenant_id = $1`, tenant).Scan(&fixtureEvents); err != nil {
		t.Fatal(err)
	}
	appendN(t, db, tenant, 5)

	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		rep, err := audit.VerifyTenant(ctx, tx, tenant)
		if err != nil {
			return err
		}
		if !rep.Valid || rep.Events != fixtureEvents+5 {
			t.Fatalf("engine verify: %+v, want %d events", rep, fixtureEvents+5)
		}
		var headHash string
		var broken *int64
		if err := tx.QueryRow(ctx, `SELECT head_hash, broken_at FROM audit_verify_chain($1)`, tenant).Scan(&headHash, &broken); err != nil {
			return err
		}
		if broken != nil || headHash != rep.Head.Hash.String() {
			t.Fatalf("database verify disagrees: head=%s broken=%v engine=%s", headHash, broken, rep.Head.Hash)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// SPEC-001-R05
func TestDatabaseRejectsForgedEvent(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		ev, err := audit.Seal(tenant, audit.Head{Hash: audit.Genesis}, time.Now(), audit.Entry{
			Actor: "mallory", Action: "forge", EntityType: "x", EntityID: "1",
		})
		if err != nil {
			return err
		}
		ev.Actor = "alice" // content no longer matches hash
		_, err = tx.Exec(ctx, `
			INSERT INTO audit_events (tenant_id, seq, occurred_at, actor, action, entity_type, entity_id, reason, payload, prev_hash, hash)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			ev.TenantID, ev.Seq, ev.OccurredAt, ev.Actor, ev.Action, ev.EntityType, ev.EntityID, ev.Reason,
			string(ev.Payload), ev.PrevHash[:], ev.Hash[:])
		return err
	})
	if storage.ErrorCode(err) != storage.CodeAuditLink {
		t.Fatalf("want SQLSTATE %s, got %v", storage.CodeAuditLink, err)
	}
}

// SPEC-001-R06
func TestLedgerIsAppendOnly(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	appendN(t, db, tenant, 1)
	ctx := context.Background()
	for _, stmt := range []string{
		`UPDATE audit_events SET actor = 'mallory'`,
		`DELETE FROM audit_events`,
		`TRUNCATE audit_events`,
	} {
		err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error { _, err := tx.Exec(ctx, stmt); return err })
		if err == nil {
			t.Errorf("%q succeeded as the app role", stmt)
		}
	}
	// Even the owner, bypassing WithTenant, is stopped by the triggers.
	if _, err := db.Pool.Exec(ctx, `DELETE FROM audit_events WHERE tenant_id = $1`, tenant); storage.ErrorCode(err) != storage.CodeAppendOnly {
		t.Errorf("owner DELETE: want SQLSTATE %s, got %v", storage.CodeAppendOnly, err)
	}
}

// SPEC-001-R08
func TestRowLevelSecurityIsolatesTenants(t *testing.T) {
	db := openTestDB(t)
	a, b := newTenant(t, db), newTenant(t, db)
	appendN(t, db, a, 2)
	ctx := context.Background()
	var visible int
	err := db.WithTenant(ctx, b, as(b), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE tenant_id = $1`, a).Scan(&visible)
	})
	if err != nil || visible != 0 {
		t.Fatalf("tenant b saw %d of tenant a's events (err %v)", visible, err)
	}
}

// sealFixture is SPEC-002's shared fixture: sample S →used→ run R
// →wasGeneratedBy→ dataset D (100 readings from instrument I), with R then
// moved to a given state.
type sealFixture struct {
	tenant, s, r, d, i string // lineage node ids
	runID, instID      string
}

// insertReadings takes tenant, instrument, dataset and count.
const insertReadings = `
	INSERT INTO instrument_readings (tenant_id, instrument_id, dataset_id, ts, channel, value)
	SELECT $1, $2, $3, now() + make_interval(secs => g), 'ct', g FROM generate_series(1, $4::int) g`

func newSealFixture(t *testing.T, db *storage.DB, state string) sealFixture {
	t.Helper()
	ctx := context.Background()
	f := sealFixture{tenant: newTenant(t, db)}
	err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		for _, n := range []struct {
			id   *string
			kind string
		}{{&f.s, "sample"}, {&f.r, "run"}, {&f.d, "dataset"}, {&f.i, "instrument"}} {
			if err := tx.QueryRow(ctx, insertNode, f.tenant, n.kind).Scan(n.id); err != nil {
				return err
			}
		}
		var expID string
		if err := tx.QueryRow(ctx, `INSERT INTO experiments (tenant_id, slug, title, created_by)
			VALUES ($1, 'exp', 'exp', 'it@lab') RETURNING id`, f.tenant).Scan(&expID); err != nil {
			return err
		}
		pvID, _ := newProtocolVersion(t, tx, f.tenant, expID, 1, "# p\n")
		if err := tx.QueryRow(ctx, `INSERT INTO runs (tenant_id, experiment_id, node_id, protocol_version_id, created_by)
			VALUES ($1, $2, $3, $4, 'it@lab') RETURNING id`, f.tenant, expID, f.r, pvID).Scan(&f.runID); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `INSERT INTO instruments (tenant_id, node_id, name, kind)
			VALUES ($1, $2, 'qpcr-1', 'qpcr') RETURNING id`, f.tenant, f.i).Scan(&f.instID); err != nil {
			return err
		}
		for _, e := range [][3]string{{f.s, f.r, "used"}, {f.r, f.d, "wasGeneratedBy"}, {f.i, f.d, "wasAttributedTo"}} {
			if _, err := tx.Exec(ctx, insertEdge, f.tenant, e[0], e[1], e[2]); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, insertReadings, f.tenant, f.instID, f.d, 100)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE runs SET state = $2 WHERE id = $1`, f.runID, state); err != nil {
		t.Fatal(err)
	}
	return f
}

// insertNode takes tenant and kind; insertEdge takes tenant, from, to and relation.
const (
	insertNode = `INSERT INTO lineage_nodes (tenant_id, kind, label, created_by)
		VALUES ($1, $2, $2, 'it@lab') RETURNING id`
	insertEdge = `INSERT INTO lineage_edges (tenant_id, from_id, to_id, relation, created_by)
		VALUES ($1, $2, $3, $4, 'it@lab')`
)

// wantCode checks that err carries SQLSTATE code, or is nil when code is "".
func wantCode(t *testing.T, what string, err error, code string) {
	t.Helper()
	if got := storage.ErrorCode(err); got != code || (code == "" && err != nil) {
		t.Errorf("%s: want SQLSTATE %q, got %v", what, code, err)
	}
}

// SPEC-002-R01
func TestSealedSet(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	for _, tc := range []struct {
		state  string
		sealed bool
	}{{"signed", true}, {"aborted", true}, {"completed", false}} {
		f := newSealFixture(t, db, tc.state)
		for name, c := range map[string]struct {
			node string
			want bool
		}{"R": {f.r, tc.sealed}, "D": {f.d, tc.sealed}, "S": {f.s, false}, "I": {f.i, false}} {
			var got bool
			err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
				return tx.QueryRow(ctx, `SELECT lineage_node_sealed($1)`, c.node).Scan(&got)
			})
			if err != nil || got != c.want {
				t.Errorf("run %s: sealed(%s) = %v, want %v (err %v)", tc.state, name, got, c.want, err)
			}
		}
	}

	// SPEC-008-R08: one valid signature seals a completed run.
	f := newSignFixture(t, db, "completed")
	if _, err := trySign(db, f.tenant, f.alice, f.runID, 1, "author"); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]struct {
		node string
		want bool
	}{"R": {f.r, true}, "D": {f.d, true}, "S": {f.s, false}} {
		var got bool
		err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT lineage_node_sealed($1)`, c.node).Scan(&got)
		})
		if err != nil || got != c.want {
			t.Errorf("completed run with one signature: sealed(%s) = %v, want %v (err %v)", name, got, c.want, err)
		}
	}
}

// SPEC-002-R02, SPEC-002-R03, SPEC-002-R04
func TestSealedNodesGainNoInputsOrOutputs(t *testing.T) {
	db := openTestDB(t)
	f := newSealFixture(t, db, "signed")
	ctx := context.Background()
	const fresh = "fresh" // stands for a node created alongside the edge
	for _, tc := range []struct {
		name     string
		kind     string // of the fresh node
		from, to string
		relation string
		want     string
	}{
		{"R02 signed run uses new reagent", "reagent", fresh, f.r, "used", storage.CodeSealed},
		{"R02 sealed dataset derived from new node", "analysis", fresh, f.d, "wasDerivedFrom", storage.CodeSealed},
		{"R03 new dataset generated by signed run", "dataset", f.r, fresh, "wasGeneratedBy", storage.CodeSealed},
		{"R04 new analysis uses sealed dataset", "analysis", f.d, fresh, "used", ""},
	} {
		err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
			var id string
			if err := tx.QueryRow(ctx, insertNode, f.tenant, tc.kind).Scan(&id); err != nil {
				return err
			}
			from, to := tc.from, tc.to
			if from == fresh {
				from = id
			}
			if to == fresh {
				to = id
			}
			_, err := tx.Exec(ctx, insertEdge, f.tenant, from, to, tc.relation)
			return err
		})
		wantCode(t, tc.name, err, tc.want)
	}
}

// SPEC-002-R05
func TestSealedNodesAreImmutable(t *testing.T) {
	db := openTestDB(t)
	f := newSealFixture(t, db, "signed")
	ctx := context.Background()
	// As the owner, so no grant stands in the way: only the trigger does.
	for _, tc := range []struct{ name, stmt, node, want string }{
		{"update sealed dataset", `UPDATE lineage_nodes SET attrs = '{"x":1}' WHERE id = $1`, f.d, storage.CodeSealed},
		{"update signed run node", `UPDATE lineage_nodes SET label = 'x' WHERE id = $1`, f.r, storage.CodeSealed},
		{"delete sealed dataset", `DELETE FROM lineage_nodes WHERE id = $1`, f.d, storage.CodeSealed},
	} {
		_, err := db.Pool.Exec(ctx, tc.stmt, tc.node)
		wantCode(t, tc.name, err, tc.want)
	}
	// An unsealed node is editable, but only inside a committed change set.
	err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		if _, err := commitChangeSet(ctx, tx, f.tenant, "it@lab", "fixture"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE lineage_nodes SET attrs = '{"x":1}' WHERE id = $1`, f.s)
		return err
	})
	wantCode(t, "update unsealed sample", err, "")
}

// SPEC-002-R06, SPEC-002-R07
func TestReadingsOnlyFromCreatingTransaction(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()

	signed := newSealFixture(t, db, "signed")
	_, err := db.Pool.Exec(ctx, insertReadings, signed.tenant, signed.instID, signed.d, 1)
	wantCode(t, "R06 owner appends to sealed dataset", err, storage.CodeSealed)

	f := newSealFixture(t, db, "running")
	var d3 string
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, insertNode, f.tenant, "dataset").Scan(&d3); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, insertEdge, f.tenant, f.r, d3, "wasGeneratedBy"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, insertReadings, f.tenant, f.instID, d3, 1)
		return err
	})
	wantCode(t, "R07 creating transaction writes readings", err, "")
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, insertReadings, f.tenant, f.instID, d3, 1)
		return err
	})
	wantCode(t, "R07 later transaction appends readings", err, storage.CodeSealed)
}

// SPEC-002-R08
func TestAppRoleCannotUpdateUnusedTables(t *testing.T) {
	db := openTestDB(t)
	f := newSealFixture(t, db, "completed")
	ctx := context.Background()
	const insufficientPrivilege = "42501"
	for _, tc := range []struct{ stmt, want string }{
		{`UPDATE experiments SET slug = 'x'`, insufficientPrivilege},
		{`UPDATE lineage_nodes SET kind = 'analysis'`, insufficientPrivilege},
		{`UPDATE instruments SET name = 'x'`, insufficientPrivilege},
		{`UPDATE experiments SET title = 'x'`, storage.CodeAppendOnly},
		{`UPDATE lineage_nodes SET label = 'x'`, storage.CodeAppendOnly},
		{`UPDATE runs SET state = 'running'`, ""},
	} {
		err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error { _, err := tx.Exec(ctx, tc.stmt); return err })
		wantCode(t, tc.stmt, err, tc.want)
	}
}

// newExperiment takes tenant and slug; the title is the slug.
func newExperiment(t *testing.T, tx pgx.Tx, tenant, slug string) string {
	t.Helper()
	var id string
	if err := tx.QueryRow(context.Background(), `INSERT INTO experiments (tenant_id, slug, title, created_by)
		VALUES ($1, $2, $2, 'it@lab') RETURNING id`, tenant, slug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// insertProtocolVersion takes tenant, experiment, version and protocol text.
// It creates the protocol's lineage node and returns the version and node ids.
func insertProtocolVersion(tx pgx.Tx, tenant, expID string, version int, md string) (id, nodeID string, err error) {
	ctx := context.Background()
	if err := tx.QueryRow(ctx, insertNode, tenant, "protocol").Scan(&nodeID); err != nil {
		return "", "", err
	}
	err = tx.QueryRow(ctx, `INSERT INTO protocol_versions (tenant_id, experiment_id, version, protocol_md, node_id, created_by)
		VALUES ($1, $2, $3, $4, $5, 'it@lab') RETURNING id`, tenant, expID, version, md, nodeID).Scan(&id)
	return id, nodeID, err
}

func newProtocolVersion(t *testing.T, tx pgx.Tx, tenant, expID string, version int, md string) (id, nodeID string) {
	t.Helper()
	id, nodeID, err := insertProtocolVersion(tx, tenant, expID, version, md)
	if err != nil {
		t.Fatal(err)
	}
	return id, nodeID
}

// insertRun takes tenant, experiment and the pinned protocol version.
func insertRun(tx pgx.Tx, tenant, expID, protocolVersionID string) (runID string, err error) {
	ctx := context.Background()
	var nodeID string
	if err := tx.QueryRow(ctx, insertNode, tenant, "run").Scan(&nodeID); err != nil {
		return "", err
	}
	err = tx.QueryRow(ctx, `INSERT INTO runs (tenant_id, experiment_id, node_id, protocol_version_id, created_by)
		VALUES ($1, $2, $3, $4, 'it@lab') RETURNING id`, tenant, expID, nodeID, protocolVersionID).Scan(&runID)
	return runID, err
}

// SPEC-003-R01
func TestProtocolVersionHash(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	var id string
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		exp := newExperiment(t, tx, tenant, "hash")
		id, _ = newProtocolVersion(t, tx, tenant, exp, 1, "# A\n")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var got []byte
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT sha256 FROM protocol_versions WHERE id = $1`, id).Scan(&got)
	})
	want := sha256.Sum256([]byte("# A\n"))
	if err != nil || !bytes.Equal(got, want[:]) {
		t.Fatalf("sha256 = %x, want %x (err %v)", got, want, err)
	}
	// The hash is computed by the database, so a supplied value is refused.
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		exp := newExperiment(t, tx, tenant, "hash-forged")
		var node string
		if err := tx.QueryRow(ctx, insertNode, tenant, "protocol").Scan(&node); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO protocol_versions (tenant_id, experiment_id, version, protocol_md, node_id, created_by, sha256)
			VALUES ($1, $2, 1, 'x', $3, 'it@lab', '\x00'::bytea)`, tenant, exp, node)
		return err
	})
	wantCode(t, "INSERT with an explicit sha256", err, "428C9") // generated_always
}

// SPEC-003-R02
func TestProtocolVersionsAreAppendOnly(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		exp := newExperiment(t, tx, tenant, "append")
		newProtocolVersion(t, tx, tenant, exp, 1, "# v1")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`UPDATE protocol_versions SET protocol_md = 'x' WHERE tenant_id = $1`,
		`DELETE FROM protocol_versions WHERE tenant_id = $1`,
	} {
		// A failing statement aborts its transaction, so each gets a fresh one.
		err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error { _, err := tx.Exec(ctx, stmt, tenant); return err })
		wantCode(t, "app role: "+stmt, err, "42501") // no grant for lde_app
		// Even the owner, bypassing WithTenant, is stopped by the triggers.
		_, err = db.Pool.Exec(ctx, stmt, tenant)
		wantCode(t, "owner: "+stmt, err, storage.CodeAppendOnly)
	}
	_, err = db.Pool.Exec(ctx, `TRUNCATE protocol_versions, runs, signature_manifests, signatures, signature_challenges`) // runs and the signature tables reference it, so a bare TRUNCATE hits 0A000 first
	wantCode(t, "owner: TRUNCATE", err, storage.CodeAppendOnly)
	// The signature tables raise LDE03 too, so check the error is this table's.
	if msg := storage.ErrorMessage(err); !strings.Contains(msg, "protocol") {
		t.Errorf("TRUNCATE stopped by another table's trigger: %s", msg)
	}
}

// SPEC-003-R03
func TestProtocolVersionsAreGapless(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	var e, f string
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		e = newExperiment(t, tx, tenant, "gapless-e")
		newProtocolVersion(t, tx, tenant, e, 1, "v1")
		newProtocolVersion(t, tx, tenant, e, 2, "v2")
		f = newExperiment(t, tx, tenant, "gapless-f")
		newProtocolVersion(t, tx, tenant, f, 1, "v1")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		_, _, err := insertProtocolVersion(tx, tenant, e, 4, "v4")
		return err
	})
	wantCode(t, "version 4 after 2 skips 3", err, "23514")
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		_, _, err := insertProtocolVersion(tx, tenant, e, 3, "v3")
		return err
	})
	wantCode(t, "version 3 after 2", err, "")
}

// SPEC-003-R04
func TestRunProtocolMustBelongToExperiment(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	var e, pe1, pf1 string
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		e = newExperiment(t, tx, tenant, "pin-e")
		pe1, _ = newProtocolVersion(t, tx, tenant, e, 1, "pe1")
		f := newExperiment(t, tx, tenant, "pin-f")
		pf1, _ = newProtocolVersion(t, tx, tenant, f, 1, "pf1")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		_, err := insertRun(tx, tenant, e, pf1)
		return err
	})
	wantCode(t, "run of E pinned to protocol of F", err, "23503")
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		_, err := insertRun(tx, tenant, e, pe1)
		return err
	})
	wantCode(t, "run of E pinned to protocol of E", err, "")
}

// SPEC-003-R11
func TestRunProtocolPinIsImmutable(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	var runID, pe2 string
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		e := newExperiment(t, tx, tenant, "immutable")
		pe1, _ := newProtocolVersion(t, tx, tenant, e, 1, "v1")
		pe2, _ = newProtocolVersion(t, tx, tenant, e, 2, "v2")
		var err error
		runID, err = insertRun(tx, tenant, e, pe1)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	const repin = `UPDATE runs SET protocol_version_id = $2 WHERE id = $1`
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, repin, runID, pe2)
		return err
	})
	wantCode(t, "app role re-pins planned run", err, storage.CodeAppendOnly)
	_, err = db.Pool.Exec(ctx, repin, runID, pe2)
	wantCode(t, "owner re-pins planned run", err, storage.CodeAppendOnly)
	_, err = db.Pool.Exec(ctx, `UPDATE runs SET state = 'running' WHERE id = $1`, runID)
	wantCode(t, "owner starts run without touching the pin", err, "")
}

// insertPrincipal takes tenant, kind and handle; the subject is the handle.
const insertPrincipal = `INSERT INTO principals (tenant_id, kind, handle, issuer, subject)
	VALUES ($1, $2, $3, 'https://idp.test', $3) RETURNING id`

// SPEC-006-R04
func TestPrincipalHandlesUniqueAndImmutable(t *testing.T) {
	db := openTestDB(t)
	t1, t2 := newTenant(t, db), newTenant(t, db)
	ctx := context.Background()
	alice := newPrincipal(t, db, t1, "alice", "human").ID
	_, err := db.Pool.Exec(ctx, `INSERT INTO principals (tenant_id, kind, handle, issuer, subject)
		VALUES ($1, 'human', 'alice', 'https://idp.test', 'alice-2')`, t1)
	wantCode(t, "second alice in T1", err, "23505")
	newPrincipal(t, db, t2, "alice", "human") // fails the test if T2 rejects alice
	for _, stmt := range []string{
		`UPDATE principals SET handle = 'al' WHERE id = $1`,
		`UPDATE principals SET subject = 'x' WHERE id = $1`,
		`DELETE FROM principals WHERE id = $1`,
	} {
		_, err := db.Pool.Exec(ctx, stmt, alice)
		wantCode(t, stmt, err, storage.CodeAppendOnly)
	}
}

// SPEC-006-R05
func TestRoleGrantsAdminOnlyAndAudited(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	alice := newPrincipal(t, db, tenant, "alice", "human", "scientist")
	carol := newPrincipal(t, db, tenant, "carol", "human", "admin")

	err := db.WithTenant(ctx, tenant, alice, func(tx pgx.Tx) error {
		_, err := grantRole(ctx, tx, tenant, "alice", alice.ID, alice.ID, "reviewer", "self", true)
		return err
	})
	wantCode(t, "alice grants herself reviewer", err, storage.CodeRoleDenied)

	var grant string
	err = db.WithTenant(ctx, tenant, carol, func(tx pgx.Tx) (err error) {
		grant, err = grantRole(ctx, tx, tenant, "carol", alice.ID, alice.ID, "reviewer", "cover for bob", true)
		return err
	})
	wantCode(t, "carol grants alice reviewer", err, "")
	var grantedBy, action, reason string
	err = db.WithTenant(ctx, tenant, carol, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT g.granted_by::text, a.action, a.reason FROM role_grants g
			JOIN audit_events a ON a.entity_type = 'role_grant' AND a.entity_id = g.id::text
			WHERE g.id = $1`, grant).Scan(&grantedBy, &action, &reason)
	})
	if err != nil || grantedBy != carol.ID || action != "role.granted" || reason != "cover for bob" {
		t.Errorf("grant: granted_by %s (carol %s), event %q %q, err %v", grantedBy, carol.ID, action, reason, err)
	}

	err = db.WithTenant(ctx, tenant, carol, func(tx pgx.Tx) error {
		_, err := grantRole(ctx, tx, tenant, "carol", alice.ID, carol.ID, "qa", "no event", false)
		return err
	})
	wantCode(t, "grant with no audit event", err, storage.CodeAuditLink)
	err = db.WithTenant(ctx, tenant, carol, func(tx pgx.Tx) error {
		_, err := grantRole(ctx, tx, tenant, "carol", alice.ID, carol.ID, "qa", " ", true)
		return err
	})
	wantCode(t, "grant with blank reason", err, "23514")

	revoke := func() error {
		return db.WithTenant(ctx, tenant, carol, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `UPDATE role_grants SET revoked_by = $2, revoked_at = now(), revoke_reason = 'bob is back'
				WHERE id = $1`, grant, alice.ID); err != nil {
				return err
			}
			_, err := audit.Append(ctx, tx, tenant, audit.Entry{
				Actor: "carol", Action: "role.revoked", EntityType: "role_grant", EntityID: grant, Reason: "bob is back",
			})
			return err
		})
	}
	wantCode(t, "carol revokes", revoke(), "")
	var revokedBy string
	err = db.WithTenant(ctx, tenant, carol, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT revoked_by::text FROM role_grants WHERE id = $1`, grant).Scan(&revokedBy)
	})
	if err != nil || revokedBy != carol.ID {
		t.Errorf("revoked_by %s, want carol %s (err %v)", revokedBy, carol.ID, err)
	}
	wantCode(t, "carol revokes again", revoke(), storage.CodeAppendOnly)
	_, err = db.Pool.Exec(ctx, `DELETE FROM role_grants WHERE id = $1`, grant)
	wantCode(t, "owner deletes grant", err, storage.CodeAppendOnly)
}

// delegate inserts a delegation from human to agent, with its
// delegation.created event, as whoever tx acts as.
func delegate(ctx context.Context, tx pgx.Tx, tenant, actor, agentID, humanID, createdBy string) (string, error) {
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO agent_delegations (tenant_id, agent_id, human_id, reason, created_by)
		VALUES ($1, $2, $3, 'fixture', $4) RETURNING id`, tenant, agentID, humanID, createdBy).Scan(&id); err != nil {
		return "", err
	}
	_, err := audit.Append(ctx, tx, tenant, audit.Entry{
		Actor: actor, Action: "delegation.created", EntityType: "agent_delegation", EntityID: id, Reason: "fixture",
	})
	return id, err
}

// SPEC-006-R08
func TestAgentRolesIntersectHuman(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	alice := newPrincipal(t, db, tenant, "alice", "human", "scientist")
	carol := newPrincipal(t, db, tenant, "carol", "human", "admin")
	bot := newPrincipal(t, db, tenant, "bot", "agent", "scientist", "reviewer")
	forAlice := storage.Principal{ID: bot.ID, OnBehalfOf: alice.ID}

	holds := func(what string, as storage.Principal, role string, want bool) {
		t.Helper()
		var got bool
		err := db.WithTenant(ctx, tenant, as, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT lde_has_role($1)`, role).Scan(&got)
		})
		if err != nil || got != want {
			t.Errorf("%s holds %s = %v, want %v (err %v)", what, role, got, want, err)
		}
	}
	holds("bot for alice, no delegation", forAlice, "scientist", false)
	holds("bot for alice, no delegation", forAlice, "reviewer", false)

	var id string
	err := db.WithTenant(ctx, tenant, carol, func(tx pgx.Tx) (err error) {
		id, err = delegate(ctx, tx, tenant, "carol", bot.ID, alice.ID, carol.ID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	holds("bot for alice", forAlice, "scientist", true)
	holds("bot for alice", forAlice, "reviewer", false)
	holds("bot for carol", storage.Principal{ID: bot.ID, OnBehalfOf: carol.ID}, "scientist", false)
	holds("bot for nobody", storage.Principal{ID: bot.ID}, "scientist", false)

	err = db.WithTenant(ctx, tenant, carol, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE agent_delegations SET ended_by = $2, ended_at = now() WHERE id = $1`,
			id, carol.ID); err != nil {
			return err
		}
		_, err := audit.Append(ctx, tx, tenant, audit.Entry{
			Actor: "carol", Action: "delegation.ended", EntityType: "agent_delegation", EntityID: id,
		})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	holds("bot for alice, delegation ended", forAlice, "scientist", false)

	err = db.WithTenant(ctx, tenant, alice, func(tx pgx.Tx) error {
		_, err := delegate(ctx, tx, tenant, "alice", bot.ID, alice.ID, alice.ID)
		return err
	})
	wantCode(t, "alice delegates", err, storage.CodeRoleDenied)
	err = db.WithTenant(ctx, tenant, carol, func(tx pgx.Tx) error {
		_, err := delegate(ctx, tx, tenant, "carol", carol.ID, alice.ID, carol.ID)
		return err
	})
	wantCode(t, "delegation to a human", err, "23514")
}

// SPEC-006-R06, SPEC-006-R08
func TestRoleGatesOnLabRecords(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	alice := newPrincipal(t, db, tenant, "alice", "human", "scientist")
	bob := newPrincipal(t, db, tenant, "bob", "human", "reviewer")
	carol := newPrincipal(t, db, tenant, "carol", "human", "admin")
	bot := newPrincipal(t, db, tenant, "bot", "agent", "scientist", "reviewer")

	// Alice, a scientist, records an experiment with two completed runs.
	var run1, run2 string
	err := db.WithTenant(ctx, tenant, alice, func(tx pgx.Tx) error {
		exp := newExperiment(t, tx, tenant, "gates")
		pv, _ := newProtocolVersion(t, tx, tenant, exp, 1, "# p\n")
		var err error
		if run1, err = insertRun(tx, tenant, exp, pv); err != nil {
			return err
		}
		if run2, err = insertRun(tx, tenant, exp, pv); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE runs SET state = 'completed'`)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	sign := func(as storage.Principal, run string) error {
		return db.WithTenant(ctx, tenant, as, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE runs SET state = 'signed' WHERE id = $1`, run)
			return err
		})
	}
	addNode := func(as storage.Principal) error {
		return db.WithTenant(ctx, tenant, as, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, insertNode, tenant, "sample")
			return err
		})
	}
	// SPEC-008-R08: setting signed is no longer a role question; signing does it.
	wantCode(t, "alice (scientist) signs", sign(alice, run1), storage.CodeSignature)
	wantCode(t, "bob (reviewer) signs", sign(bob, run1), storage.CodeSignature)
	wantCode(t, "bob (reviewer) creates a node", addNode(bob), storage.CodeRoleDenied)
	wantCode(t, "nobody creates a node", addNode(storage.Principal{}), storage.CodeRoleDenied)

	err = db.WithTenant(ctx, tenant, carol, func(tx pgx.Tx) error {
		_, err := delegate(ctx, tx, tenant, "carol", bot.ID, alice.ID, carol.ID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	botForAlice := storage.Principal{ID: bot.ID, OnBehalfOf: alice.ID}
	wantCode(t, "bot for alice creates a node", addNode(botForAlice), "")
	wantCode(t, "bot for alice signs", sign(botForAlice, run2), storage.CodeSignature)
}

// SPEC-006-R06: signing is the only change a reviewer may make.
func TestSigningChangesNothingElse(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	bob := newPrincipal(t, db, tenant, "bob", "human", "reviewer")

	runs := make([]string, 3)
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		exp := newExperiment(t, tx, tenant, "sign-only")
		pv, _ := newProtocolVersion(t, tx, tenant, exp, 1, "# p\n")
		for i := range runs {
			var err error
			if runs[i], err = insertRun(tx, tenant, exp, pv); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `UPDATE runs SET state = 'completed'`)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	exec := func(as storage.Principal, stmt, run string) error {
		return db.WithTenant(ctx, tenant, as, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, stmt, run)
			return err
		})
	}
	const signAndEdit = `UPDATE runs SET state = 'signed', params = '{"tampered": true}' WHERE id = $1`
	const signOnly = `UPDATE runs SET state = 'signed', started_at = started_at, finished_at = finished_at WHERE id = $1`
	// SPEC-008-R08: the signatures table is the only way to `signed`, so every
	// principal is refused, whatever else the statement changes.
	wantCode(t, "bob (reviewer) signs and edits params", exec(bob, signAndEdit, runs[0]), storage.CodeSignature)
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		if _, err := commitChangeSet(ctx, tx, tenant, "it@lab", "correct params at sign-off"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, signAndEdit, runs[1])
		return err
	})
	wantCode(t, "it@lab (scientist and reviewer) signs and edits params", err, storage.CodeSignature)
	wantCode(t, "bob (reviewer) signs, rewriting unchanged columns", exec(bob, signOnly, runs[2]), storage.CodeSignature)
}

// commitChangeSet takes tenant, author and reason. It inserts a change set
// that is committed in tx, then names it as the transaction's change set.
func commitChangeSet(ctx context.Context, tx pgx.Tx, tenant, author, reason string) (string, error) {
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items, decision_reason)
		VALUES ($1, 'edit', $2, $3, 'committed', '[]', $2) RETURNING id`, tenant, reason, author).Scan(&id); err != nil {
		return "", err
	}
	_, err := tx.Exec(ctx, `SELECT set_config('app.change_set_id', $1, true)`, id)
	return id, err
}

// proposeChangeSet takes tenant and author. It inserts a proposed change set.
func proposeChangeSet(ctx context.Context, tx pgx.Tx, tenant, author string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items)
		VALUES ($1, 'proposal', 'fixture', $2, 'proposed', '[]') RETURNING id`, tenant, author).Scan(&id)
	return id, err
}

// SPEC-007-R06
func TestAgentsCannotDecideChangeSets(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	alice := newPrincipal(t, db, tenant, "alice", "human", "scientist")
	bot := newPrincipal(t, db, tenant, "bot", "agent", "scientist", "reviewer")
	svc := newPrincipal(t, db, tenant, "svc", "service", "scientist")
	botForAlice := storage.Principal{ID: bot.ID, OnBehalfOf: alice.ID}
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		_, err := delegate(ctx, tx, tenant, "it@lab", bot.ID, alice.ID, as(tenant).ID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	// update sets a change set's state and decision reason as p.
	update := func(p storage.Principal, id, state string) error {
		return db.WithTenant(ctx, tenant, p, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE change_sets SET state = $2, decision_reason = 'ok' WHERE id = $1`, id, state)
			return err
		})
	}

	var cs1, cs2 string
	err = db.WithTenant(ctx, tenant, botForAlice, func(tx pgx.Tx) (err error) {
		cs1, err = proposeChangeSet(ctx, tx, tenant, "alice via bot")
		return err
	})
	wantCode(t, "bot for alice proposes", err, "")
	wantCode(t, "bot for alice commits its proposal", update(botForAlice, cs1, "committed"), "LDE05")
	wantCode(t, "bot for alice rejects its proposal", update(botForAlice, cs1, "rejected"), "LDE05")
	err = db.WithTenant(ctx, tenant, botForAlice, func(tx pgx.Tx) error {
		_, err := commitChangeSet(ctx, tx, tenant, "alice via bot", "direct edit")
		return err
	})
	wantCode(t, "bot for alice inserts a committed change set", err, "LDE05")

	err = db.WithTenant(ctx, tenant, svc, func(tx pgx.Tx) (err error) {
		cs2, err = proposeChangeSet(ctx, tx, tenant, "svc")
		return err
	})
	wantCode(t, "service proposes", err, "")
	wantCode(t, "service commits", update(svc, cs2, "committed"), "LDE05")

	wantCode(t, "alice commits her proposal", update(alice, cs1, "committed"), "")
}

// SPEC-007-R01
func TestRevisionsKeepPriorValues(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	var s string
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `INSERT INTO lineage_nodes (tenant_id, kind, label, attrs, created_by)
			VALUES ($1, 'sample', 'Plasma 042', '{"volume_ul": 50}', 'alice') RETURNING id`, tenant).Scan(&s)
	})
	if err != nil {
		t.Fatal(err)
	}
	var cs string
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) (err error) {
		if cs, err = commitChangeSet(ctx, tx, tenant, "alice", "pipetting error"); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE lineage_nodes SET attrs = '{"volume_ul": 45}' WHERE id = $1`, s)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		if _, err := commitChangeSet(ctx, tx, tenant, "alice", "no-op"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE lineage_nodes SET label = label WHERE id = $1`, s)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	type revision struct {
		rev            int
		value          []byte
		author, reason string
		csID           string
	}
	var got []revision
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT rev, value, author, reason, COALESCE(change_set_id::text, '')
			FROM record_revisions WHERE entity_type = 'lineage_node' AND entity_id = $1 ORDER BY rev`, s)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r revision
			if err := rows.Scan(&r.rev, &r.value, &r.author, &r.reason, &r.csID); err != nil {
				return err
			}
			got = append(got, r)
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []revision{
		{1, []byte(`{"label": "Plasma 042", "attrs": {"volume_ul": 50}}`), "alice", "created", ""},
		{2, []byte(`{"label": "Plasma 042", "attrs": {"volume_ul": 45}}`), "alice", "pipetting error", cs},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d revisions, want %d", len(got), len(want))
	}
	for i := range want {
		var gv, wv map[string]any
		if err := json.Unmarshal(got[i].value, &gv); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(want[i].value, &wv); err != nil {
			t.Fatal(err)
		}
		if got[i].rev != want[i].rev || !reflect.DeepEqual(gv, wv) || got[i].author != want[i].author ||
			got[i].reason != want[i].reason || got[i].csID != want[i].csID {
			t.Errorf("revision %d: got %+v (value %v), want %+v", i+1, got[i], gv, want[i])
		}
	}

	var attrs []byte
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT attrs FROM lineage_nodes WHERE id = $1`, s).Scan(&attrs)
	})
	var current map[string]any
	if err == nil {
		err = json.Unmarshal(attrs, &current)
	}
	if err != nil || !reflect.DeepEqual(current, map[string]any{"volume_ul": float64(45)}) {
		t.Errorf("current attrs = %v (err %v), want volume_ul 45", current, err)
	}
}

// SPEC-007-R02
func TestRevisableFieldsNeedChangeSet(t *testing.T) {
	db := openTestDB(t)
	f := newSealFixture(t, db, "completed")
	ctx := context.Background()
	var exp string
	if err := db.Pool.QueryRow(ctx, `SELECT experiment_id FROM runs WHERE id = $1`, f.runID).Scan(&exp); err != nil {
		t.Fatal(err)
	}
	// inTx runs fn as the fixture's tenant, in its own transaction.
	inTx := func(fn func(tx pgx.Tx) error) error {
		return db.WithTenant(ctx, f.tenant, as(f.tenant), fn)
	}
	// exec runs one statement in its own transaction.
	exec := func(stmt string, args ...any) error {
		return inTx(func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, stmt, args...)
			return err
		})
	}
	// The sample's attrs default to '{}', so the edit must change them.
	const editNode = `UPDATE lineage_nodes SET attrs = '{"x": 1}' WHERE id = $1`

	wantCode(t, "no change set: node attrs", exec(editNode, f.s), storage.CodeAppendOnly)
	wantCode(t, "no change set: run params", exec(`UPDATE runs SET params = '{"x": 1}' WHERE id = $1`, f.runID), storage.CodeAppendOnly)
	wantCode(t, "no change set: experiment title", exec(`UPDATE experiments SET title = 'x' WHERE id = $1`, exp), storage.CodeAppendOnly)

	err := inTx(func(tx pgx.Tx) error {
		id, err := proposeChangeSet(ctx, tx, f.tenant, "it@lab")
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.change_set_id', $1, true)`, id); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, editNode, f.s)
		return err
	})
	wantCode(t, "proposed change set", err, storage.CodeAppendOnly)

	var cs string
	err = inTx(func(tx pgx.Tx) (err error) {
		cs, err = commitChangeSet(ctx, tx, f.tenant, "it@lab", "committed earlier")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = inTx(func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.change_set_id', $1, true)`, cs); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, editNode, f.s)
		return err
	})
	wantCode(t, "change set committed in an earlier transaction", err, storage.CodeAppendOnly)

	err = inTx(func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items, decision_reason)
			VALUES ($1, 'blank', '  ', 'it@lab', 'committed', '[]', 'ok')`, f.tenant)
		return err
	})
	wantCode(t, "committed change set with a blank reason", err, "23514")

	wantCode(t, "state is not revisable", exec(`UPDATE runs SET state = 'running' WHERE id = $1`, f.runID), "")

	err = inTx(func(tx pgx.Tx) error {
		if _, err := commitChangeSet(ctx, tx, f.tenant, "it@lab", "pipetting"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, editNode, f.s)
		return err
	})
	wantCode(t, "inside a committing change set", err, "")

	// A TEMP table named change_sets must not stand in for the real one.
	countRevs := func() (n int) {
		err := inTx(func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM public.record_revisions WHERE entity_id = $1`, f.s).Scan(&n)
		})
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := countRevs()
	err = inTx(func(tx pgx.Tx) error {
		if err := shadowTable(ctx, tx, "change_sets", `(LIKE public.change_sets INCLUDING DEFAULTS)`); err != nil {
			return err
		}
		if err := shadowTable(ctx, tx, "record_revisions", `(LIKE public.record_revisions)`); err != nil {
			return err
		}
		var forged string
		err := tx.QueryRow(ctx, `INSERT INTO pg_temp.change_sets (id, tenant_id, title, reason, author, state, items, decision_reason)
			VALUES (gen_random_uuid(), $1, 'forged', 'forged', 'it@lab', 'committed', '[]', 'ok') RETURNING id`, f.tenant).Scan(&forged)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.change_set_id', $1, true)`, forged); err != nil {
			return err
		}
		// The committing case above already set {"x": 1}; edit to a new value.
		_, err = tx.Exec(ctx, `UPDATE lineage_nodes SET attrs = '{"x": 2}' WHERE id = $1`, f.s)
		return err
	})
	wantCode(t, "forged change set in a temp table", err, storage.CodeAppendOnly)
	if after := countRevs(); after != before {
		t.Errorf("revisions of node: %d before, %d after the forged edit", before, after)
	}

	// TEMP tables named runs and lineage_edges must not switch off the
	// sealed-params check (SPEC-007-R10).
	sf := newSealFixture(t, db, "signed")
	err = db.WithTenant(ctx, sf.tenant, as(sf.tenant), func(tx pgx.Tx) error {
		if err := shadowTable(ctx, tx, "runs", `(tenant_id uuid, node_id uuid, state text)`); err != nil {
			return err
		}
		if err := shadowTable(ctx, tx, "lineage_edges", `(tenant_id uuid, from_id uuid, to_id uuid, relation text)`); err != nil {
			return err
		}
		if _, err := commitChangeSet(ctx, tx, sf.tenant, "it@lab", "shadowed params"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE public.runs SET params = '{"x": 1}' WHERE id = $1`, sf.runID)
		return err
	})
	wantCode(t, "sealed run params with shadow tables", err, storage.CodeSealed)
}

// shadowTable creates a TEMP table in tx that hides a real one, for proving
// that pinned functions ignore it. lde_app may not create TEMP tables (0014),
// so the owner creates this one and hands it over.
func shadowTable(ctx context.Context, tx pgx.Tx, name, def string) error {
	for _, stmt := range []string{
		`RESET ROLE`,
		`CREATE TEMP TABLE ` + name + ` ` + def + ` ON COMMIT DROP`,
		`GRANT ALL ON pg_temp.` + name + ` TO ` + storage.AppRole,
		`SET LOCAL ROLE ` + storage.AppRole,
	} {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// SPEC-007-R02, SPEC-007-R06: unpinned triggers and role checks resolve table
// names through search_path, so a TEMP table could stand in for a real one.
func TestAppRoleCannotCreateTempTables(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `CREATE TEMP TABLE runs (LIKE public.runs) ON COMMIT DROP`)
		return err
	})
	wantCode(t, "lde_app creates a TEMP table", err, "42501")
}

// SPEC-007-R03
func TestRevisionsAreAppendOnly(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	ctx := context.Background()
	var node string
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, insertNode, tenant, "sample").Scan(&node)
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = db.Pool.Exec(ctx, `UPDATE record_revisions SET reason = 'x' WHERE tenant_id = $1`, tenant)
	wantCode(t, "owner updates a revision", err, storage.CodeAppendOnly)
	_, err = db.Pool.Exec(ctx, `DELETE FROM record_revisions WHERE tenant_id = $1`, tenant)
	wantCode(t, "owner deletes a revision", err, storage.CodeAppendOnly)
	_, err = db.Pool.Exec(ctx, `TRUNCATE record_revisions`)
	wantCode(t, "owner truncates revisions", err, storage.CodeAppendOnly)

	for _, stmt := range []string{
		`UPDATE record_revisions SET reason = 'x'`,
		`DELETE FROM record_revisions`,
		`TRUNCATE record_revisions`,
	} {
		err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error { _, err := tx.Exec(ctx, stmt); return err })
		wantCode(t, "app role: "+stmt, err, "42501")
	}

	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO record_revisions (tenant_id, entity_type, entity_id, rev, value, author, reason)
			VALUES ($1, 'lineage_node', $2, 9, '{}', 'x', 'x')`, tenant, node)
		return err
	})
	wantCode(t, "app role inserts a revision", err, "42501")
}

// SPEC-007-R13
func TestNotesOnSealedNodes(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	f := newSealFixture(t, db, "completed")
	const insertNote = `INSERT INTO notes (tenant_id, node_id, body, created_by)
		VALUES ($1, $2, $3, 'alice') RETURNING id, annotation`

	var n1, n2 string
	var annotation bool
	err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, insertNote, f.tenant, f.r, "Thawed at 09:00").Scan(&n1, &annotation)
	})
	if err != nil {
		t.Fatal(err)
	}
	if annotation {
		t.Error("note before signing: want annotation = false")
	}

	if _, err := db.Pool.Exec(ctx, `UPDATE runs SET state = 'signed' WHERE id = $1`, f.runID); err != nil {
		t.Fatal(err)
	}

	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, insertNote, f.tenant, f.r, "Freezer alarm at 02:10, samples unaffected").Scan(&n2, &annotation)
	})
	if err != nil {
		t.Fatal(err)
	}
	if !annotation {
		t.Error("note on signed run: want annotation = true")
	}
	var sealed bool
	if err := db.Pool.QueryRow(ctx, `SELECT lineage_node_sealed($1)`, f.r).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if !sealed {
		t.Error("annotation broke the seal: want lineage_node_sealed = true")
	}

	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		if _, err := commitChangeSet(ctx, tx, f.tenant, "it@lab", "correct thaw time"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE notes SET body = 'Thawed at 09:15' WHERE id = $1`, n1)
		return err
	})
	wantCode(t, "edit note written before signing", err, storage.CodeSealed)

	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		if _, err := commitChangeSet(ctx, tx, f.tenant, "it@lab", "annotate sample check"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE notes SET body = 'Freezer alarm at 02:10; checked, samples unaffected' WHERE id = $1`, n2)
		return err
	})
	wantCode(t, "edit annotation", err, "")

	_, err = db.Pool.Exec(ctx, `UPDATE notes SET annotation = true WHERE id = $1`, n1)
	wantCode(t, "owner sets annotation on a sealed-era note", err, storage.CodeAppendOnly)

	// TEMP tables named runs and lineage_edges must not shadow the real ones.
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		if err := shadowTable(ctx, tx, "runs", `(tenant_id uuid, node_id uuid, state text)`); err != nil {
			return err
		}
		if err := shadowTable(ctx, tx, "lineage_edges", `(tenant_id uuid, from_id uuid, to_id uuid, relation text)`); err != nil {
			return err
		}
		var shadowed bool
		if err := tx.QueryRow(ctx, insertNote, f.tenant, f.r, "Shadowed insert").Scan(new(string), &shadowed); err != nil {
			return err
		}
		if !shadowed {
			t.Error("note on signed run with shadow tables: want annotation = true")
		}
		if _, err := commitChangeSet(ctx, tx, f.tenant, "it@lab", "shadowed edit"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE notes SET body = 'Thawed at 09:30' WHERE id = $1`, n1)
		return err
	})
	wantCode(t, "edit frozen note with shadow tables", err, storage.CodeSealed)
}

// renamePrincipal sets a principal's display name as the owner, with its
// principal.renamed event.
func renamePrincipal(t *testing.T, db *storage.DB, tenant, id, name string) {
	t.Helper()
	ctx := context.Background()
	err := db.WithOwner(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE principals SET display_name = $2 WHERE id = $1`, id, name); err != nil {
			return err
		}
		_, err := audit.Append(ctx, tx, tenant, audit.Entry{
			Actor: "system:test", Action: "principal.renamed", EntityType: "principal", EntityID: id,
			Reason: "fixture", Payload: map[string]any{"to": name},
		})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

// newSigner is newPrincipal with a display name.
func newSigner(t *testing.T, db *storage.DB, tenant, handle, displayName, kind string, roles ...string) storage.Principal {
	t.Helper()
	p := newPrincipal(t, db, tenant, handle, kind, roles...)
	renamePrincipal(t, db, tenant, p.ID, displayName)
	return p
}

// insertSignature inserts a manifest for manifestRunID with the given text,
// then a signature on runID bound to it (its hash, last byte flipped when
// flipHash), and appends signature.applied in tx. The signer is tx's principal.
func insertSignature(ctx context.Context, tx pgx.Tx, tenant, runID, manifestRunID, manifestText string, flipHash bool, actor string, step int, meaning string) (string, error) {
	var manifestID string
	var sum []byte
	if err := tx.QueryRow(ctx, `INSERT INTO signature_manifests (tenant_id, run_id, manifest)
		VALUES ($1, $2, $3) RETURNING id, sha256`, tenant, manifestRunID, manifestText).Scan(&manifestID, &sum); err != nil {
		return "", err
	}
	hexSum := fmt.Sprintf("%x", sum)
	if flipHash {
		sum[len(sum)-1] ^= 1
	}
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO signatures (tenant_id, entity_type, entity_id, step, meaning, signer_id,
			printed_name, manifest_id, manifest_sha256, reauth_at, reauth_method)
		VALUES ($1, 'run', $2, $3, $4, lde_current_principal(), 'x', $5, $6, now(), 'dev') RETURNING id`,
		tenant, runID, step, meaning, manifestID, sum).Scan(&id); err != nil {
		return "", err
	}
	_, err := audit.Append(ctx, tx, tenant, audit.Entry{
		Actor: actor, Action: "signature.applied", EntityType: "signature", EntityID: id, Reason: meaning,
		Payload: map[string]any{"manifest_sha256": hexSum},
	})
	return id, err
}

// applySignature signs runID's step as tx's principal, with a correct manifest.
func applySignature(ctx context.Context, tx pgx.Tx, tenant, runID, actor string, step int, meaning string) (string, error) {
	return insertSignature(ctx, tx, tenant, runID, runID, fmt.Sprintf(`{"run_id":%q}`, runID), false, actor, step, meaning)
}

// trySign runs applySignature in its own transaction as p.
func trySign(db *storage.DB, tenant string, p storage.Principal, runID string, step int, meaning string) (id string, err error) {
	ctx := context.Background()
	err = db.WithTenant(ctx, tenant, p, func(tx pgx.Tx) (err error) {
		id, err = applySignature(ctx, tx, tenant, runID, "signer", step, meaning)
		return err
	})
	return id, err
}

// signFixture is newSealFixture in a state, with its signers: alice
// (scientist), bob (reviewer), dana (both) and bot, an agent with both roles
// and a delegation from dana.
type signFixture struct {
	sealFixture
	alice, bob, dana, bot storage.Principal
}

func newSignFixture(t *testing.T, db *storage.DB, state string) signFixture {
	t.Helper()
	f := signFixture{sealFixture: newSealFixture(t, db, state)}
	f.alice = newSigner(t, db, f.tenant, "alice", "Alice Ng", "human", "scientist")
	f.bob = newSigner(t, db, f.tenant, "bob", "Bob Ortiz", "human", "reviewer")
	f.dana = newSigner(t, db, f.tenant, "dana", "Dana Ito", "human", "scientist", "reviewer")
	f.bot = newSigner(t, db, f.tenant, "bot", "Bot", "agent", "scientist", "reviewer")
	err := db.WithTenant(context.Background(), f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		_, err := delegate(context.Background(), tx, f.tenant, "it@lab", f.bot.ID, f.dana.ID, as(f.tenant).ID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// SPEC-008-R03
func TestSignatureManifestBinding(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	f := newSignFixture(t, db, "completed")
	var other string
	err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		exp := newExperiment(t, tx, f.tenant, "other")
		pv, _ := newProtocolVersion(t, tx, f.tenant, exp, 1, "# p\n")
		var err error
		other, err = insertRun(tx, f.tenant, exp, pv)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	own := fmt.Sprintf(`{"run_id":%q}`, f.runID)
	for _, tc := range []struct {
		name        string
		manifestRun string
		text        string
		flip        bool
		want        string
	}{
		{"hash with last byte flipped", f.runID, own, true, "LDE07"},
		{"manifest row of another run", other, fmt.Sprintf(`{"run_id":%q}`, other), false, "LDE07"},
		{"manifest text naming another run", f.runID, fmt.Sprintf(`{"run_id":%q}`, other), false, "LDE07"},
		{"correct manifest and hash", f.runID, own, false, ""},
	} {
		err := db.WithTenant(ctx, f.tenant, f.alice, func(tx pgx.Tx) error {
			_, err := insertSignature(ctx, tx, f.tenant, f.runID, tc.manifestRun, tc.text, tc.flip, "alice", 1, "author")
			return err
		})
		wantCode(t, tc.name, err, tc.want)
	}
}

// SPEC-008-R05
func TestSignaturePolicyOrder(t *testing.T) {
	db := openTestDB(t)
	f := newSignFixture(t, db, "completed")
	_, err := trySign(db, f.tenant, f.bob, f.runID, 2, "review")
	wantCode(t, "bob signs step 2 with nothing signed", err, "LDE07")
	_, err = trySign(db, f.tenant, f.alice, f.runID, 2, "review")
	wantCode(t, "alice signs step 2", err, "LDE07")
	_, err = trySign(db, f.tenant, f.alice, f.runID, 1, "review")
	wantCode(t, "alice signs step 1 as review", err, "LDE07")
	_, err = trySign(db, f.tenant, f.bob, f.runID, 1, "author")
	wantCode(t, "bob (no scientist) signs step 1", err, "LDE07")

	running := newSignFixture(t, db, "running")
	_, err = trySign(db, running.tenant, running.alice, running.runID, 1, "author")
	wantCode(t, "alice signs a running run", err, "LDE07")
	failed := newSignFixture(t, db, "failed")
	_, err = trySign(db, failed.tenant, failed.alice, failed.runID, 1, "author")
	wantCode(t, "alice signs a failed run", err, "")

	_, err = trySign(db, f.tenant, f.alice, f.runID, 1, "author")
	wantCode(t, "alice signs step 1", err, "")
	_, err = trySign(db, f.tenant, f.bob, f.runID, 2, "review")
	wantCode(t, "bob signs step 2", err, "")
}

// SPEC-008-R06
func TestSignatureFourEyes(t *testing.T) {
	db := openTestDB(t)
	f := newSignFixture(t, db, "completed")
	_, err := trySign(db, f.tenant, f.dana, f.runID, 1, "author")
	wantCode(t, "dana signs step 1", err, "")
	_, err = trySign(db, f.tenant, f.dana, f.runID, 2, "review")
	wantCode(t, "dana signs step 2", err, "LDE07")
	_, err = trySign(db, f.tenant, f.bob, f.runID, 2, "review")
	wantCode(t, "bob signs step 2", err, "")
}

// SPEC-008-R07
func TestAgentsAndServicesCannotSign(t *testing.T) {
	db := openTestDB(t)
	f := newSignFixture(t, db, "completed")
	svc := newSigner(t, db, f.tenant, "svc", "Svc", "service", "scientist")
	_, err := trySign(db, f.tenant, storage.Principal{ID: f.bot.ID, OnBehalfOf: f.dana.ID}, f.runID, 1, "author")
	wantCode(t, "bot for dana signs", err, "LDE07")
	_, err = trySign(db, f.tenant, svc, f.runID, 1, "author")
	wantCode(t, "service signs", err, "LDE07")
}

// SPEC-008-R16
func TestSignerNeedsPrintedName(t *testing.T) {
	db := openTestDB(t)
	f := newSignFixture(t, db, "completed")
	eve := newPrincipal(t, db, f.tenant, "eve", "human", "scientist")
	_, err := trySign(db, f.tenant, eve, f.runID, 1, "author")
	wantCode(t, "blank display name signs", err, "LDE07")
	// A name with nothing to print is blank, whatever the whitespace.
	for handle, name := range map[string]string{"tab": "\t", "nbsp": " ", "zwsp": "​", "ideographic": "　"} {
		var blank storage.Principal
		err = db.WithOwner(context.Background(), func(tx pgx.Tx) error {
			ctx := context.Background()
			if err := tx.QueryRow(ctx, `INSERT INTO principals (tenant_id, kind, handle, display_name, issuer, subject)
				VALUES ($1, 'human', $2, $3, 'https://idp.test', $2) RETURNING id`, f.tenant, handle, name).Scan(&blank.ID); err != nil {
				return err
			}
			if _, err := audit.Append(ctx, tx, f.tenant, audit.Entry{
				Actor: "system:test", Action: "principal.created", EntityType: "principal", EntityID: blank.ID,
			}); err != nil {
				return err
			}
			_, err := grantRole(ctx, tx, f.tenant, "system:test", blank.ID, blank.ID, "scientist", "fixture", true)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		_, err = trySign(db, f.tenant, blank, f.runID, 1, "author")
		wantCode(t, handle+" display name signs", err, "LDE07")
	}
	renamePrincipal(t, db, f.tenant, eve.ID, "Eve Okafor")
	id, err := trySign(db, f.tenant, eve, f.runID, 1, "author")
	wantCode(t, "named signer signs", err, "")
	var name string
	if err := db.Pool.QueryRow(context.Background(), `SELECT printed_name FROM signatures WHERE id = $1`, id).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Eve Okafor" {
		t.Errorf("printed_name = %q, want %q", name, "Eve Okafor")
	}

	// What the database stamps can't be chosen: alice naming dana as the signer,
	// with a forged name and time, still signs as herself, now.
	forged := newSignFixture(t, db, "completed")
	ctx := context.Background()
	err = db.WithTenant(ctx, forged.tenant, forged.alice, func(tx pgx.Tx) error {
		var manifestID string
		var sum []byte
		if err := tx.QueryRow(ctx, `INSERT INTO signature_manifests (tenant_id, run_id, manifest)
			VALUES ($1, $2, $3) RETURNING id, sha256`, forged.tenant, forged.runID, fmt.Sprintf(`{"run_id":%q}`, forged.runID)).Scan(&manifestID, &sum); err != nil {
			return err
		}
		var sig string
		if err := tx.QueryRow(ctx, `INSERT INTO signatures (tenant_id, entity_type, entity_id, step, meaning, signer_id,
				printed_name, signed_at, manifest_id, manifest_sha256, reauth_at, reauth_method)
			VALUES ($1, 'run', $2, 1, 'author', $3, 'Forged', '2000-01-01', $4, $5, now(), 'dev') RETURNING id`,
			forged.tenant, forged.runID, forged.dana.ID, manifestID, sum).Scan(&sig); err != nil {
			return err
		}
		_, err := audit.Append(ctx, tx, forged.tenant, audit.Entry{
			Actor: "alice", Action: "signature.applied", EntityType: "signature", EntityID: sig, Reason: "author",
		})
		return err
	})
	wantCode(t, "alice signs naming dana", err, "")
	var signer string
	var year int
	if err := db.Pool.QueryRow(ctx, `SELECT signer_id, printed_name, extract(year FROM signed_at)::int FROM signatures
		WHERE tenant_id = $1 AND entity_id = $2`, forged.tenant, forged.runID).Scan(&signer, &name, &year); err != nil {
		t.Fatal(err)
	}
	if signer != forged.alice.ID || name != "Alice Ng" || year == 2000 {
		t.Errorf("stamped signer %s, name %q, year %d; want alice (%s), Alice Ng, not 2000", signer, name, year, forged.alice.ID)
	}
}

// SPEC-008-R11
func TestSignaturesAreImmutable(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	f := newSignFixture(t, db, "completed")
	sig, err := trySign(db, f.tenant, f.alice, f.runID, 1, "author")
	if err != nil {
		t.Fatal(err)
	}

	scoped := fmt.Sprintf(`WHERE tenant_id = '%s'`, f.tenant)
	for _, s := range []string{
		`UPDATE signatures SET meaning = 'review' ` + scoped,
		`DELETE FROM signatures ` + scoped,
		`UPDATE signature_manifests SET manifest = 'x' ` + scoped,
		`DELETE FROM signature_manifests ` + scoped,
		`TRUNCATE signature_manifests, signatures`, // signatures references manifests, so a bare TRUNCATE hits 0A000 first
	} {
		err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, s)
			return err
		})
		wantCode(t, "lde_app: "+s, err, "42501")
		_, err = db.Pool.Exec(ctx, s)
		wantCode(t, "owner: "+s, err, "LDE03")
	}

	const invalidate = `UPDATE signatures SET invalidated_at = now(), invalidated_by_change_set = $2 WHERE id = $1`
	const commit = `UPDATE change_sets SET state = 'committed', decision_reason = 'ok' WHERE id = $1`
	propose := func(items string) string {
		t.Helper()
		var id string
		err := db.WithTenant(ctx, f.tenant, f.alice, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items)
				VALUES ($1, 'fix', 'transcription error', 'alice', 'proposed', $2::jsonb) RETURNING id`,
				f.tenant, items).Scan(&id)
		})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	touchesRun := fmt.Sprintf(`[{"op":"update_run_params","run_id":%q,"params":{}}]`, f.runID)

	// A change set that touches the run but was committed in an earlier
	// transaction does not count: this pins the xmin check.
	old := propose(touchesRun)
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, commit, old)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, invalidate, sig, old)
		return err
	})
	wantCode(t, "invalidate with a change set committed earlier", err, "LDE07")

	// One committed in this transaction that touches another record does not
	// count either: this pins the touched-runs check.
	elsewhere := propose(fmt.Sprintf(`[{"op":"update_node","node_id":%q,"label":"x"}]`, f.s))
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, commit, elsewhere); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, invalidate, sig, elsewhere)
		return err
	})
	wantCode(t, "invalidate with a change set that touches another record", err, "LDE07")

	cs := propose(touchesRun)
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, commit, cs); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, invalidate, sig, cs); err != nil {
			return err
		}
		_, err := audit.Append(ctx, tx, f.tenant, audit.Entry{
			Actor: "it@lab", Action: "signature.invalidated", EntityType: "signature", EntityID: sig,
			Reason: "transcription error",
		})
		return err
	})
	wantCode(t, "invalidate in a committed correction", err, "")

	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, invalidate, sig, cs)
		return err
	})
	wantCode(t, "invalidate twice", err, "LDE03")
}

// SPEC-008-R08
func TestFirstSignatureSeals(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	runRow := func(f signFixture) (state string, signedFrom *string) {
		t.Helper()
		if err := db.Pool.QueryRow(ctx, `SELECT state, signed_from FROM runs WHERE id = $1`, f.runID).Scan(&state, &signedFrom); err != nil {
			t.Fatal(err)
		}
		return state, signedFrom
	}

	f := newSignFixture(t, db, "completed")
	if _, err := trySign(db, f.tenant, f.alice, f.runID, 1, "author"); err != nil {
		t.Fatal(err)
	}
	err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, insertNode, f.tenant, "reagent").Scan(&id); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, insertEdge, f.tenant, id, f.r, "used")
		return err
	})
	wantCode(t, "new input to a run with one signature", err, storage.CodeSealed)
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		if _, err := commitChangeSet(ctx, tx, f.tenant, "it@lab", "edit sealed dataset"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE lineage_nodes SET attrs = '{"x":1}' WHERE id = $1`, f.d)
		return err
	})
	wantCode(t, "attrs update of a dataset of a run with one signature", err, storage.CodeSealed)
	var annotation bool
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `INSERT INTO notes (tenant_id, node_id, body, created_by)
			VALUES ($1, $2, 'looks fine', 'it@lab') RETURNING annotation`, f.tenant, f.r).Scan(&annotation)
	})
	wantCode(t, "annotation on a run with one signature", err, "")
	if !annotation {
		t.Error("note after the first signature: want annotation = true")
	}
	if state, from := runRow(f); state != "completed" || from != nil {
		t.Errorf("after step 1: state %q, signed_from %v; want completed, nil", state, from)
	}

	// The seal can't be lifted by moving the run row out from under it.
	var decoy string
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, insertNode, f.tenant, "run").Scan(&decoy)
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []struct{ name, stmt string }{
		{"back to running", `UPDATE runs SET state = 'running' WHERE id = $1`},
		{"completed to failed", `UPDATE runs SET state = 'failed' WHERE id = $1`},
		{"abort", `UPDATE runs SET state = 'aborted' WHERE id = $1`},
		{"rewrite finished_at", `UPDATE runs SET finished_at = now() WHERE id = $1`},
		{"rewrite created_by", `UPDATE runs SET created_by = 'forged' WHERE id = $1`},
	} {
		err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, s.stmt, f.runID)
			return err
		})
		wantCode(t, s.name+" with one signature", err, storage.CodeSealed)
	}
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE runs SET node_id = $2 WHERE id = $1`, f.runID, decoy)
		return err
	})
	wantCode(t, "repoint node_id with one signature", err, storage.CodeAppendOnly)
	aborted := newSealFixture(t, db, "aborted")
	err = db.WithTenant(ctx, aborted.tenant, as(aborted.tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE runs SET state = 'completed' WHERE id = $1`, aborted.runID)
		return err
	})
	wantCode(t, "lde_app reopens an aborted run", err, storage.CodeSealed)

	// SPEC-008-R10: invalidating one of two signatures fails at commit.
	partial := newSignFixture(t, db, "completed")
	step1, err := trySign(db, partial.tenant, partial.alice, partial.runID, 1, "author")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := trySign(db, partial.tenant, partial.bob, partial.runID, 2, "review"); err != nil {
		t.Fatal(err)
	}
	var fix string
	err = db.WithTenant(ctx, partial.tenant, partial.alice, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items)
			VALUES ($1, 'fix', 'typo', 'alice', 'proposed', $2::jsonb) RETURNING id`,
			partial.tenant, fmt.Sprintf(`[{"op":"update_run_params","run_id":%q,"params":{}}]`, partial.runID)).Scan(&fix)
	})
	if err != nil {
		t.Fatal(err)
	}
	err = db.WithTenant(ctx, partial.tenant, as(partial.tenant), func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE change_sets SET state = 'committed', decision_reason = 'ok' WHERE id = $1`, fix); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE signatures SET invalidated_at = now(), invalidated_by_change_set = $2 WHERE id = $1`, step1, fix); err != nil {
			return err
		}
		_, err := audit.Append(ctx, tx, partial.tenant, audit.Entry{
			Actor: "it@lab", Action: "signature.invalidated", EntityType: "signature", EntityID: step1, Reason: "typo",
		})
		return err
	})
	wantCode(t, "invalidating one of two signatures", err, "LDE07")

	if _, err := trySign(db, f.tenant, f.bob, f.runID, 2, "review"); err != nil {
		t.Fatal(err)
	}
	if state, from := runRow(f); state != "signed" || from == nil || *from != "completed" {
		t.Errorf("after step 2: state %q, signed_from %v; want signed, completed", state, from)
	}

	failed := newSignFixture(t, db, "failed")
	for _, s := range []struct {
		p       storage.Principal
		step    int
		meaning string
	}{{failed.alice, 1, "author"}, {failed.bob, 2, "review"}} {
		if _, err := trySign(db, failed.tenant, s.p, failed.runID, s.step, s.meaning); err != nil {
			t.Fatal(err)
		}
	}
	if state, from := runRow(failed); state != "signed" || from == nil || *from != "failed" {
		t.Errorf("failed run after both signatures: state %q, signed_from %v; want signed, failed", state, from)
	}

	// No statement by lde_app sets signed directly.
	fresh := newSignFixture(t, db, "completed")
	for _, p := range []storage.Principal{fresh.alice, fresh.bob} {
		err := db.WithTenant(ctx, fresh.tenant, p, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE runs SET state = 'signed' WHERE id = $1`, fresh.runID)
			return err
		})
		wantCode(t, "UPDATE state = signed as "+p.ID, err, "LDE07")
	}
	err = db.WithTenant(ctx, fresh.tenant, as(fresh.tenant), func(tx pgx.Tx) error {
		var exp, pv string
		if err := tx.QueryRow(ctx, `SELECT experiment_id, protocol_version_id FROM runs WHERE id = $1`, fresh.runID).Scan(&exp, &pv); err != nil {
			return err
		}
		var node string
		if err := tx.QueryRow(ctx, insertNode, fresh.tenant, "run").Scan(&node); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO runs (tenant_id, experiment_id, node_id, protocol_version_id, state, created_by)
			VALUES ($1, $2, $3, $4, 'signed', 'it@lab')`, fresh.tenant, exp, node, pv)
		return err
	})
	wantCode(t, "INSERT a run in state signed", err, "LDE07")

	// A signed run does not leave signed without an invalidation.
	const reopen = `UPDATE runs SET state = 'completed' WHERE id = $1`
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, reopen, f.runID)
		return err
	})
	wantCode(t, "lde_app reopens a signed run", err, "LDE03")
	_, err = db.Pool.Exec(ctx, reopen, f.runID)
	wantCode(t, "owner reopens a signed run", err, "LDE03")
}

// SPEC-008-R09
func TestCorrectionCommitRoles(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	f := newSignFixture(t, db, "completed")
	carol := newSigner(t, db, f.tenant, "carol", "Carol Wu", "human", "scientist")
	for _, s := range []struct {
		p       storage.Principal
		step    int
		meaning string
	}{{f.alice, 1, "author"}, {f.bob, 2, "review"}} {
		if _, err := trySign(db, f.tenant, s.p, f.runID, s.step, s.meaning); err != nil {
			t.Fatal(err)
		}
	}

	touchesRun := fmt.Sprintf(`[{"op":"update_run_params","run_id":%q,"params":{"x":1}}]`, f.runID)
	propose := func(p storage.Principal, author, items string) string {
		t.Helper()
		var id string
		err := db.WithTenant(ctx, f.tenant, p, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items)
				VALUES ($1, 'fix', 'transcription error', $2, 'proposed', $3::jsonb) RETURNING id`,
				f.tenant, author, items).Scan(&id)
		})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	const commit = `UPDATE change_sets SET state = 'committed', decision_reason = 'ok' WHERE id = $1`
	commitAs := func(p storage.Principal, id string) error {
		return db.WithTenant(ctx, f.tenant, p, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, commit, id)
			return err
		})
	}
	state := func(id string) string {
		t.Helper()
		var s string
		if err := db.Pool.QueryRow(ctx, `SELECT state FROM change_sets WHERE id = $1`, id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}

	mine := propose(f.alice, "alice", touchesRun)
	wantCode(t, "alice commits her own correction", commitAs(f.alice, mine), "LDE07")
	wantCode(t, "another scientist commits", commitAs(carol, mine), "LDE07")

	viaBot := propose(storage.Principal{ID: f.bot.ID, OnBehalfOf: f.dana.ID}, "bot", touchesRun)
	wantCode(t, "dana commits what her bot proposed", commitAs(f.dana, viaBot), "LDE07")

	err := db.WithTenant(ctx, f.tenant, f.dana, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items, decision_reason)
			VALUES ($1, 'fix', 'direct', 'dana', 'committed', $2::jsonb, 'direct')`, f.tenant, touchesRun)
		return err
	})
	wantCode(t, "scientist and reviewer inserts a committed correction", err, "LDE07")
	if s, v := state(mine), state(viaBot); s != "proposed" || v != "proposed" {
		t.Fatalf("after the failures: states %q and %q, want proposed", s, v)
	}

	// Bob is a reviewer but not a scientist: committing, invalidating and
	// applying the change are his to do.
	err = db.WithTenant(ctx, f.tenant, f.bob, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, commit, mine); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT id FROM signatures WHERE entity_id = $1 AND invalidated_at IS NULL`, f.runID)
		if err != nil {
			return err
		}
		var sigs []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			sigs = append(sigs, id)
		}
		rows.Close()
		if rows.Err() != nil {
			return rows.Err()
		}
		for _, id := range sigs {
			if _, err := tx.Exec(ctx, `UPDATE signatures SET invalidated_at = now(), invalidated_by_change_set = $2 WHERE id = $1`, id, mine); err != nil {
				return err
			}
			if _, err := audit.Append(ctx, tx, f.tenant, audit.Entry{
				Actor: "bob", Action: "signature.invalidated", EntityType: "signature", EntityID: id, Reason: "transcription error",
			}); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.change_set_id', $1, true)`, mine); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE runs SET params = '{"x":1}' WHERE id = $1`, f.runID)
		return err
	})
	wantCode(t, "bob commits, invalidates and applies the correction", err, "")
	var runState, params string
	if err := db.Pool.QueryRow(ctx, `SELECT state, params::text FROM runs WHERE id = $1`, f.runID).Scan(&runState, &params); err != nil {
		t.Fatal(err)
	}
	if runState != "completed" || params != `{"x": 1}` || state(mine) != "committed" {
		t.Errorf("after the correction: run %q, params %s, change set %q", runState, params, state(mine))
	}

	err = db.WithTenant(ctx, f.tenant, f.bob, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE lineage_nodes SET label = 'x' WHERE id = $1`, f.r)
		return err
	})
	wantCode(t, "bob edits a node with no committed change set", err, "LDE05")

	// A note on a sealed node touches nothing the seal covers: a scientist
	// alone commits it, and no signature is invalidated.
	if _, err := trySign(db, f.tenant, f.alice, f.runID, 1, "author"); err != nil {
		t.Fatal(err)
	}
	note := propose(f.alice, "alice", fmt.Sprintf(`[{"op":"add_note","node_id":%q,"body":"looks fine"}]`, f.r))
	wantCode(t, "scientist commits an add_note change set", commitAs(carol, note), "")
	var valid int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM signatures WHERE entity_id = $1 AND invalidated_at IS NULL`, f.runID).Scan(&valid); err != nil {
		t.Fatal(err)
	}
	if valid != 1 || state(note) != "committed" {
		t.Errorf("after add_note: %d valid signatures, change set %q; want 1, committed", valid, state(note))
	}

	// An agent with two delegators can't move a proposal to the other human.
	erin := newSigner(t, db, f.tenant, "erin", "Erin Vale", "human", "scientist", "reviewer")
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		_, err := delegate(ctx, tx, f.tenant, "it@lab", f.bot.ID, erin.ID, as(f.tenant).ID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	forErin := propose(storage.Principal{ID: f.bot.ID, OnBehalfOf: erin.ID}, "bot", `[]`)
	err = db.WithTenant(ctx, f.tenant, storage.Principal{ID: f.bot.ID, OnBehalfOf: f.dana.ID}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE change_sets SET items = $2::jsonb WHERE id = $1`, forErin, touchesRun)
		return err
	})
	wantCode(t, "bot replaces erin's proposal acting for dana", err, "LDE05")

	// A run's node never changes: moving it would change which run a change set touches.
	var q string
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		exp := newExperiment(t, tx, f.tenant, "unrelated")
		pv, _ := newProtocolVersion(t, tx, f.tenant, exp, 1, "# p\n")
		var err error
		q, err = insertRun(tx, f.tenant, exp, pv)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = db.WithTenant(ctx, f.tenant, f.alice, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE runs SET node_id = $2 WHERE id = $1`, q, f.d)
		return err
	})
	wantCode(t, "scientist repoints a run's node", err, "LDE03")

	// A change set committed before the run was signed isn't a reviewed correction.
	early := newSignFixture(t, db, "completed")
	err = db.WithTenant(ctx, early.tenant, early.alice, func(tx pgx.Tx) error {
		var cs string
		if err := tx.QueryRow(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items, decision_reason)
			VALUES ($1, 'fix', 'early', 'alice', 'committed', $2::jsonb, 'early') RETURNING id`, early.tenant,
			fmt.Sprintf(`[{"op":"update_run_params","run_id":%q,"params":{}}]`, early.runID)).Scan(&cs); err != nil {
			return err
		}
		sig, err := applySignature(ctx, tx, early.tenant, early.runID, "alice", 1, "author")
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE signatures SET invalidated_at = now(), invalidated_by_change_set = $2 WHERE id = $1`, sig, cs)
		return err
	})
	wantCode(t, "invalidate with a change set committed before signing", err, "LDE07")

	// What a reviewed correction unlocks is limited to its own work.
	g := newSignFixture(t, db, "completed")
	sig1, err := trySign(db, g.tenant, g.alice, g.runID, 1, "author")
	if err != nil {
		t.Fatal(err)
	}
	sig2, err := trySign(db, g.tenant, g.bob, g.runID, 2, "review")
	if err != nil {
		t.Fatal(err)
	}
	var other string
	err = db.WithTenant(ctx, g.tenant, as(g.tenant), func(tx pgx.Tx) error {
		exp := newExperiment(t, tx, g.tenant, "other")
		pv, _ := newProtocolVersion(t, tx, g.tenant, exp, 1, "# p\n")
		var err error
		other, err = insertRun(tx, g.tenant, exp, pv)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	var fix string
	err = db.WithTenant(ctx, g.tenant, g.alice, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items)
			VALUES ($1, 'fix', 'typo', 'alice', 'proposed', $2::jsonb) RETURNING id`, g.tenant,
			fmt.Sprintf(`[{"op":"update_run_params","run_id":%q,"params":{"x":2}}]`, g.runID)).Scan(&fix)
	})
	if err != nil {
		t.Fatal(err)
	}
	// Each case rolls back, so the correction stays available to the next.
	corrected := func(stmt string, args ...any) error {
		return db.WithTenant(ctx, g.tenant, g.bob, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `UPDATE change_sets SET state = 'committed', decision_reason = 'ok' WHERE id = $1`, fix); err != nil {
				return err
			}
			for _, id := range []string{sig1, sig2} {
				if _, err := tx.Exec(ctx, `UPDATE signatures SET invalidated_at = now(), invalidated_by_change_set = $2 WHERE id = $1`, id, fix); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(ctx, `SELECT set_config('app.change_set_id', $1, true)`, fix); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, stmt, args...)
			return err
		})
	}
	wantCode(t, "correction: abort the run", corrected(`UPDATE runs SET state = 'aborted' WHERE id = $1`, g.runID), "LDE05")
	wantCode(t, "correction: params of an unrelated run", corrected(`UPDATE runs SET params = '{"x":9}' WHERE id = $1`, other), "LDE05")
	wantCode(t, "correction: abort an unrelated run", corrected(`UPDATE runs SET state = 'aborted' WHERE id = $1`, other), "LDE05")
	wantCode(t, "correction: new experiment", corrected(`INSERT INTO experiments (tenant_id, slug, title, created_by) VALUES ($1, 'x', 'x', 'bob')`, g.tenant), "LDE05")
	wantCode(t, "correction: new instrument", corrected(`INSERT INTO instruments (tenant_id, node_id, name, kind) VALUES ($1, $2, 'x', 'x')`, g.tenant, g.i), "LDE05")
	// Another principal in the same transaction can't use bob's correction.
	err = db.WithTenant(ctx, g.tenant, g.bob, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE change_sets SET state = 'committed', decision_reason = 'ok' WHERE id = $1`, fix); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.principal_id', $1, true)`, g.alice.ID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE signatures SET invalidated_at = now(), invalidated_by_change_set = $2 WHERE id = $1`, sig1, fix)
		return err
	})
	wantCode(t, "invalidate under a correction someone else reviewed", err, "LDE07")

	// A run can't be added to a sealed node, or renumbered: either could make a
	// committed change set that names its id touch a run nobody reviewed.
	err = db.WithTenant(ctx, g.tenant, as(g.tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO runs (tenant_id, experiment_id, node_id, protocol_version_id, created_by)
			SELECT tenant_id, experiment_id, $2, protocol_version_id, 'it@lab' FROM runs WHERE id = $1`, g.runID, g.d)
		return err
	})
	wantCode(t, "new run on a sealed dataset", err, "LDE04")
	err = db.WithTenant(ctx, g.tenant, as(g.tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE runs SET id = gen_random_uuid() WHERE id = $1`, other)
		return err
	})
	wantCode(t, "renumber a run", err, "LDE03")

	// A correction and a policy change don't share a change set.
	var mixed string
	err = db.WithTenant(ctx, g.tenant, g.alice, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items)
			VALUES ($1, 'mix', 'mix', 'alice', 'proposed', $2::jsonb) RETURNING id`, g.tenant,
			fmt.Sprintf(`[{"op":"update_run_params","run_id":%q,"params":{}},{"op":"set_signing_policy"}]`, g.runID)).Scan(&mixed)
	})
	if err != nil {
		t.Fatal(err)
	}
	err = db.WithTenant(ctx, g.tenant, as(g.tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE change_sets SET state = 'committed', decision_reason = 'ok' WHERE id = $1`, mixed)
		return err
	})
	wantCode(t, "correction mixed with a policy change", err, "LDE07")
}

// SPEC-008-R15, SPEC-008-R13
func TestSigningPolicyChangeRoles(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	tenant := newTenant(t, db)
	sci := newPrincipal(t, db, tenant, "sci", "human", "scientist")
	rev := newPrincipal(t, db, tenant, "rev", "human", "reviewer")
	qa := newPrincipal(t, db, tenant, "qa", "human", "qa")
	adm := newPrincipal(t, db, tenant, "adm", "human", "admin")

	const (
		oneStep   = `[{"step":1,"meaning":"author","role":"scientist"}]`
		threeStep = `[{"step":1,"meaning":"author","role":"scientist"},{"step":2,"meaning":"review","role":"reviewer"},{"step":3,"meaning":"approval","role":"qa"}]`
		defPolicy = `[{"step":1,"meaning":"author","role":"scientist"},{"step":2,"meaning":"review","role":"reviewer"}]`
	)
	var expID, pvID string
	err := db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		expID = newExperiment(t, tx, tenant, "exp")
		pvID, _ = newProtocolVersion(t, tx, tenant, expID, 1, "# p\n")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// setPolicy commits a set_signing_policy change set as tx's principal and
	// updates the experiment's policy under it.
	setPolicy := func(ctx context.Context, tx pgx.Tx, tenant, expID, actor, policy string) error {
		var id string
		if err := tx.QueryRow(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items, decision_reason)
			VALUES ($1, 'policy', 'change policy', $2, 'committed', $3::jsonb, 'change policy') RETURNING id`,
			tenant, actor, fmt.Sprintf(`[{"op":"set_signing_policy","experiment_id":%q,"signing_policy":%s}]`, expID, policy)).Scan(&id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.change_set_id', $1, true)`, id); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE experiments SET signing_policy = $2::jsonb WHERE id = $1`, expID, policy)
		return err
	}
	try := func(p storage.Principal, actor, policy string) error {
		return db.WithTenant(ctx, tenant, p, func(tx pgx.Tx) error {
			return setPolicy(ctx, tx, tenant, expID, actor, policy)
		})
	}

	var gxp bool
	if err := db.Pool.QueryRow(ctx, `SELECT gxp FROM tenants WHERE id = $1`, tenant).Scan(&gxp); err != nil {
		t.Fatal(err)
	}
	if !gxp {
		t.Error("a new tenant: want gxp = true")
	}

	wantCode(t, "GxP: scientist", try(sci, "sci", oneStep), "LDE05")
	wantCode(t, "GxP: reviewer", try(rev, "rev", oneStep), "LDE05")
	wantCode(t, "GxP: qa", try(qa, "qa", oneStep), "")
	wantCode(t, "GxP: admin", try(adm, "adm", defPolicy), "")

	err = db.WithTenant(ctx, tenant, sci, func(tx pgx.Tx) error {
		if _, err := commitChangeSet(ctx, tx, tenant, "sci", "empty"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE experiments SET signing_policy = $2::jsonb WHERE id = $1`, expID, oneStep)
		return err
	})
	wantCode(t, "scientist updates the policy under an empty change set", err, "LDE05")

	// A policy commit unlocks updates to experiments and nothing else.
	var unrelated string
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) (err error) {
		unrelated, err = insertRun(tx, tenant, expID, pvID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name, stmt string
		arg        string
	}{
		{"params of a run", `UPDATE runs SET params = '{"x":1}' WHERE id = $1`, unrelated},
		{"state of a run", `UPDATE runs SET state = 'aborted' WHERE id = $1`, unrelated},
		{"new node", `INSERT INTO lineage_nodes (tenant_id, kind, label, created_by) VALUES ($1, 'sample', 's', 'adm')`, tenant},
	} {
		err := db.WithTenant(ctx, tenant, adm, func(tx pgx.Tx) error {
			var id string
			if err := tx.QueryRow(ctx, `INSERT INTO change_sets (tenant_id, title, reason, author, state, items, decision_reason)
				VALUES ($1, 'noop', 'noop', 'adm', 'committed', '[{"op":"set_signing_policy"}]', 'noop') RETURNING id`, tenant).Scan(&id); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `SELECT set_config('app.change_set_id', $1, true)`, id); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, c.stmt, c.arg)
			return err
		})
		wantCode(t, "admin under a no-op policy commit: "+c.name, err, "LDE05")
	}

	// Leaving GxP mode is the owner's act, and it is audited.
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE tenants SET gxp = false WHERE id = $1`, tenant)
		return err
	})
	wantCode(t, "lde_app sets gxp", err, "42501")
	err = db.WithOwner(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE tenants SET gxp = false WHERE id = $1`, tenant)
		return err
	})
	wantCode(t, "owner sets gxp with no event", err, "LDE02")
	err = db.WithOwner(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE tenants SET gxp = false WHERE id = $1`, tenant); err != nil {
			return err
		}
		_, err := audit.Append(ctx, tx, tenant, audit.Entry{
			Actor: "system:test", Action: "tenant.gxp_changed", EntityType: "tenant", EntityID: tenant, Reason: "fixture",
			Payload: map[string]any{"gxp": false},
		})
		return err
	})
	wantCode(t, "owner sets gxp with its event", err, "")

	wantCode(t, "non-GxP: scientist", try(sci, "sci", oneStep), "LDE05")
	wantCode(t, "non-GxP: reviewer", try(rev, "rev", oneStep), "")

	// A new experiment gets the default policy whatever lde_app asks for.
	var isDefault bool
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `INSERT INTO experiments (tenant_id, slug, title, created_by, signing_policy)
			VALUES ($1, 'weak', 'weak', 'it@lab', $2::jsonb) RETURNING signing_policy = $3::jsonb`,
			tenant, oneStep, defPolicy).Scan(&isDefault)
	})
	wantCode(t, "insert an experiment with a one-step policy", err, "")
	if !isDefault {
		t.Error("experiment inserted with a one-step policy: want the default policy")
	}

	// SPEC-008-R13: a run keeps the policy it was created under.
	var before, after string
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) (err error) {
		before, err = insertRun(tx, tenant, expID, pvID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	wantCode(t, "non-GxP: reviewer sets three steps", try(rev, "rev", threeStep), "")
	err = db.WithTenant(ctx, tenant, as(tenant), func(tx pgx.Tx) (err error) {
		after, err = insertRun(tx, tenant, expID, pvID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, run string
		steps     int
	}{{"run created before the change", before, 1}, {"run created after it", after, 3}} {
		var n int
		if err := db.Pool.QueryRow(ctx, `SELECT jsonb_array_length(signing_policy) FROM runs WHERE id = $1`, tc.run).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != tc.steps {
			t.Errorf("%s: %d steps, want %d", tc.name, n, tc.steps)
		}
	}

	for _, tc := range []struct{ name, policy string }{
		{"a gap in the steps", `[{"step":1,"meaning":"author","role":"scientist"},{"step":3,"meaning":"review","role":"reviewer"}]`},
		{"an unknown meaning", `[{"step":1,"meaning":"witness","role":"scientist"}]`},
		{"an empty policy", `[]`},
	} {
		wantCode(t, "invalid policy: "+tc.name, try(rev, "rev", tc.policy), "23514")
	}
}

// SPEC-008-R04
func TestSignatureChallengeRules(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	f := newSignFixture(t, db, "completed")
	sha := strings.Repeat("a", 64)
	carol := newSigner(t, db, f.tenant, "carol", "Carol Wu", "human", "admin")

	// challenge starts a signing attempt on run as p, with its audit event.
	challenge := func(tenant string, p storage.Principal, run string) (string, error) {
		var id string
		err := db.WithTenant(ctx, tenant, p, func(tx pgx.Tx) error {
			if err := tx.QueryRow(ctx, `INSERT INTO signature_challenges (tenant_id, run_id, manifest_sha256)
				VALUES ($1, $2, $3) RETURNING id`, tenant, run, sha).Scan(&id); err != nil {
				return err
			}
			_, err := audit.Append(ctx, tx, tenant, audit.Entry{
				Actor: "x", Action: "signature.challenge_issued", EntityType: "signature_challenge", EntityID: id,
			})
			return err
		})
		return id, err
	}
	exec := func(p storage.Principal, stmt string, args ...any) error {
		return db.WithTenant(ctx, f.tenant, p, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, stmt, args...)
			return err
		})
	}

	// Who may start one: a human who could sign this finished run.
	id, err := challenge(f.tenant, f.alice, f.runID)
	wantCode(t, "alice starts an attempt", err, "")
	var principal string
	if err := db.Pool.QueryRow(ctx, `SELECT principal_id FROM signature_challenges WHERE id = $1`, id).Scan(&principal); err != nil {
		t.Fatal(err)
	}
	if principal != f.alice.ID {
		t.Errorf("principal_id = %s, want alice %s", principal, f.alice.ID)
	}
	_, err = challenge(f.tenant, storage.Principal{ID: f.bot.ID, OnBehalfOf: f.dana.ID}, f.runID)
	wantCode(t, "an agent starts an attempt", err, "LDE07")
	_, err = challenge(f.tenant, carol, f.runID)
	wantCode(t, "an admin with no policy role starts an attempt", err, "LDE07")
	running := newSignFixture(t, db, "running")
	_, err = challenge(running.tenant, running.alice, running.runID)
	wantCode(t, "an attempt on a running run", err, "LDE07")

	// What lde_app can't set or skip.
	wantCode(t, "lde_app sets principal_id", exec(f.alice, `INSERT INTO signature_challenges (tenant_id, run_id, manifest_sha256, principal_id)
		VALUES ($1, $2, $3, $4)`, f.tenant, f.runID, sha, f.dana.ID), "42501")
	wantCode(t, "lde_app sets created_at", exec(f.alice, `INSERT INTO signature_challenges (tenant_id, run_id, manifest_sha256, created_at)
		VALUES ($1, $2, $3, now())`, f.tenant, f.runID, sha), "42501")
	wantCode(t, "no audit event", exec(f.alice, `INSERT INTO signature_challenges (tenant_id, run_id, manifest_sha256)
		VALUES ($1, $2, $3)`, f.tenant, f.runID, sha), "LDE02")
	wantCode(t, "lde_app changes the manifest", exec(f.alice, `UPDATE signature_challenges SET manifest_sha256 = 'x' WHERE id = $1`, id), "42501")
	wantCode(t, "lde_app deletes", exec(f.alice, `DELETE FROM signature_challenges WHERE id = $1`, id), "42501")
	wantCode(t, "lde_app truncates", exec(f.alice, `TRUNCATE signature_challenges`), "42501")

	// Used once, by the principal it was issued to.
	const use = `UPDATE signature_challenges SET used_at = now() WHERE id = $1`
	wantCode(t, "bob uses alice's challenge", exec(f.bob, use, id), "LDE07")
	wantCode(t, "alice uses it", exec(f.alice, use, id), "")
	wantCode(t, "alice uses it again", exec(f.alice, use, id), "LDE03")
	wantCode(t, "alice un-uses it", exec(f.alice, `UPDATE signature_challenges SET used_at = NULL WHERE id = $1`, id), "LDE03")

	_, err = db.Pool.Exec(ctx, `DELETE FROM signature_challenges WHERE id = $1`, id)
	wantCode(t, "owner deletes", err, "LDE03")
	_, err = db.Pool.Exec(ctx, `TRUNCATE signature_challenges`)
	wantCode(t, "owner truncates", err, "LDE03")

	// Another tenant can't see it.
	var seen int
	err = db.WithTenant(ctx, running.tenant, running.alice, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM signature_challenges WHERE id = $1`, id).Scan(&seen)
	})
	wantCode(t, "another tenant reads", err, "")
	if seen != 0 {
		t.Errorf("another tenant sees %d challenges, want 0", seen)
	}

	// One login signs once, across runs.
	var second string
	err = db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) (err error) {
		exp := newExperiment(t, tx, f.tenant, "second")
		pv, _ := newProtocolVersion(t, tx, f.tenant, exp, 1, "# p\n")
		second, err = insertRun(tx, f.tenant, exp, pv)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE runs SET state = 'completed' WHERE id = $1`, second); err != nil {
		t.Fatal(err)
	}
	login := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	sign := func(run string) error {
		return db.WithTenant(ctx, f.tenant, f.alice, func(tx pgx.Tx) error {
			var manifest string
			var sum []byte
			if err := tx.QueryRow(ctx, `INSERT INTO signature_manifests (tenant_id, run_id, manifest)
				VALUES ($1, $2, $3) RETURNING id, sha256`, f.tenant, run, fmt.Sprintf(`{"run_id":%q}`, run)).Scan(&manifest, &sum); err != nil {
				return err
			}
			var sig string
			if err := tx.QueryRow(ctx, `INSERT INTO signatures (tenant_id, entity_type, entity_id, step, meaning, signer_id,
					printed_name, manifest_id, manifest_sha256, reauth_at, reauth_method)
				VALUES ($1, 'run', $2, 1, 'author', $3, 'x', $4, $5, $6, 'oidc') RETURNING id`,
				f.tenant, run, f.alice.ID, manifest, sum, login).Scan(&sig); err != nil {
				return err
			}
			_, err := audit.Append(ctx, tx, f.tenant, audit.Entry{
				Actor: "alice", Action: "signature.applied", EntityType: "signature", EntityID: sig, Reason: "author",
			})
			return err
		})
	}
	wantCode(t, "one login signs a run", sign(f.runID), "")
	wantCode(t, "the same login signs another run", sign(second), "23505")
}
