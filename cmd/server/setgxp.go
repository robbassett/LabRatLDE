package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Accelerate-Biotech/LabRatLDE/internal/audit"
	"github.com/Accelerate-Biotech/LabRatLDE/internal/config"
	"github.com/Accelerate-Biotech/LabRatLDE/internal/storage"
)

// runSetGxP turns a tenant's GxP mode on or off (SPEC-008-R15). GxP mode
// decides who may change a signing policy. It runs as the database owner,
// like bootstrap-admin: lde_app can't change the setting, so the API can't.
// The change is audited with its actor and reason in the same transaction.
func runSetGxP(args []string) error {
	fs := flag.NewFlagSet("set-gxp", flag.ContinueOnError)
	tenant := fs.String("tenant", "", "tenant uuid")
	gxpFlag := fs.String("gxp", "", "true or false")
	actor := fs.String("actor", "", "who is making the change")
	reason := fs.String("reason", "", "why")
	if err := fs.Parse(args); err != nil {
		return err
	}
	*tenant = strings.ToLower(*tenant)
	gxp, gxpErr := strconv.ParseBool(*gxpFlag)
	switch {
	case fs.NArg() > 0:
		return fmt.Errorf("set-gxp: unexpected argument %q", fs.Arg(0))
	case !tenantRE.MatchString(*tenant):
		return fmt.Errorf("set-gxp: --tenant must be a uuid")
	case gxpErr != nil:
		return fmt.Errorf("set-gxp: --gxp must be true or false")
	case strings.TrimSpace(*actor) == "":
		return fmt.Errorf("set-gxp: --actor is required")
	case strings.TrimSpace(*reason) == "":
		return fmt.Errorf("set-gxp: --reason is required")
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	connectCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	db, err := storage.Open(connectCtx, cfg.DatabaseURL)
	cancel()
	if err != nil {
		return err
	}
	defer db.Close()
	if cfg.AutoMigrate {
		if err := db.Migrate(ctx, slog.New(slog.NewTextHandler(os.Stderr, nil))); err != nil {
			return err
		}
	}

	err = db.WithOwner(ctx, func(tx pgx.Tx) error {
		var from bool
		if err := tx.QueryRow(ctx, `SELECT gxp FROM tenants WHERE id = $1 FOR NO KEY UPDATE`, *tenant).Scan(&from); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("tenant %s does not exist", *tenant)
			}
			return err
		}
		if from == gxp {
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE tenants SET gxp = $2 WHERE id = $1`, *tenant, gxp); err != nil {
			return err
		}
		_, err := audit.Append(ctx, tx, *tenant, audit.Entry{
			Actor: *actor, Action: "tenant.gxp_changed", EntityType: "tenant", EntityID: *tenant, Reason: *reason,
			Payload: map[string]any{"from": from, "to": gxp},
		})
		return err
	})
	if err != nil {
		return fmt.Errorf("set-gxp: %w", err)
	}
	fmt.Println(gxp)
	return nil
}
