-- 0019_signature_challenges: a login must be for the signature it proves (SPEC-008).
--
-- A recent login isn't enough: someone who signed in a minute ago hasn't
-- re-authenticated to sign this record. The server issues a challenge for one
-- signing attempt, its id goes through the IdP as the OIDC nonce, and the ID
-- token that comes back proves a login made for that attempt. A challenge is
-- used once. Whether a token matches is checked by the service, which is the
-- only place that can verify a token.

-- SPEC-008-R04
CREATE TABLE signature_challenges (
    id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants (id),
    principal_id    uuid NOT NULL,
    run_id          uuid NOT NULL,
    manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    created_at      timestamptz NOT NULL DEFAULT now(),
    used_at         timestamptz,
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, principal_id) REFERENCES principals (tenant_id, id),
    FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, id)
);

-- SPEC-008-R04: the database says who asked and when, and a challenge is used
-- once, by the principal it was issued to.
CREATE FUNCTION signature_challenges_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'signature challenges are never removed (% rejected)', TG_OP USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF current_user = 'lde_app' THEN
            NEW.principal_id := public.lde_current_principal();
            NEW.created_at := clock_timestamp();
            NEW.used_at := NULL;
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

CREATE TRIGGER signature_challenges_guard
    BEFORE INSERT OR UPDATE OR DELETE ON signature_challenges
    FOR EACH ROW EXECUTE FUNCTION signature_challenges_guard();
CREATE TRIGGER signature_challenges_no_truncate
    BEFORE TRUNCATE ON signature_challenges
    FOR EACH STATEMENT EXECUTE FUNCTION signature_challenges_guard();

-- SPEC-008-R04: an abandoned attempt leaves a record too.
CREATE CONSTRAINT TRIGGER signature_challenges_audited
    AFTER INSERT ON signature_challenges DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION lde_require_audit('signature_challenge', 'signature.challenge_issued');

-- SPEC-008-R04
ALTER TABLE signature_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON signature_challenges TO lde_app
    USING (tenant_id = lde_current_tenant())
    WITH CHECK (tenant_id = lde_current_tenant());
DO $$
BEGIN
    EXECUTE format('CREATE POLICY owner_maintenance ON signature_challenges TO %I USING (true) WITH CHECK (true)', current_user);
END;
$$;
GRANT SELECT, INSERT (tenant_id, run_id, manifest_sha256), UPDATE (used_at) ON signature_challenges TO lde_app;
