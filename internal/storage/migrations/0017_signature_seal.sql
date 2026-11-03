-- 0017_signature_seal: the first signature seals, the last one signs (SPEC-008).
--
-- A run's sealed set (SPEC-002) is now sealed from its first valid signature,
-- not only once it is `signed`. The run moves to `signed` when the last policy
-- step is signed, by a trigger on the signatures table; no statement by
-- lde_app can set `signed`. A correction that invalidates a signature returns
-- the run to the state it held before signing.

-- SPEC-008-R08: sealed when the run is signed or aborted, or holds a valid
-- signature, for its own node and the nodes it generated.
CREATE OR REPLACE FUNCTION lineage_node_sealed(node uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.runs r
        WHERE r.node_id = node
          AND (r.state IN ('signed', 'aborted')
               OR EXISTS (SELECT 1 FROM public.signatures s
                          WHERE s.tenant_id = r.tenant_id AND s.entity_type = 'run' AND s.entity_id = r.id
                            AND s.invalidated_at IS NULL))
    ) OR EXISTS (
        SELECT 1 FROM public.lineage_edges e
        JOIN public.runs r ON r.tenant_id = e.tenant_id AND r.node_id = e.from_id
        WHERE e.to_id = node AND e.relation = 'wasGeneratedBy'
          AND (r.state IN ('signed', 'aborted')
               OR EXISTS (SELECT 1 FROM public.signatures s
                          WHERE s.tenant_id = r.tenant_id AND s.entity_type = 'run' AND s.entity_id = r.id
                            AND s.invalidated_at IS NULL))
    )
$$;

-- SPEC-008-R08: lock the runs whose seal covers the node, so a node edit
-- can't land after a manifest is built (as notes_reject_mutation does).
CREATE OR REPLACE FUNCTION lineage_nodes_reject_sealed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM 1 FROM public.runs r
    WHERE r.tenant_id = OLD.tenant_id
      AND (r.node_id = OLD.id
           OR r.node_id IN (SELECT e.from_id FROM public.lineage_edges e
                            WHERE e.tenant_id = OLD.tenant_id AND e.to_id = OLD.id
                              AND e.relation = 'wasGeneratedBy'))
    FOR SHARE OF r;

    IF public.lineage_node_sealed(OLD.id) THEN
        RAISE EXCEPTION '% lineage node % is sealed (% rejected)', OLD.kind, OLD.id, TG_OP
            USING ERRCODE = 'LDE04';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

-- SPEC-008-R08: lde_app can't set `signed`; only signing does, through
-- signatures_settle_run. Everything else needs scientist, as before.
CREATE OR REPLACE FUNCTION runs_role_gate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF current_user = 'lde_app' AND TG_OP IN ('INSERT', 'UPDATE') AND NEW.state = 'signed'
       AND (TG_OP = 'INSERT' OR OLD.state <> 'signed') THEN
        RAISE EXCEPTION 'run state signed is set only by signing' USING ERRCODE = 'LDE07';
    END IF;
    PERFORM public.lde_require_role('scientist');
    RETURN COALESCE(NEW, OLD);
END;
$$;

-- SPEC-008-R08, R10: a signed run is immutable, except that invalidating a
-- signature in this transaction returns it to the state it held before
-- signing. A NULL signed_from can't match, so such a run stays signed.
CREATE OR REPLACE FUNCTION runs_reject_signed_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF OLD.state = 'signed' THEN
        IF TG_OP = 'UPDATE' AND NEW.state = OLD.signed_from AND NEW.signed_from IS NULL
           AND current_user <> 'lde_app'
           AND (NEW.id, NEW.tenant_id, NEW.experiment_id, NEW.protocol_version_id, NEW.node_id, NEW.params,
                NEW.started_at, NEW.finished_at, NEW.created_by, NEW.created_at, NEW.signing_policy)
               IS NOT DISTINCT FROM
               (OLD.id, OLD.tenant_id, OLD.experiment_id, OLD.protocol_version_id, OLD.node_id, OLD.params,
                OLD.started_at, OLD.finished_at, OLD.created_by, OLD.created_at, OLD.signing_policy)
           AND EXISTS (
                SELECT 1 FROM public.signatures s
                WHERE s.tenant_id = OLD.tenant_id AND s.entity_type = 'run' AND s.entity_id = OLD.id
                  AND s.invalidated_at IS NOT NULL AND s.xmin = pg_current_xact_id()::xid) THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'run % is signed and immutable', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    -- The seal depends on this row: moving node_id or state would lift it. So
    -- lde_app can't change a run that is aborted or holds a valid signature.
    IF current_user = 'lde_app' AND (TG_OP = 'DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
       AND (OLD.state = 'aborted' OR EXISTS (
            SELECT 1 FROM public.signatures s
            WHERE s.tenant_id = OLD.tenant_id AND s.entity_type = 'run' AND s.entity_id = OLD.id
              AND s.invalidated_at IS NULL)) THEN
        RAISE EXCEPTION 'run % is sealed (% rejected)', OLD.id, TG_OP USING ERRCODE = 'LDE04';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

-- SPEC-008-R08, R10: signs the run when its last policy step is signed, and
-- reopens it when an invalidation leaves a step unsigned. SECURITY DEFINER so
-- that it runs as the owner and passes the role gates and the lde_app-only
-- stamps on signed_from.
CREATE FUNCTION signatures_settle_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    valid  int;
    needed int;
    cur    text;
BEGIN
    SELECT r.state, jsonb_array_length(r.signing_policy) INTO cur, needed
    FROM public.runs r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.entity_id
    FOR UPDATE OF r; -- a signature and an invalidation can't settle the run at once
    SELECT count(*) INTO valid FROM public.signatures s
    WHERE s.tenant_id = NEW.tenant_id AND s.entity_type = 'run' AND s.entity_id = NEW.entity_id
      AND s.invalidated_at IS NULL;

    IF TG_OP = 'INSERT' AND valid = needed THEN
        UPDATE public.runs SET signed_from = state, state = 'signed'
        WHERE tenant_id = NEW.tenant_id AND id = NEW.entity_id;
    ELSIF TG_OP = 'UPDATE' AND cur = 'signed' AND valid < needed THEN
        UPDATE public.runs SET state = signed_from, signed_from = NULL
        WHERE tenant_id = NEW.tenant_id AND id = NEW.entity_id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER signatures_settle_run
    AFTER INSERT OR UPDATE ON signatures
    FOR EACH ROW EXECUTE FUNCTION signatures_settle_run();

-- SPEC-008-R10: a correction invalidates every valid signature on the run, so a
-- re-signed step can't sit beside a signature on the old content. Checked at
-- commit, once all of them have been updated.
CREATE FUNCTION signatures_invalidate_all() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.signatures s
        WHERE s.tenant_id = NEW.tenant_id AND s.entity_type = NEW.entity_type AND s.entity_id = NEW.entity_id
          AND s.invalidated_at IS NULL) THEN
        RAISE EXCEPTION 'run % still has a valid signature: a correction invalidates all of them', NEW.entity_id
            USING ERRCODE = 'LDE07';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER signatures_invalidated_together
    AFTER UPDATE ON signatures DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (OLD.invalidated_at IS NULL AND NEW.invalidated_at IS NOT NULL)
    EXECUTE FUNCTION signatures_invalidate_all();
