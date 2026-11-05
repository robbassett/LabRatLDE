-- 0021_signature_challenge_link: a re-authenticated signature names its login (SPEC-023).
--
-- Until now only the service linked a signature to the challenge that proved it:
-- the database would accept an 'oidc' signature with no challenge at all. The
-- service is still the only place that can verify a token, so this proves it
-- recorded a matching login in this transaction, not that the token was genuine.
-- Signatures from before this migration have no challenge and stay valid.

-- SPEC-023-R04
ALTER TABLE signatures ADD COLUMN challenge_id uuid;
ALTER TABLE signatures ADD CONSTRAINT signatures_challenge_fk
    FOREIGN KEY (tenant_id, challenge_id) REFERENCES signature_challenges (tenant_id, id);
CREATE UNIQUE INDEX signatures_one_per_challenge ON signatures (tenant_id, challenge_id)
    WHERE challenge_id IS NOT NULL;

-- SPEC-023-R04: named to fire after signatures_guard, which stamps the signer.
CREATE FUNCTION signatures_reauth_bound() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.challenge_id IS DISTINCT FROM OLD.challenge_id THEN
            RAISE EXCEPTION 'signature %: its challenge never changes', OLD.id USING ERRCODE = 'LDE03';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.reauth_method = 'dev' THEN
        IF NEW.challenge_id IS NOT NULL THEN
            RAISE EXCEPTION 'a dev signature has no challenge' USING ERRCODE = 'LDE07';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.challenge_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.signature_challenges c
        WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.challenge_id
          AND c.principal_id = NEW.signer_id
          AND c.run_id = NEW.entity_id
          AND c.manifest_sha256 = encode(NEW.manifest_sha256, 'hex')
          AND c.used_at IS NOT NULL AND c.login_at IS NOT NULL
          AND NEW.reauth_at <= c.login_at
          AND c.xmin = pg_current_xact_id()::xid
    ) THEN
        RAISE EXCEPTION 'an oidc signature needs a challenge used in this transaction, by this signer, for this run and manifest'
            USING ERRCODE = 'LDE07';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER signatures_reauth_bound
    BEFORE INSERT OR UPDATE ON signatures
    FOR EACH ROW EXECUTE FUNCTION signatures_reauth_bound();

-- SPEC-023-R05: as 0020, except that using a challenge needs a login time, and
-- the message names login_at.
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
        RAISE EXCEPTION 'signature challenge %: only used_at and login_at may change', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF current_user = 'lde_app' THEN
        IF public.lde_current_principal() IS DISTINCT FROM OLD.principal_id THEN
            RAISE EXCEPTION 'signature challenge % belongs to another principal', OLD.id USING ERRCODE = 'LDE07';
        END IF;
        IF NEW.login_at IS NULL THEN
            RAISE EXCEPTION 'signature challenge % can be used only with a login time', OLD.id USING ERRCODE = 'LDE07';
        END IF;
        NEW.used_at := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;
