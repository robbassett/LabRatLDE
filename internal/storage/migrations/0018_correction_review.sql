-- 0018_correction_review: who may commit a correction, who may change a policy (SPEC-008).
--
-- A change set that touches a sealed run is a correction. A reviewer or QA
-- commits it, never its author (or the human its agent proposed it for), and
-- the commit stamps it review = 'correction'. A change set that sets a signing
-- policy needs the policy role (QA or admin in a GxP tenant, a reviewer
-- elsewhere) and is stamped 'policy'. The stamp stands in for the scientist role
-- only where its work needs it: a correction on nodes, edges and notes and on
-- the params of the runs it names, a policy change on updates to experiments.
-- Nothing here is SECURITY DEFINER.

-- SPEC-008-R09: who a change set was proposed for, when an agent proposed it.
-- review is stamped by the guard, and never granted for update.
ALTER TABLE change_sets ADD COLUMN author_for uuid;
ALTER TABLE change_sets ADD FOREIGN KEY (tenant_id, author_for) REFERENCES principals (tenant_id, id);
ALTER TABLE change_sets ADD COLUMN review text CHECK (review IN ('correction', 'policy'));

-- SPEC-008-R15: raises LDE05 as lde_app unless the current principal may change
-- a signing policy. A no-op for the owner.
CREATE FUNCTION lde_require_signing_policy_role(t uuid) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF (SELECT gxp FROM public.tenants WHERE id = t) IS NOT FALSE THEN
        PERFORM public.lde_require_role('qa', 'admin');
    ELSE
        PERFORM public.lde_require_role('reviewer', 'qa', 'admin');
    END IF;
END;
$$;

-- SPEC-008-R09: whether this transaction committed the change set that
-- app.change_set_id names, as a reviewed commit of this kind by the current
-- principal.
CREATE FUNCTION lde_reviewed_commit(kind text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.change_sets c
        WHERE c.id = NULLIF(current_setting('app.change_set_id', true), '')::uuid
          AND c.state = 'committed' AND c.review = kind
          AND c.decided_by = public.lde_current_principal()
          AND c.xmin = pg_current_xact_id()::xid
    )
$$;

GRANT EXECUTE ON FUNCTION lde_require_signing_policy_role(uuid), lde_reviewed_commit(text) TO lde_app;

-- SPEC-008-R09: invalidating needs a correction that this principal reviewed.
-- Without this, a change set committed before the run was signed, or by someone
-- else in this transaction, could strip its signatures.
CREATE FUNCTION signatures_invalidation_reviewed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF current_user = 'lde_app' AND NOT EXISTS (
        SELECT 1 FROM public.change_sets c
        WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.invalidated_by_change_set
          AND c.review = 'correction' AND c.decided_by = public.lde_current_principal()
    ) THEN
        RAISE EXCEPTION 'signature % can be invalidated only by a correction this principal reviewed', NEW.id
            USING ERRCODE = 'LDE07';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER signatures_invalidation_reviewed
    BEFORE UPDATE ON signatures
    FOR EACH ROW WHEN (OLD.invalidated_at IS NULL)
    EXECUTE FUNCTION signatures_invalidation_reviewed();

