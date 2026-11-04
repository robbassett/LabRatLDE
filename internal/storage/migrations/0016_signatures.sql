-- 0016_signatures: electronic signatures on runs (SPEC-008).
--
-- A signature binds a signer, a meaning and the manifest digest the signer
-- saw. Triggers enforce the policy order, the signer's role and kind, four
-- eyes and immutability. Only a committed correction may invalidate a
-- signature, and an invalidated signature is kept.

-- SPEC-008-R03: the manifest text is stored beside its digest, so a signature
-- can be re-verified later, offline.
CREATE TABLE signature_manifests (
    id         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id  uuid NOT NULL REFERENCES tenants (id),
    run_id     uuid NOT NULL,
    manifest   text NOT NULL,
    sha256     bytea GENERATED ALWAYS AS (protocol_sha256(manifest)) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, id)
);

-- SPEC-008-R01: entity_id has no FK because SPEC-010 extends entity_type; the
-- guard checks the run exists.
CREATE TABLE signatures (
    id                        uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id                 uuid NOT NULL REFERENCES tenants (id),
    entity_type               text NOT NULL CHECK (entity_type = 'run'),
    entity_id                 uuid NOT NULL,
    step                      int NOT NULL,
    meaning                   text NOT NULL CHECK (meaning IN ('author', 'review', 'approval', 'verification')),
    signer_id                 uuid NOT NULL,
    printed_name              text NOT NULL CHECK (printed_name ~ '[^[:space:]]'),
    signed_at                 timestamptz NOT NULL,
    manifest_id               uuid NOT NULL,
    manifest_sha256           bytea NOT NULL,
    comment                   text,
    reauth_at                 timestamptz NOT NULL,
    reauth_method             text NOT NULL CHECK (reauth_method IN ('oidc', 'dev')),
    invalidated_at            timestamptz,
    invalidated_by_change_set uuid,
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, signer_id) REFERENCES principals (tenant_id, id),
    FOREIGN KEY (tenant_id, manifest_id) REFERENCES signature_manifests (tenant_id, id),
    FOREIGN KEY (tenant_id, invalidated_by_change_set) REFERENCES change_sets (tenant_id, id),
    CHECK ((invalidated_at IS NULL) = (invalidated_by_change_set IS NULL))
);
CREATE UNIQUE INDEX signatures_valid_step ON signatures (tenant_id, entity_type, entity_id, step)
    WHERE invalidated_at IS NULL;

-- SPEC-008-R10: the runs with a valid signature whose seal covers a node the
-- items touch. A run's seal covers its own node and the nodes it generated.
CREATE FUNCTION change_set_touched_runs(t uuid, items jsonb) RETURNS SETOF uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
    WITH touched AS (
        SELECT (i ->> 'node_id')::uuid AS node_id
        FROM jsonb_array_elements(items) i WHERE i ->> 'op' = 'update_node'
        UNION
        SELECT r.node_id
        FROM jsonb_array_elements(items) i
        JOIN public.runs r ON r.tenant_id = t AND r.id = (i ->> 'run_id')::uuid
        WHERE i ->> 'op' = 'update_run_params'
        UNION
        SELECT (i ->> 'to')::uuid
        FROM jsonb_array_elements(items) i WHERE i ->> 'op' = 'add_edge'
        UNION
        SELECT (i ->> 'from')::uuid
        FROM jsonb_array_elements(items) i
        WHERE i ->> 'op' = 'add_edge' AND i ->> 'relation' = 'wasGeneratedBy'
        UNION
        SELECT n.node_id
        FROM jsonb_array_elements(items) i
        JOIN public.notes n ON n.tenant_id = t AND n.id = (i ->> 'note_id')::uuid
        WHERE i ->> 'op' = 'edit_note' AND NOT n.annotation
    )
    SELECT r.id
    FROM public.runs r
    WHERE r.tenant_id = t
      AND EXISTS (
            SELECT 1 FROM public.signatures s
            WHERE s.tenant_id = t AND s.entity_type = 'run' AND s.entity_id = r.id
              AND s.invalidated_at IS NULL)
      AND (r.node_id IN (SELECT node_id FROM touched)
           OR EXISTS (
                SELECT 1 FROM public.lineage_edges e
                WHERE e.tenant_id = t AND e.from_id = r.node_id AND e.relation = 'wasGeneratedBy'
                  AND e.to_id IN (SELECT node_id FROM touched)))
