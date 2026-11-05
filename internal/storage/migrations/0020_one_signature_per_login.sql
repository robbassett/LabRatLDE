-- 0020_one_signature_per_login: one login proves one signature (SPEC-008).
--
-- A challenge is single-use, but one password entry could still answer several
-- challenges through silent IdP code flows, all carrying the same auth_time. A
-- login is identified by its signer and auth_time, so that pair can answer one
-- challenge. It is kept here as the token said it, because signatures.reauth_at
-- is clamped to the database clock and so can't identify a login. A used
-- challenge stays used, so re-signing after a correction needs a new login.
--
-- A challenge is also now only for someone who could sign the run. Before this,
-- any principal could add an audit event per request, on any run.

-- SPEC-008-R04
ALTER TABLE signature_challenges ADD COLUMN login_at timestamptz;
CREATE UNIQUE INDEX signature_challenges_one_per_login ON signature_challenges (tenant_id, principal_id, login_at)
    WHERE login_at IS NOT NULL;
GRANT UPDATE (login_at) ON signature_challenges TO lde_app;

-- SPEC-008-R04: as 0019, plus the gate on who may start a signing attempt.
CREATE OR REPLACE FUNCTION signature_challenges_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    run_state text;
    policy    jsonb;
BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'signature challenges are never removed (% rejected)', TG_OP USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF current_user = 'lde_app' THEN
            NEW.principal_id := public.lde_current_principal();
            NEW.created_at := clock_timestamp();
            NEW.used_at := NULL;
            IF NOT EXISTS (
                SELECT 1 FROM public.principals p
                WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.principal_id AND p.kind = 'human' AND p.enabled
            ) THEN
                RAISE EXCEPTION 'only an enabled human can start a signature' USING ERRCODE = 'LDE07';
            END IF;
            SELECT r.state, r.signing_policy INTO run_state, policy
            FROM public.runs r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.run_id;
            IF NOT FOUND OR run_state NOT IN ('completed', 'failed') THEN
                RAISE EXCEPTION 'run % does not exist or is not waiting for a signature', NEW.run_id USING ERRCODE = 'LDE07';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(policy) e
                WHERE public.lde_principal_holds(NEW.principal_id, e ->> 'role', NULL)
            ) THEN
                RAISE EXCEPTION 'no step of run %''s signing policy is for this principal', NEW.run_id USING ERRCODE = 'LDE07';
            END IF;
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.used_at IS NOT NULL THEN
        RAISE EXCEPTION 'signature challenge % is already used', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.principal_id, NEW.run_id, NEW.manifest_sha256, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.principal_id, OLD.run_id, OLD.manifest_sha256, OLD.created_at) THEN
        RAISE EXCEPTION 'signature challenge %: only used_at may change', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF current_user = 'lde_app' THEN
        IF public.lde_current_principal() IS DISTINCT FROM OLD.principal_id THEN
            RAISE EXCEPTION 'signature challenge % belongs to another principal', OLD.id USING ERRCODE = 'LDE07';
        END IF;
        NEW.used_at := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;
