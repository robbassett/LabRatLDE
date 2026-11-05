-- 0015_signing_policy: GxP mode, signing policies and printed names (SPEC-008).
--
-- A tenant is in GxP mode unless the owner says otherwise; the flag can only
-- change with an audit event. An experiment carries a signing policy (the
-- ordered steps that sign a run); each run copies it on creation and nobody
-- can change that copy. Principals may now be renamed, because a signature
-- prints the signer's name, but a name is never blank.

-- SPEC-008-R16: whether a printed name has anything to print. [:space:] alone
-- misses the Unicode blanks a paste can bring in, such as a non-breaking space.
CREATE FUNCTION lde_has_text(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT t ~ '[^[:space:]\u00A0\u1680\u180E\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]'
$$;

GRANT EXECUTE ON FUNCTION lde_has_text(text) TO lde_app;

-- SPEC-008-R15: lde_app holds only SELECT on tenants, so only the owner can
-- change this. The change and its audit event commit together.
ALTER TABLE tenants ADD COLUMN gxp boolean NOT NULL DEFAULT true;

CREATE FUNCTION tenants_require_gxp_audit() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.audit_events a
        WHERE a.tenant_id = NEW.id AND a.entity_type = 'tenant' AND a.entity_id = NEW.id::text
          AND a.action = 'tenant.gxp_changed' AND btrim(a.reason) <> '' AND a.xmin = pg_current_xact_id()::xid
    ) THEN
        RAISE EXCEPTION 'tenant % gxp changed without a tenant.gxp_changed audit event in its transaction', NEW.id
            USING ERRCODE = 'LDE02';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER tenants_gxp_audited
    AFTER UPDATE OF gxp ON tenants DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (OLD.gxp IS DISTINCT FROM NEW.gxp)
    EXECUTE FUNCTION tenants_require_gxp_audit();

-- SPEC-008-R13: a non-empty array of {step, meaning, role}; steps are exactly
-- 1..n in order. Adding a meaning needs a spec.
CREATE FUNCTION signing_policy_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp AS $$
    SELECT p IS NOT NULL
       AND jsonb_typeof(p) = 'array'
       AND jsonb_array_length(p) > 0
       AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p) WITH ORDINALITY AS e(v, i)
            WHERE jsonb_typeof(e.v) <> 'object'
               OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e.v) k) IS DISTINCT FROM ARRAY['meaning', 'role', 'step']
               OR jsonb_typeof(e.v -> 'step') <> 'number'
               OR e.v ->> 'step' <> e.i::text
               OR jsonb_typeof(e.v -> 'meaning') <> 'string'
               OR e.v ->> 'meaning' NOT IN ('author', 'review', 'approval', 'verification')
               OR jsonb_typeof(e.v -> 'role') <> 'string'
               OR e.v ->> 'role' NOT IN ('scientist', 'reviewer', 'qa')
       )
$$;

GRANT EXECUTE ON FUNCTION signing_policy_valid(jsonb) TO lde_app;

-- SPEC-008-R13: new experiments always get the default; weakening a policy
-- goes through the gated update path.
ALTER TABLE experiments ADD COLUMN signing_policy jsonb NOT NULL
    DEFAULT '[{"step":1,"meaning":"author","role":"scientist"},{"step":2,"meaning":"review","role":"reviewer"}]'
    CHECK (signing_policy_valid(signing_policy));

-- Policy changes are revisions (0012).
DROP TRIGGER experiments_revisions ON experiments;
CREATE TRIGGER experiments_revisions
    AFTER INSERT OR UPDATE ON experiments
    FOR EACH ROW EXECUTE FUNCTION record_revise('experiment', 'title', 'signing_policy');
GRANT UPDATE (signing_policy) ON experiments TO lde_app;

-- SPEC-008-R15: the column DEFAULT alone lets lde_app insert a weaker policy,
-- so inserts by lde_app are forced to the default.
CREATE FUNCTION experiments_default_signing_policy() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF current_user = 'lde_app' THEN
        NEW.signing_policy := '[{"step":1,"meaning":"author","role":"scientist"},{"step":2,"meaning":"review","role":"reviewer"}]'::jsonb;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER experiments_default_signing_policy
    BEFORE INSERT ON experiments
    FOR EACH ROW EXECUTE FUNCTION experiments_default_signing_policy();

-- SPEC-008-R13: the default fills existing rows without firing triggers.
ALTER TABLE runs ADD COLUMN signing_policy jsonb NOT NULL
    DEFAULT '[{"step":1,"meaning":"author","role":"scientist"},{"step":2,"meaning":"review","role":"reviewer"}]'
    CHECK (signing_policy_valid(signing_policy));
ALTER TABLE runs ADD COLUMN signed_from text CHECK (signed_from IN ('completed', 'failed'));

CREATE FUNCTION runs_copy_signing_policy() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    SELECT e.signing_policy INTO NEW.signing_policy
    FROM public.experiments e
    WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.experiment_id;
    NEW.signed_from := NULL;
    RETURN NEW;
END;
$$;

CREATE TRIGGER runs_copy_signing_policy
    BEFORE INSERT ON runs
    FOR EACH ROW EXECUTE FUNCTION runs_copy_signing_policy();

CREATE FUNCTION runs_signing_columns() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.signing_policy IS DISTINCT FROM OLD.signing_policy THEN
        RAISE EXCEPTION 'run %: signing_policy is fixed when the run is created', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF current_user = 'lde_app' AND NEW.signed_from IS DISTINCT FROM OLD.signed_from THEN
        RAISE EXCEPTION 'run %: signed_from is set only by signing', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER runs_signing_columns
    BEFORE UPDATE ON runs
    FOR EACH ROW EXECUTE FUNCTION runs_signing_columns();

-- SPEC-008-R17: display_name may change (admin only, audited); never blank.
CREATE OR REPLACE FUNCTION principals_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'principals are never removed (TRUNCATE rejected)' USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'principal % is never removed (DELETE rejected)', OLD.handle USING ERRCODE = 'LDE03';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.kind, NEW.handle, NEW.email, NEW.issuer, NEW.subject, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.kind, OLD.handle, OLD.email, OLD.issuer, OLD.subject, OLD.created_at) THEN
        RAISE EXCEPTION 'principal %: only enabled and display_name may change', OLD.handle USING ERRCODE = 'LDE03';
    END IF;
    IF NEW.display_name IS DISTINCT FROM OLD.display_name AND NOT public.lde_has_text(NEW.display_name) THEN
        RAISE EXCEPTION 'principal %: display_name cannot be blank', OLD.handle USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

GRANT UPDATE (display_name) ON principals TO lde_app;

CREATE CONSTRAINT TRIGGER principals_name_audited
    AFTER UPDATE ON principals DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name)
    EXECUTE FUNCTION lde_require_audit('principal', '', 'principal.renamed');