$$;

GRANT EXECUTE ON FUNCTION change_set_touched_runs(uuid, jsonb) TO lde_app;

-- SPEC-008-R11: manifests are append-only.
CREATE FUNCTION signature_manifests_reject_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'signature manifests are append-only (% rejected)', TG_OP USING ERRCODE = 'LDE03';
END;
$$;

CREATE TRIGGER signature_manifests_append_only
    BEFORE UPDATE OR DELETE ON signature_manifests
    FOR EACH ROW EXECUTE FUNCTION signature_manifests_reject_mutation();
CREATE TRIGGER signature_manifests_no_truncate
    BEFORE TRUNCATE ON signature_manifests
    FOR EACH STATEMENT EXECUTE FUNCTION signature_manifests_reject_mutation();

-- SPEC-008-R03, R05, R06, R07, R08, R11, R16
CREATE FUNCTION signatures_reject_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    run_state  text;
    policy     jsonb;
    manifest   public.signature_manifests%ROWTYPE;
    pr         public.principals%ROWTYPE;
    next_step  int;
    next_mean  text;
    next_role  text;
BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'signatures are never removed (% rejected)', TG_OP USING ERRCODE = 'LDE03';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.invalidated_at IS NOT NULL THEN
            RAISE EXCEPTION 'signature % is already invalidated', OLD.id USING ERRCODE = 'LDE03';
        END IF;
        IF (NEW.id, NEW.tenant_id, NEW.entity_type, NEW.entity_id, NEW.step, NEW.meaning, NEW.signer_id,
            NEW.printed_name, NEW.signed_at, NEW.manifest_id, NEW.manifest_sha256, NEW.comment,
            NEW.reauth_at, NEW.reauth_method)
           IS DISTINCT FROM
           (OLD.id, OLD.tenant_id, OLD.entity_type, OLD.entity_id, OLD.step, OLD.meaning, OLD.signer_id,
            OLD.printed_name, OLD.signed_at, OLD.manifest_id, OLD.manifest_sha256, OLD.comment,
            OLD.reauth_at, OLD.reauth_method) THEN
            RAISE EXCEPTION 'signature %: only the invalidation may change', OLD.id USING ERRCODE = 'LDE03';
        END IF;
        -- Only a correction committed in this transaction, touching this run.
        IF NEW.invalidated_by_change_set IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.change_sets cs
            WHERE cs.tenant_id = OLD.tenant_id AND cs.id = NEW.invalidated_by_change_set
              AND cs.state = 'committed' AND cs.xmin = pg_current_xact_id()::xid
              AND OLD.entity_id IN (SELECT public.change_set_touched_runs(cs.tenant_id, cs.items))
        ) THEN
            RAISE EXCEPTION 'signature % can be invalidated only by a correction committed in this transaction that touches its run', OLD.id
                USING ERRCODE = 'LDE07';
        END IF;
        NEW.invalidated_at := clock_timestamp();
        RETURN NEW;
    END IF;

    -- INSERT
    IF current_user = 'lde_app' THEN
        NEW.signer_id := public.lde_current_principal();
    END IF;
    NEW.signed_at := clock_timestamp();
    NEW.invalidated_at := NULL;
    NEW.invalidated_by_change_set := NULL;

    -- R05, R08: lock the run so a concurrent edge, note or node edit waits.
    SELECT r.state, r.signing_policy INTO run_state, policy
    FROM public.runs r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.entity_id FOR UPDATE;
    IF NOT FOUND OR run_state NOT IN ('completed', 'failed') THEN
        RAISE EXCEPTION 'run % does not exist or is not finished', NEW.entity_id USING ERRCODE = 'LDE07';
    END IF;

    -- R03: the signature binds the manifest of this run.
    SELECT * INTO manifest FROM public.signature_manifests m
    WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.manifest_id;
    IF NOT FOUND OR manifest.run_id <> NEW.entity_id
       OR manifest.manifest::jsonb ->> 'run_id' IS DISTINCT FROM NEW.entity_id::text
       OR manifest.sha256 IS DISTINCT FROM NEW.manifest_sha256 THEN
        RAISE EXCEPTION 'manifest does not match run % and the signed digest', NEW.entity_id USING ERRCODE = 'LDE07';
    END IF;

    -- R07, R16: an enabled human with a printed name.
    SELECT * INTO pr FROM public.principals p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.signer_id;
    IF NOT FOUND OR pr.kind <> 'human' OR NOT pr.enabled THEN
        RAISE EXCEPTION 'only an enabled human can sign' USING ERRCODE = 'LDE07';
    END IF;
    NEW.printed_name := pr.display_name;
    IF NEW.printed_name !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'signer % has no printed name', pr.handle USING ERRCODE = 'LDE07';
    END IF;

    -- R05: the next unsigned step, its meaning and its role.
    SELECT (e ->> 'step')::int, e ->> 'meaning', e ->> 'role' INTO next_step, next_mean, next_role
    FROM jsonb_array_elements(policy) e
    WHERE NOT EXISTS (
        SELECT 1 FROM public.signatures s
        WHERE s.tenant_id = NEW.tenant_id AND s.entity_type = 'run' AND s.entity_id = NEW.entity_id
          AND s.invalidated_at IS NULL AND s.step = (e ->> 'step')::int)
    ORDER BY (e ->> 'step')::int LIMIT 1;
    IF NOT FOUND OR NEW.step IS DISTINCT FROM next_step OR NEW.meaning IS DISTINCT FROM next_mean
       OR NOT public.lde_principal_holds(NEW.signer_id, next_role, NULL) THEN
        RAISE EXCEPTION 'run % is not awaiting this signature (step %, meaning %) from this signer', NEW.entity_id, NEW.step, NEW.meaning
            USING ERRCODE = 'LDE07';
    END IF;

    -- R06: four eyes.
    IF EXISTS (
        SELECT 1 FROM public.signatures s
        WHERE s.tenant_id = NEW.tenant_id AND s.entity_type = 'run' AND s.entity_id = NEW.entity_id
          AND s.invalidated_at IS NULL AND s.signer_id = NEW.signer_id
    ) THEN
        RAISE EXCEPTION 'signer already holds a valid signature on run %', NEW.entity_id USING ERRCODE = 'LDE07';
    END IF;

    IF NEW.reauth_at > NEW.signed_at THEN
        RAISE EXCEPTION 'reauthentication cannot follow the signature' USING ERRCODE = 'LDE07';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER signatures_guard
    BEFORE INSERT OR UPDATE OR DELETE ON signatures
    FOR EACH ROW EXECUTE FUNCTION signatures_reject_mutation();
