package storage_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Accelerate-Biotech/LabRatLDE/internal/audit"
	"github.com/Accelerate-Biotech/LabRatLDE/internal/storage"
)

// SPEC-023-R04
func TestOIDCSignatureNamesItsLogin(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	f := newSignFixture(t, db, "completed")

	var otherRun string
	err := db.WithTenant(ctx, f.tenant, as(f.tenant), func(tx pgx.Tx) error {
		exp := newExperiment(t, tx, f.tenant, "other")
		pv, _ := newProtocolVersion(t, tx, f.tenant, exp, 1, "# p\n")
		var node string
		if err := tx.QueryRow(ctx, insertNode, f.tenant, "run").Scan(&node); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `INSERT INTO runs (tenant_id, experiment_id, node_id, protocol_version_id, created_by)
			VALUES ($1, $2, $3, $4, 'it@lab') RETURNING id`, f.tenant, exp, node, pv).Scan(&otherRun)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE runs SET state = 'completed' WHERE id = $1`, otherRun); err != nil {
		t.Fatal(err)
	}

	text := fmt.Sprintf(`{"run_id":%q}`, f.runID)
	sum := sha256.Sum256([]byte(text))
	sha := hex.EncodeToString(sum[:])

	// challenge starts a signing attempt, committed, as p.
	challenge := func(p storage.Principal, run, manifestSHA string) string {
		t.Helper()
		var id string
		err := db.WithTenant(ctx, f.tenant, p, func(tx pgx.Tx) error {
			if err := tx.QueryRow(ctx, `INSERT INTO signature_challenges (tenant_id, run_id, manifest_sha256)
				VALUES ($1, $2, $3) RETURNING id`, f.tenant, run, manifestSHA).Scan(&id); err != nil {
				return err
			}
			_, err := audit.Append(ctx, tx, f.tenant, audit.Entry{
				Actor: "x", Action: "signature.challenge_issued", EntityType: "signature_challenge", EntityID: id,
			})
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	const use = `UPDATE signature_challenges SET used_at = now(), login_at = clock_timestamp() WHERE id = $1`

	// sign has alice sign step 1 in a transaction of its own, spending the
	// challenge named by spend first, as the principal spender.
	sign := func(method, named, spend string, spender storage.Principal) error {
		return db.WithTenant(ctx, f.tenant, f.alice, func(tx pgx.Tx) error {
			if spend != "" {
				if _, err := tx.Exec(ctx, `SELECT set_config('app.principal_id', $1, true)`, spender.ID); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, use, spend); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `SELECT set_config('app.principal_id', $1, true)`, f.alice.ID); err != nil {
					return err
				}
			}
			var manifestID string
			if err := tx.QueryRow(ctx, `INSERT INTO signature_manifests (tenant_id, run_id, manifest)
				VALUES ($1, $2, $3) RETURNING id`, f.tenant, f.runID, text).Scan(&manifestID); err != nil {
				return err
			}
			var id string
			if err := tx.QueryRow(ctx, `INSERT INTO signatures (tenant_id, entity_type, entity_id, step, meaning, signer_id,
					printed_name, manifest_id, manifest_sha256, reauth_at, reauth_method, challenge_id)
				VALUES ($1, 'run', $2, 1, 'author', lde_current_principal(), 'x', $3, decode($4, 'hex'), now(), $5, NULLIF($6, '')::uuid)
				RETURNING id`, f.tenant, f.runID, manifestID, sha, method, named).Scan(&id); err != nil {
				return err
			}
			_, err := audit.Append(ctx, tx, f.tenant, audit.Entry{
				Actor: "alice", Action: "signature.applied", EntityType: "signature", EntityID: id, Reason: "author",
				Payload: map[string]any{"manifest_sha256": sha},
			})
			return err
		})
	}

	wantCode(t, "oidc with no challenge", sign("oidc", "", "", f.alice), "LDE07")

	unused := challenge(f.alice, f.runID, sha)
	wantCode(t, "a challenge nobody used", sign("oidc", unused, "", f.alice), "LDE07")

	earlier := challenge(f.alice, f.runID, sha)
	if err := db.WithTenant(ctx, f.tenant, f.alice, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, use, earlier)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	wantCode(t, "a challenge used in an earlier transaction", sign("oidc", earlier, "", f.alice), "LDE07")

	danas := challenge(f.dana, f.runID, sha)
	wantCode(t, "another signer's challenge", sign("oidc", danas, danas, f.dana), "LDE07")

	otherManifest := challenge(f.alice, f.runID, strings.Repeat("b", 64))
	wantCode(t, "a challenge for another manifest", sign("oidc", otherManifest, otherManifest, f.alice), "LDE07")

	forOtherRun := challenge(f.alice, otherRun, sha)
	wantCode(t, "a challenge for another run", sign("oidc", forOtherRun, forOtherRun, f.alice), "LDE07")

	good := challenge(f.alice, f.runID, sha)
	wantCode(t, "a dev signature naming a challenge", sign("dev", good, good, f.alice), "LDE07")
	wantCode(t, "the right challenge, used in this transaction", sign("oidc", good, good, f.alice), "")
	wantCode(t, "the same challenge again", sign("oidc", good, "", f.alice), "LDE07")

	// A signature's challenge never changes.
	err = db.WithTenant(ctx, f.tenant, f.alice, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE signatures SET challenge_id = NULL WHERE entity_id = $1`, f.runID)
		return err
	})
	wantCode(t, "lde_app changes the challenge", err, "42501")
	_, err = db.Pool.Exec(ctx, `UPDATE signatures SET challenge_id = NULL WHERE entity_id = $1`, f.runID)
	wantCode(t, "the owner changes the challenge", err, "LDE07")
}