-- SPEC-008-R09, R15: as 0011, plus the correction and policy rules for
-- committing and rejecting.
CREATE OR REPLACE FUNCTION change_sets_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    decided boolean;
    sealed  boolean := false;
    policy  boolean := false;
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'change sets are never removed (TRUNCATE rejected)' USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'change set % is never removed (DELETE rejected)', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.state NOT IN ('proposed', 'committed') THEN
            RAISE EXCEPTION 'change set % cannot be created % (only proposed or committed)', NEW.id, NEW.state
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        IF OLD.state <> 'proposed' THEN
            RAISE EXCEPTION 'change set % is % and cannot change', OLD.id, OLD.state USING ERRCODE = 'LDE03';
        END IF;
        IF (NEW.id, NEW.tenant_id, NEW.source, NEW.author, NEW.author_id, NEW.author_for, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.tenant_id, OLD.source, OLD.author, OLD.author_id, OLD.author_for, OLD.created_at) THEN
            RAISE EXCEPTION 'change set % (%): identity and authorship never change', OLD.id, OLD.state
                USING ERRCODE = 'LDE03';
        END IF;
        IF current_user = 'lde_app' AND NEW.state IN ('proposed', 'withdrawn')
           AND public.lde_current_principal() IS DISTINCT FROM OLD.author_id THEN
            RAISE EXCEPTION 'change set % (%): only its author may replace or withdraw it', OLD.id, OLD.state
                USING ERRCODE = 'LDE05';
        END IF;
        -- An agent with two delegators can't move a proposal to the other human.
        IF current_user = 'lde_app' AND NEW.state IN ('proposed', 'withdrawn')
           AND public.lde_on_behalf_of() IS DISTINCT FROM OLD.author_for THEN
            RAISE EXCEPTION 'change set % (%): it was proposed for someone else', OLD.id, OLD.state
                USING ERRCODE = 'LDE05';
        END IF;
        IF NEW.state <> 'proposed' AND (NEW.title, NEW.reason, NEW.items) IS DISTINCT FROM (OLD.title, OLD.reason, OLD.items) THEN
            RAISE EXCEPTION 'change set % (%): title, reason and items cannot change when it is decided', OLD.id, OLD.state
                USING ERRCODE = 'LDE03';
        END IF;
    END IF;

    decided := NEW.state IN ('committed', 'rejected');
    IF decided AND current_user = 'lde_app' THEN
        sealed := EXISTS (SELECT 1 FROM public.change_set_touched_runs(NEW.tenant_id, NEW.items));
        policy := EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.items) i WHERE i ->> 'op' = 'set_signing_policy');
    END IF;
    IF sealed AND policy THEN
        RAISE EXCEPTION 'change set %: a correction and a signing policy change go in separate change sets', NEW.id
            USING ERRCODE = 'LDE07';
    END IF;
    IF sealed OR policy THEN
        PERFORM public.lde_require_human();
        IF sealed THEN
            IF NOT (public.lde_has_role('reviewer') OR public.lde_has_role('qa')) THEN
                RAISE EXCEPTION 'change set %: a correction to a signed run needs a reviewer or QA', NEW.id
                    USING ERRCODE = 'LDE07';
            END IF;
            -- An INSERT as committed is a direct edit, so its author is the committer.
            IF NEW.state = 'committed' AND (TG_OP = 'INSERT'
               OR public.lde_current_principal() IN (NEW.author_id, NEW.author_for)) THEN
                RAISE EXCEPTION 'change set %: a correction to a signed run is committed by someone other than its author', NEW.id
                    USING ERRCODE = 'LDE07';
            END IF;
        END IF;
        IF policy THEN
            PERFORM public.lde_require_signing_policy_role(NEW.tenant_id);
        END IF;
    ELSE
        PERFORM public.lde_require_role('scientist');
    END IF;
    IF decided THEN
        PERFORM public.lde_require_human();
    END IF;
    IF current_user = 'lde_app' THEN
        IF TG_OP = 'INSERT' THEN
            NEW.author_id := public.lde_current_principal();
            NEW.author_for := public.lde_on_behalf_of();
            NEW.source := CASE (SELECT kind FROM public.principals WHERE id = NEW.author_id)
                WHEN 'agent' THEN 'agent'
                WHEN 'service' THEN 'parser'
                ELSE 'human'
            END;
            NEW.created_at := clock_timestamp();
        END IF;
        NEW.review := CASE WHEN NEW.state <> 'committed' THEN NULL
                           WHEN sealed THEN 'correction'
                           WHEN policy THEN 'policy' END;
        IF NEW.state <> 'proposed' THEN
            NEW.decided_by := public.lde_current_principal();
            NEW.decided_at := clock_timestamp();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- SPEC-008-R15: the guard above checks the change set; this checks the column,
-- so an empty change set can't get a scientist past it.
CREATE FUNCTION experiments_policy_gate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM public.lde_require_signing_policy_role(NEW.tenant_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER experiments_policy_gate
    BEFORE UPDATE ON experiments
    FOR EACH ROW WHEN (OLD.signing_policy IS DISTINCT FROM NEW.signing_policy)
    EXECUTE FUNCTION experiments_policy_gate();

-- SPEC-008-R09, R15: as 0009, except that a reviewed commit passes on the tables
-- its work needs: a correction on nodes, edges and notes, a policy change on
-- updates to experiments. Instruments, readings and protocols always need a
-- scientist.
CREATE OR REPLACE FUNCTION lab_records_require_scientist() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP <> 'DELETE' AND TG_TABLE_NAME IN ('lineage_nodes', 'lineage_edges', 'notes')
       AND public.lde_reviewed_commit('correction') THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'experiments' AND public.lde_reviewed_commit('policy') THEN
        RETURN NULL;
    END IF;
    PERFORM public.lde_require_role('scientist');
    RETURN NULL;
END;
$$;

-- SPEC-008-R09: as 0017, plus two things. A run's node and experiment never
-- change, because the seal and the items of a correction resolve through them.
-- A correction passes the scientist check only to change the params of a run it
-- names, so it can't change a run's state or reach an unrelated run.
CREATE OR REPLACE FUNCTION runs_role_gate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF current_user = 'lde_app' AND TG_OP IN ('INSERT', 'UPDATE') AND NEW.state = 'signed'
       AND (TG_OP = 'INSERT' OR OLD.state <> 'signed') THEN
        RAISE EXCEPTION 'run state signed is set only by signing' USING ERRCODE = 'LDE07';
    END IF;
    IF current_user = 'lde_app' AND TG_OP = 'UPDATE'
       AND (NEW.node_id, NEW.experiment_id) IS DISTINCT FROM (OLD.node_id, OLD.experiment_id) THEN
        RAISE EXCEPTION 'run %: its node and experiment never change', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'UPDATE' AND to_jsonb(NEW) - 'params' = to_jsonb(OLD) - 'params'
       AND public.lde_reviewed_commit('correction')
       AND EXISTS (
            SELECT 1 FROM public.change_sets c, jsonb_array_elements(c.items) i
            WHERE c.id = NULLIF(current_setting('app.change_set_id', true), '')::uuid
              AND i ->> 'op' = 'update_run_params' AND i ->> 'run_id' = NEW.id::text) THEN
        RETURN NEW;
    END IF;
    PERFORM public.lde_require_role('scientist');
    RETURN COALESCE(NEW, OLD);
END;
$$;