CREATE TRIGGER signatures_no_truncate
    BEFORE TRUNCATE ON signatures
    FOR EACH STATEMENT EXECUTE FUNCTION signatures_reject_mutation();

-- SPEC-008-R01, R10
CREATE CONSTRAINT TRIGGER signatures_audited
    AFTER INSERT ON signatures DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION lde_require_audit('signature', 'signature.applied');
CREATE CONSTRAINT TRIGGER signatures_invalidated_audited
    AFTER UPDATE ON signatures DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (OLD.invalidated_at IS NULL AND NEW.invalidated_at IS NOT NULL)
    EXECUTE FUNCTION lde_require_audit('signature', '', 'signature.invalidated');

ALTER TABLE signature_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON signature_manifests TO lde_app
    USING (tenant_id = lde_current_tenant())
    WITH CHECK (tenant_id = lde_current_tenant());
ALTER TABLE signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON signatures TO lde_app
    USING (tenant_id = lde_current_tenant())
    WITH CHECK (tenant_id = lde_current_tenant());
DO $$
BEGIN
    EXECUTE format('CREATE POLICY owner_maintenance ON signature_manifests TO %I USING (true) WITH CHECK (true)', current_user);
    EXECUTE format('CREATE POLICY owner_maintenance ON signatures TO %I USING (true) WITH CHECK (true)', current_user);
END;
$$;
GRANT SELECT, INSERT (tenant_id, run_id, manifest) ON signature_manifests TO lde_app;
GRANT SELECT, INSERT, UPDATE (invalidated_at, invalidated_by_change_set) ON signatures TO lde_app;
