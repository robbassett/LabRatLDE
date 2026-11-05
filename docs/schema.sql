--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: agent_delegations_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_delegations_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'agent delegations are never removed (TRUNCATE rejected)' USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'agent delegation % is never removed (DELETE rejected)', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.ended_at IS NOT NULL THEN
            RAISE EXCEPTION 'agent delegation % has already ended', OLD.id USING ERRCODE = 'LDE03';
        END IF;
        IF (NEW.id, NEW.tenant_id, NEW.agent_id, NEW.human_id, NEW.reason, NEW.created_by, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.tenant_id, OLD.agent_id, OLD.human_id, OLD.reason, OLD.created_by, OLD.created_at) THEN
            RAISE EXCEPTION 'agent delegation %: only the ending may change', OLD.id USING ERRCODE = 'LDE03';
        END IF;
    END IF;
    PERFORM lde_require_role('admin');
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM principals WHERE id = NEW.agent_id AND kind = 'agent') THEN
            RAISE EXCEPTION 'delegation agent % is not an agent principal', NEW.agent_id USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM principals WHERE id = NEW.human_id AND kind = 'human') THEN
            RAISE EXCEPTION 'delegation human % is not a human principal', NEW.human_id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF current_user = 'lde_app' THEN
        IF TG_OP = 'INSERT' THEN
            NEW.created_by := lde_current_principal();
            NEW.created_at := clock_timestamp();
        ELSE
            NEW.ended_by := lde_current_principal();
            NEW.ended_at := clock_timestamp();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: audit_digest(uuid, bigint, timestamp with time zone, text, text, text, text, text, text, bytea); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_digest(p_tenant uuid, p_seq bigint, p_at timestamp with time zone, p_actor text, p_action text, p_entity_type text, p_entity_id text, p_reason text, p_payload text, p_prev bytea) RETURNS bytea
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
    SELECT sha256(
        convert_to('LDE-AUDIT-v1', 'UTF8')
        || int8send(p_seq)
        || int8send((EXTRACT(epoch FROM p_at) * 1000000)::bigint)
        || audit_lp(p_tenant::text)
        || audit_lp(p_actor)
        || audit_lp(p_action)
        || audit_lp(p_entity_type)
        || audit_lp(p_entity_id)
        || audit_lp(p_reason)
        || audit_lp(p_payload)
        || p_prev
    )
$$;


--
-- Name: audit_events_link(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_events_link() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    head audit_chain_heads%ROWTYPE;
BEGIN
    SELECT * INTO head FROM audit_chain_heads WHERE tenant_id = NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN
        head.seq  := 0;
        head.hash := decode(repeat('00', 32), 'hex');
    END IF;

    IF NEW.seq <> head.seq + 1 OR NEW.prev_hash <> head.hash THEN
        RAISE EXCEPTION 'audit event (tenant %, seq %) does not extend chain head %',
            NEW.tenant_id, NEW.seq, head.seq USING ERRCODE = 'LDE02';
    END IF;

    IF NEW.hash <> audit_digest(NEW.tenant_id, NEW.seq, NEW.occurred_at, NEW.actor, NEW.action,
                                NEW.entity_type, NEW.entity_id, NEW.reason, NEW.payload, NEW.prev_hash) THEN
        RAISE EXCEPTION 'audit event (tenant %, seq %) hash does not match content',
            NEW.tenant_id, NEW.seq USING ERRCODE = 'LDE02';
    END IF;

    -- Computer-generated timestamps (11.10(e)): must be "now" by our clock.
    IF NEW.occurred_at > clock_timestamp() OR NEW.occurred_at < clock_timestamp() - interval '1 minute' THEN
        RAISE EXCEPTION 'audit event timestamp % is not current', NEW.occurred_at USING ERRCODE = 'LDE02';
    END IF;

    INSERT INTO audit_chain_heads (tenant_id, seq, hash) VALUES (NEW.tenant_id, NEW.seq, NEW.hash)
    ON CONFLICT (tenant_id) DO UPDATE SET seq = EXCLUDED.seq, hash = EXCLUDED.hash;
    RETURN NEW;
END;
$$;


--
-- Name: audit_lp(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_lp(t text) RETURNS bytea
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
    SELECT int8send(octet_length(convert_to(t, 'UTF8'))::bigint) || convert_to(t, 'UTF8')
$$;


--
-- Name: audit_reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'audit ledger is append-only (% rejected)', TG_OP USING ERRCODE = 'LDE03';
END;
$$;


--
-- Name: audit_verify_chain(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_verify_chain(p_tenant uuid) RETURNS TABLE(events bigint, head_seq bigint, head_hash text, broken_at bigint)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    ev        audit_events%ROWTYPE;
    prev_seq  bigint := 0;
    prev_hash bytea  := decode(repeat('00', 32), 'hex');
BEGIN
    events := 0;
    FOR ev IN SELECT * FROM audit_events WHERE tenant_id = p_tenant ORDER BY seq LOOP
        IF ev.seq <> prev_seq + 1 OR ev.prev_hash <> prev_hash
           OR ev.hash <> audit_digest(ev.tenant_id, ev.seq, ev.occurred_at, ev.actor, ev.action,
                                      ev.entity_type, ev.entity_id, ev.reason, ev.payload, ev.prev_hash) THEN
            broken_at := ev.seq;
            EXIT;
        END IF;
        events    := events + 1;
        prev_seq  := ev.seq;
        prev_hash := ev.hash;
    END LOOP;
    head_seq  := prev_seq;
    head_hash := encode(prev_hash, 'hex');
    RETURN NEXT;
END;
$$;


--
-- Name: change_set_touched_runs(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.change_set_touched_runs(t uuid, items jsonb) RETURNS SETOF uuid
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: change_sets_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.change_sets_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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
    IF sealed AND policy AND NEW.state = 'committed' THEN
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


--
-- Name: experiments_default_signing_policy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.experiments_default_signing_policy() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
    IF current_user = 'lde_app' THEN
        NEW.signing_policy := '[{"step":1,"meaning":"author","role":"scientist"},{"step":2,"meaning":"review","role":"reviewer"}]'::jsonb;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: experiments_policy_gate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.experiments_policy_gate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
    PERFORM public.lde_require_signing_policy_role(NEW.tenant_id);
    RETURN NEW;
END;
$$;


--
-- Name: instrument_readings_reject_sealed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.instrument_readings_reject_sealed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    ds uuid;
BEGIN
    FOR ds IN SELECT DISTINCT dataset_id FROM new_readings LOOP
        IF lineage_node_sealed(ds) THEN
            RAISE EXCEPTION 'dataset % is sealed and cannot gain readings', ds
                USING ERRCODE = 'LDE04';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM lineage_nodes n
            WHERE n.id = ds AND n.xmin = pg_current_xact_id()::xid
        ) THEN
            RAISE EXCEPTION 'dataset % was created by another transaction and cannot gain readings', ds
                USING ERRCODE = 'LDE04';
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;


--
-- Name: lab_records_require_scientist(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lab_records_require_scientist() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: lde_current_principal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_current_principal() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
    SELECT NULLIF(current_setting('app.principal_id', true), '')::uuid
$$;


--
-- Name: lde_current_tenant(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_current_tenant() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
    SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;


--
-- Name: lde_has_role(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_has_role(r text, s text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT CASE (SELECT kind FROM principals WHERE id = lde_current_principal())
        WHEN 'agent' THEN
            lde_principal_holds(lde_current_principal(), r, s)
            AND lde_principal_holds(lde_on_behalf_of(), r, s)
            AND EXISTS (
                SELECT 1 FROM agent_delegations d
                JOIN principals h ON h.tenant_id = d.tenant_id AND h.id = d.human_id
                WHERE d.agent_id = lde_current_principal() AND d.human_id = lde_on_behalf_of()
                  AND d.ended_at IS NULL AND h.kind = 'human'
            )
        ELSE lde_principal_holds(lde_current_principal(), r, s)
    END
$$;


--
-- Name: lde_has_text(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_has_text(t text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT t ~ '[^[:space:]\u00A0\u1680\u180E\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]'
$$;


--
-- Name: lde_on_behalf_of(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_on_behalf_of() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
    SELECT NULLIF(current_setting('app.on_behalf_of', true), '')::uuid
$$;


--
-- Name: lde_principal_holds(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_principal_holds(p uuid, r text, s text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM principals pr
        JOIN role_grants g ON g.tenant_id = pr.tenant_id AND g.principal_id = pr.id
        WHERE pr.id = p AND pr.enabled
          AND g.revoked_at IS NULL AND g.role = r AND g.scope IS NOT DISTINCT FROM s
    )
$$;


--
-- Name: lde_require_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_require_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    actions text[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        actions := ARRAY[TG_ARGV[1]];
    ELSE
        actions := TG_ARGV[2:TG_NARGS - 1];
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM audit_events a
        WHERE a.tenant_id = NEW.tenant_id AND a.entity_type = TG_ARGV[0] AND a.entity_id = NEW.id::text
          AND a.action = ANY (actions) AND a.xmin = pg_current_xact_id()::xid
    ) THEN
        RAISE EXCEPTION '% % changed without a % audit event in its transaction',
            TG_ARGV[0], NEW.id, array_to_string(actions, ' or ') USING ERRCODE = 'LDE02';
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: lde_require_human(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_require_human() RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    IF current_user = 'lde_app' AND NOT EXISTS (
        SELECT 1 FROM principals pr
        WHERE pr.id = lde_current_principal() AND pr.kind = 'human' AND pr.enabled
    ) THEN
        RAISE EXCEPTION 'only a human may commit or reject a change set' USING ERRCODE = 'LDE05';
    END IF;
END;
$$;


--
-- Name: lde_require_role(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_require_role(VARIADIC roles text[]) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    IF current_user = 'lde_app' AND NOT EXISTS (SELECT 1 FROM unnest(roles) r WHERE lde_has_role(r)) THEN
        RAISE EXCEPTION 'role denied: needs %', array_to_string(roles, ' or ') USING ERRCODE = 'LDE05';
    END IF;
END;
$$;


--
-- Name: lde_require_signing_policy_role(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_require_signing_policy_role(t uuid) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
    IF (SELECT gxp FROM public.tenants WHERE id = t) IS NOT FALSE THEN
        PERFORM public.lde_require_role('qa', 'admin');
    ELSE
        PERFORM public.lde_require_role('reviewer', 'qa', 'admin');
    END IF;
END;
$$;


--
-- Name: lde_reviewed_commit(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lde_reviewed_commit(kind text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.change_sets c
        WHERE c.id = NULLIF(current_setting('app.change_set_id', true), '')::uuid
          AND c.state = 'committed' AND c.review = kind
          AND c.decided_by = public.lde_current_principal()
          AND c.xmin = pg_current_xact_id()::xid
    )
$$;


--
-- Name: lineage_edges_reject_sealed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lineage_edges_reject_sealed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Lock every run whose seal this edge depends on, so a concurrent sign
    -- waits for this transaction (or this check sees the committed sign).
    PERFORM 1 FROM runs r
    WHERE r.tenant_id = NEW.tenant_id
      AND (r.node_id = NEW.to_id
           OR (NEW.relation = 'wasGeneratedBy' AND r.node_id = NEW.from_id)
           OR r.node_id IN (SELECT e.from_id FROM lineage_edges e
                            WHERE e.tenant_id = NEW.tenant_id AND e.to_id = NEW.to_id
                              AND e.relation = 'wasGeneratedBy'))
    FOR SHARE OF r;

    IF lineage_node_sealed(NEW.to_id) THEN
        RAISE EXCEPTION 'lineage node % is sealed and cannot gain inputs', NEW.to_id
            USING ERRCODE = 'LDE04';
    END IF;
    IF NEW.relation = 'wasGeneratedBy' AND lineage_node_sealed(NEW.from_id) THEN
        RAISE EXCEPTION 'lineage node % is sealed and cannot generate new outputs', NEW.from_id
            USING ERRCODE = 'LDE04';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: lineage_node_sealed(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lineage_node_sealed(node uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: lineage_nodes_reject_sealed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lineage_nodes_reject_sealed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: lineage_reject_cycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lineage_reject_cycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Serialise edge writes per tenant so two concurrent inserts can't each
    -- pass the check and jointly close a loop.
    PERFORM pg_advisory_xact_lock(hashtextextended('lde.lineage:' || NEW.tenant_id::text, 0));
    IF EXISTS (
        WITH RECURSIVE downstream (id) AS (
            SELECT NEW.to_id
            UNION
            SELECT e.to_id
            FROM lineage_edges e
            JOIN downstream d ON e.tenant_id = NEW.tenant_id AND e.from_id = d.id
        )
        SELECT 1 FROM downstream WHERE id = NEW.from_id
    ) THEN
        RAISE EXCEPTION 'lineage edge % -> % would create a cycle', NEW.from_id, NEW.to_id
            USING ERRCODE = 'LDE01';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: notes_reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notes_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
    tid  uuid;
    node uuid;
BEGIN
    IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'notes cannot be deleted (% rejected)', TG_OP USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'INSERT' THEN
        tid := NEW.tenant_id;
        node := NEW.node_id;
    ELSE
        tid := OLD.tenant_id;
        node := OLD.node_id;
    END IF;

    -- Lock every run whose seal covers this node, so a concurrent sign waits
    -- for this transaction (or this check sees the committed sign).
    PERFORM 1 FROM public.runs r
    WHERE r.tenant_id = tid
      AND (r.node_id = node
           OR r.node_id IN (SELECT e.from_id FROM public.lineage_edges e
                            WHERE e.tenant_id = tid AND e.to_id = node
                              AND e.relation = 'wasGeneratedBy'))
    FOR SHARE OF r;

    IF TG_OP = 'INSERT' THEN
        NEW.annotation := public.lineage_node_sealed(NEW.node_id);
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.annotation IS DISTINCT FROM OLD.annotation
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'only the body of note % can change', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF NOT OLD.annotation AND public.lineage_node_sealed(OLD.node_id) THEN
        RAISE EXCEPTION 'note % was written before its node was sealed and is frozen', OLD.id
            USING ERRCODE = 'LDE04';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: principals_admin_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.principals_admin_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM lde_require_role('admin');
    RETURN NEW;
END;
$$;


--
-- Name: principals_reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.principals_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: protocol_sha256(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protocol_sha256(t text) RETURNS bytea
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
    SELECT sha256(convert_to(t, 'UTF8'))
$$;


--
-- Name: protocol_versions_gapless(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protocol_versions_gapless() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.version <> COALESCE((SELECT max(version) FROM protocol_versions
                                WHERE tenant_id = NEW.tenant_id AND experiment_id = NEW.experiment_id), 0) + 1 THEN
        RAISE EXCEPTION 'protocol version % of experiment % is not the next version', NEW.version, NEW.experiment_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: protocol_versions_reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protocol_versions_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'protocol versions are immutable (TRUNCATE rejected)' USING ERRCODE = 'LDE03';
    END IF;
    RAISE EXCEPTION 'protocol version % is immutable (% rejected)', OLD.id, TG_OP USING ERRCODE = 'LDE03';
END;
$$;


--
-- Name: record_revise(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_revise() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
    val     jsonb;
    cs      public.change_sets%ROWTYPE;
    setting text := current_setting('app.change_set_id', true);
BEGIN
    SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) INTO val FROM unnest(TG_ARGV[1:TG_NARGS - 1]) k;
    IF TG_OP = 'UPDATE' THEN
        IF val = (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(TG_ARGV[1:TG_NARGS - 1]) k) THEN
            RETURN NULL;
        END IF;
    END IF;
    IF setting IS NOT NULL AND setting <> '' THEN
        SELECT * INTO cs FROM public.change_sets c
        WHERE c.id = setting::uuid AND c.tenant_id = NEW.tenant_id AND c.state = 'committed'
          AND c.xmin = pg_current_xact_id()::xid;
    END IF;
    IF cs.id IS NULL AND (TG_OP = 'UPDATE' OR (setting IS NOT NULL AND setting <> '')) THEN
        RAISE EXCEPTION '% % changed outside a change set committed in this transaction', TG_ARGV[0], NEW.id
            USING ERRCODE = 'LDE03';
    END IF;
    INSERT INTO public.record_revisions (tenant_id, entity_type, entity_id, rev, value, author, reason, change_set_id, created_at)
    SELECT NEW.tenant_id, TG_ARGV[0], NEW.id, COALESCE(max(r.rev), 0) + 1, val,
           COALESCE(cs.author, NEW.created_by), COALESCE(cs.reason, 'created'), cs.id, clock_timestamp()
    FROM public.record_revisions r
    WHERE r.tenant_id = NEW.tenant_id AND r.entity_type = TG_ARGV[0] AND r.entity_id = NEW.id;
    RETURN NULL;
END;
$$;


--
-- Name: record_revisions_reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_revisions_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'revisions are append-only (% rejected)', TG_OP USING ERRCODE = 'LDE03';
END;
$$;


--
-- Name: role_grants_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.role_grants_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'role grants are never removed (TRUNCATE rejected)' USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'role grant % is never removed (DELETE rejected)', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.revoked_at IS NOT NULL THEN
            RAISE EXCEPTION 'role grant % is already revoked', OLD.id USING ERRCODE = 'LDE03';
        END IF;
        IF (NEW.id, NEW.tenant_id, NEW.principal_id, NEW.role, NEW.scope, NEW.reason, NEW.granted_by, NEW.granted_at)
           IS DISTINCT FROM
           (OLD.id, OLD.tenant_id, OLD.principal_id, OLD.role, OLD.scope, OLD.reason, OLD.granted_by, OLD.granted_at) THEN
            RAISE EXCEPTION 'role grant %: only the revocation may change', OLD.id USING ERRCODE = 'LDE03';
        END IF;
    END IF;
    PERFORM lde_require_role('admin');
    IF current_user = 'lde_app' THEN
        IF TG_OP = 'INSERT' THEN
            NEW.granted_by := lde_current_principal();
            NEW.granted_at := clock_timestamp();
        ELSE
            NEW.revoked_by := lde_current_principal();
            NEW.revoked_at := clock_timestamp();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: runs_copy_signing_policy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.runs_copy_signing_policy() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
    SELECT e.signing_policy INTO NEW.signing_policy
    FROM public.experiments e
    WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.experiment_id;
    NEW.signed_from := NULL;
    RETURN NEW;
END;
$$;


--
-- Name: runs_params_sealed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.runs_params_sealed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
    IF public.lineage_node_sealed(OLD.node_id) THEN
        RAISE EXCEPTION 'run % is sealed: its params cannot change', OLD.id USING ERRCODE = 'LDE04';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: runs_reject_repin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.runs_reject_repin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'run % protocol version is pinned', OLD.id USING ERRCODE = 'LDE03';
END;
$$;


--
-- Name: runs_reject_signed_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.runs_reject_signed_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: runs_role_gate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.runs_role_gate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
    IF current_user = 'lde_app' AND TG_OP IN ('INSERT', 'UPDATE') AND NEW.state = 'signed'
       AND (TG_OP = 'INSERT' OR OLD.state <> 'signed') THEN
        RAISE EXCEPTION 'run state signed is set only by signing' USING ERRCODE = 'LDE07';
    END IF;
    IF current_user = 'lde_app' AND TG_OP = 'UPDATE'
       AND (NEW.id, NEW.node_id, NEW.experiment_id) IS DISTINCT FROM (OLD.id, OLD.node_id, OLD.experiment_id) THEN
        RAISE EXCEPTION 'run %: its id, node and experiment never change', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    -- A new run on a sealed node would make a committed change set that names
    -- its id touch the run that sealed the node.
    IF current_user = 'lde_app' AND TG_OP = 'INSERT' AND public.lineage_node_sealed(NEW.node_id) THEN
        RAISE EXCEPTION 'lineage node % is sealed and cannot gain a run', NEW.node_id USING ERRCODE = 'LDE04';
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


--
-- Name: runs_signing_columns(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.runs_signing_columns() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: signature_challenges_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.signature_challenges_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: signature_manifests_reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.signature_manifests_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
    RAISE EXCEPTION 'signature manifests are append-only (% rejected)', TG_OP USING ERRCODE = 'LDE03';
END;
$$;


--
-- Name: signatures_invalidate_all(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.signatures_invalidate_all() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: signatures_invalidation_reviewed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.signatures_invalidation_reviewed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: signatures_reauth_bound(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.signatures_reauth_bound() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: signatures_reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.signatures_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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
    IF NOT public.lde_has_text(NEW.printed_name) THEN
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


--
-- Name: signatures_settle_run(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.signatures_settle_run() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: signing_policy_valid(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.signing_policy_valid(p jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: tenants_require_gxp_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tenants_require_gxp_audit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_delegations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_delegations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    human_id uuid NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_by uuid,
    ended_at timestamp with time zone,
    CONSTRAINT agent_delegations_check CHECK (((ended_at IS NULL) = (ended_by IS NULL))),
    CONSTRAINT agent_delegations_reason_check CHECK ((btrim(reason) <> ''::text))
);

ALTER TABLE ONLY public.agent_delegations FORCE ROW LEVEL SECURITY;


--
-- Name: audit_chain_heads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_chain_heads (
    tenant_id uuid NOT NULL,
    seq bigint NOT NULL,
    hash bytea NOT NULL
);

ALTER TABLE ONLY public.audit_chain_heads FORCE ROW LEVEL SECURITY;


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    tenant_id uuid NOT NULL,
    seq bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    payload text NOT NULL,
    payload_json jsonb GENERATED ALWAYS AS ((payload)::jsonb) STORED,
    prev_hash bytea NOT NULL,
    hash bytea NOT NULL,
    CONSTRAINT audit_events_action_check CHECK ((action <> ''::text)),
    CONSTRAINT audit_events_actor_check CHECK ((actor <> ''::text)),
    CONSTRAINT audit_events_hash_check CHECK ((octet_length(hash) = 32)),
    CONSTRAINT audit_events_prev_hash_check CHECK ((octet_length(prev_hash) = 32)),
    CONSTRAINT audit_events_seq_check CHECK ((seq > 0))
);

ALTER TABLE ONLY public.audit_events FORCE ROW LEVEL SECURITY;


--
-- Name: change_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.change_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    title text NOT NULL,
    reason text NOT NULL,
    source text DEFAULT 'human'::text NOT NULL,
    author text NOT NULL,
    author_id uuid,
    state text NOT NULL,
    items jsonb NOT NULL,
    items_sha256 bytea GENERATED ALWAYS AS (public.protocol_sha256((items)::text)) STORED,
    decided_by uuid,
    decided_at timestamp with time zone,
    decision_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    author_for uuid,
    review text,
    CONSTRAINT change_sets_check CHECK (((state = 'proposed'::text) = (decided_at IS NULL))),
    CONSTRAINT change_sets_check1 CHECK (((decided_at IS NULL) = (decided_by IS NULL))),
    CONSTRAINT change_sets_check2 CHECK (((state = 'proposed'::text) = (decision_reason IS NULL))),
    CONSTRAINT change_sets_decision_reason_check CHECK ((btrim(decision_reason) <> ''::text)),
    CONSTRAINT change_sets_items_check CHECK ((jsonb_typeof(items) = 'array'::text)),
    CONSTRAINT change_sets_reason_check CHECK ((btrim(reason) <> ''::text)),
    CONSTRAINT change_sets_review_check CHECK ((review = ANY (ARRAY['correction'::text, 'policy'::text]))),
    CONSTRAINT change_sets_source_check CHECK ((source = ANY (ARRAY['human'::text, 'parser'::text, 'agent'::text]))),
    CONSTRAINT change_sets_state_check CHECK ((state = ANY (ARRAY['proposed'::text, 'committed'::text, 'rejected'::text, 'withdrawn'::text]))),
    CONSTRAINT change_sets_title_check CHECK ((btrim(title) <> ''::text))
);

ALTER TABLE ONLY public.change_sets FORCE ROW LEVEL SECURITY;


--
-- Name: experiments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.experiments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    signing_policy jsonb DEFAULT '[{"role": "scientist", "step": 1, "meaning": "author"}, {"role": "reviewer", "step": 2, "meaning": "review"}]'::jsonb NOT NULL,
    CONSTRAINT experiments_signing_policy_check CHECK (public.signing_policy_valid(signing_policy)),
    CONSTRAINT experiments_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9._-]{0,127}$'::text))
);

ALTER TABLE ONLY public.experiments FORCE ROW LEVEL SECURITY;


--
-- Name: instrument_readings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instrument_readings (
    tenant_id uuid NOT NULL,
    instrument_id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    ts timestamp with time zone NOT NULL,
    channel text NOT NULL,
    value double precision NOT NULL,
    unit text DEFAULT ''::text NOT NULL
);

ALTER TABLE ONLY public.instrument_readings FORCE ROW LEVEL SECURITY;


--
-- Name: instruments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instruments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    node_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    attrs jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.instruments FORCE ROW LEVEL SECURITY;


--
-- Name: lineage_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lineage_edges (
    tenant_id uuid NOT NULL,
    from_id uuid NOT NULL,
    to_id uuid NOT NULL,
    relation text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lineage_edges_check CHECK ((from_id <> to_id)),
    CONSTRAINT lineage_edges_relation_check CHECK ((relation = ANY (ARRAY['used'::text, 'wasGeneratedBy'::text, 'wasDerivedFrom'::text, 'wasInformedBy'::text, 'wasAssociatedWith'::text, 'wasAttributedTo'::text])))
);

ALTER TABLE ONLY public.lineage_edges FORCE ROW LEVEL SECURITY;


--
-- Name: lineage_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lineage_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    attrs jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lineage_nodes_kind_check CHECK ((kind = ANY (ARRAY['sample'::text, 'reagent'::text, 'protocol'::text, 'run'::text, 'instrument'::text, 'dataset'::text, 'analysis'::text])))
);

ALTER TABLE ONLY public.lineage_nodes FORCE ROW LEVEL SECURITY;


--
-- Name: notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    node_id uuid NOT NULL,
    body text NOT NULL,
    annotation boolean DEFAULT false NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notes_body_check CHECK ((btrim(body) <> ''::text))
);

ALTER TABLE ONLY public.notes FORCE ROW LEVEL SECURITY;


--
-- Name: principals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.principals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    handle text NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT principals_handle_check CHECK ((handle ~ '^[a-z0-9][a-z0-9._@+-]{0,127}$'::text)),
    CONSTRAINT principals_issuer_check CHECK ((issuer <> ''::text)),
    CONSTRAINT principals_kind_check CHECK ((kind = ANY (ARRAY['human'::text, 'service'::text, 'agent'::text]))),
    CONSTRAINT principals_subject_check CHECK ((subject <> ''::text))
);

ALTER TABLE ONLY public.principals FORCE ROW LEVEL SECURITY;


--
-- Name: protocol_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.protocol_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    experiment_id uuid NOT NULL,
    version integer NOT NULL,
    protocol_md text NOT NULL,
    protocol_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    sha256 bytea GENERATED ALWAYS AS (public.protocol_sha256(protocol_md)) STORED,
    node_id uuid NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT protocol_versions_protocol_md_check CHECK ((protocol_md <> ''::text)),
    CONSTRAINT protocol_versions_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY public.protocol_versions FORCE ROW LEVEL SECURITY;


--
-- Name: record_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.record_revisions (
    tenant_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    rev integer NOT NULL,
    value jsonb NOT NULL,
    author text NOT NULL,
    reason text NOT NULL,
    change_set_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT record_revisions_entity_type_check CHECK ((entity_type = ANY (ARRAY['lineage_node'::text, 'run'::text, 'experiment'::text, 'note'::text]))),
    CONSTRAINT record_revisions_rev_check CHECK ((rev > 0))
);

ALTER TABLE ONLY public.record_revisions FORCE ROW LEVEL SECURITY;


--
-- Name: role_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    role text NOT NULL,
    scope text,
    reason text NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_by uuid,
    revoked_at timestamp with time zone,
    revoke_reason text,
    CONSTRAINT role_grants_check CHECK (((role = 'schema_steward'::text) = (scope IS NOT NULL))),
    CONSTRAINT role_grants_check1 CHECK ((((revoked_at IS NULL) = (revoked_by IS NULL)) AND ((revoked_at IS NULL) = (revoke_reason IS NULL)))),
    CONSTRAINT role_grants_reason_check CHECK ((btrim(reason) <> ''::text)),
    CONSTRAINT role_grants_revoke_reason_check CHECK ((btrim(revoke_reason) <> ''::text)),
    CONSTRAINT role_grants_role_check CHECK ((role = ANY (ARRAY['scientist'::text, 'reviewer'::text, 'qa'::text, 'admin'::text, 'schema_steward'::text])))
);

ALTER TABLE ONLY public.role_grants FORCE ROW LEVEL SECURITY;


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    experiment_id uuid NOT NULL,
    node_id uuid NOT NULL,
    state text DEFAULT 'planned'::text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    protocol_version_id uuid NOT NULL,
    signing_policy jsonb DEFAULT '[{"role": "scientist", "step": 1, "meaning": "author"}, {"role": "reviewer", "step": 2, "meaning": "review"}]'::jsonb NOT NULL,
    signed_from text,
    CONSTRAINT runs_signed_from_check CHECK ((signed_from = ANY (ARRAY['completed'::text, 'failed'::text]))),
    CONSTRAINT runs_signing_policy_check CHECK (public.signing_policy_valid(signing_policy)),
    CONSTRAINT runs_state_check CHECK ((state = ANY (ARRAY['planned'::text, 'running'::text, 'paused'::text, 'completed'::text, 'failed'::text, 'aborted'::text, 'signed'::text])))
);

ALTER TABLE ONLY public.runs FORCE ROW LEVEL SECURITY;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: signature_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signature_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    run_id uuid NOT NULL,
    manifest_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone,
    login_at timestamp with time zone,
    CONSTRAINT signature_challenges_manifest_sha256_check CHECK ((manifest_sha256 ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.signature_challenges FORCE ROW LEVEL SECURITY;


--
-- Name: signature_manifests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signature_manifests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    manifest text NOT NULL,
    sha256 bytea GENERATED ALWAYS AS (public.protocol_sha256(manifest)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.signature_manifests FORCE ROW LEVEL SECURITY;


--
-- Name: signatures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signatures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    step integer NOT NULL,
    meaning text NOT NULL,
    signer_id uuid NOT NULL,
    printed_name text NOT NULL,
    signed_at timestamp with time zone NOT NULL,
    manifest_id uuid NOT NULL,
    manifest_sha256 bytea NOT NULL,
    comment text,
    reauth_at timestamp with time zone NOT NULL,
    reauth_method text NOT NULL,
    invalidated_at timestamp with time zone,
    invalidated_by_change_set uuid,
    challenge_id uuid,
    CONSTRAINT signatures_check CHECK (((invalidated_at IS NULL) = (invalidated_by_change_set IS NULL))),
    CONSTRAINT signatures_entity_type_check CHECK ((entity_type = 'run'::text)),
    CONSTRAINT signatures_meaning_check CHECK ((meaning = ANY (ARRAY['author'::text, 'review'::text, 'approval'::text, 'verification'::text]))),
    CONSTRAINT signatures_printed_name_check CHECK (public.lde_has_text(printed_name)),
    CONSTRAINT signatures_reauth_method_check CHECK ((reauth_method = ANY (ARRAY['oidc'::text, 'dev'::text])))
);

ALTER TABLE ONLY public.signatures FORCE ROW LEVEL SECURITY;


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    gxp boolean DEFAULT true NOT NULL,
    CONSTRAINT tenants_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'::text))
);

ALTER TABLE ONLY public.tenants FORCE ROW LEVEL SECURITY;


--
-- Name: agent_delegations agent_delegations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_pkey PRIMARY KEY (id);


--
-- Name: agent_delegations agent_delegations_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: audit_chain_heads audit_chain_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_chain_heads
    ADD CONSTRAINT audit_chain_heads_pkey PRIMARY KEY (tenant_id);


--
-- Name: audit_events audit_events_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_hash_key UNIQUE (hash);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (tenant_id, seq);


--
-- Name: change_sets change_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_sets
    ADD CONSTRAINT change_sets_pkey PRIMARY KEY (id);


--
-- Name: change_sets change_sets_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_sets
    ADD CONSTRAINT change_sets_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: experiments experiments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.experiments
    ADD CONSTRAINT experiments_pkey PRIMARY KEY (id);


--
-- Name: experiments experiments_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.experiments
    ADD CONSTRAINT experiments_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: experiments experiments_tenant_id_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.experiments
    ADD CONSTRAINT experiments_tenant_id_slug_key UNIQUE (tenant_id, slug);


--
-- Name: instruments instruments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instruments
    ADD CONSTRAINT instruments_pkey PRIMARY KEY (id);


--
-- Name: instruments instruments_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instruments
    ADD CONSTRAINT instruments_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: instruments instruments_tenant_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instruments
    ADD CONSTRAINT instruments_tenant_id_name_key UNIQUE (tenant_id, name);


--
-- Name: lineage_edges lineage_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lineage_edges
    ADD CONSTRAINT lineage_edges_pkey PRIMARY KEY (tenant_id, from_id, to_id, relation);


--
-- Name: lineage_nodes lineage_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lineage_nodes
    ADD CONSTRAINT lineage_nodes_pkey PRIMARY KEY (id);


--
-- Name: lineage_nodes lineage_nodes_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lineage_nodes
    ADD CONSTRAINT lineage_nodes_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);


--
-- Name: notes notes_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: principals principals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_pkey PRIMARY KEY (id);


--
-- Name: principals principals_tenant_id_handle_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_tenant_id_handle_key UNIQUE (tenant_id, handle);


--
-- Name: principals principals_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: principals principals_tenant_id_issuer_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_tenant_id_issuer_subject_key UNIQUE (tenant_id, issuer, subject);


--
-- Name: protocol_versions protocol_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_versions
    ADD CONSTRAINT protocol_versions_pkey PRIMARY KEY (id);


--
-- Name: protocol_versions protocol_versions_tenant_id_experiment_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_versions
    ADD CONSTRAINT protocol_versions_tenant_id_experiment_id_id_key UNIQUE (tenant_id, experiment_id, id);


--
-- Name: protocol_versions protocol_versions_tenant_id_experiment_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_versions
    ADD CONSTRAINT protocol_versions_tenant_id_experiment_id_version_key UNIQUE (tenant_id, experiment_id, version);


--
-- Name: protocol_versions protocol_versions_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_versions
    ADD CONSTRAINT protocol_versions_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: protocol_versions protocol_versions_tenant_id_node_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_versions
    ADD CONSTRAINT protocol_versions_tenant_id_node_id_key UNIQUE (tenant_id, node_id);


--
-- Name: record_revisions record_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_revisions
    ADD CONSTRAINT record_revisions_pkey PRIMARY KEY (tenant_id, entity_type, entity_id, rev);


--
-- Name: role_grants role_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_grants
    ADD CONSTRAINT role_grants_pkey PRIMARY KEY (id);


--
-- Name: role_grants role_grants_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_grants
    ADD CONSTRAINT role_grants_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);


--
-- Name: runs runs_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: runs runs_tenant_id_node_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_tenant_id_node_id_key UNIQUE (tenant_id, node_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: signature_challenges signature_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_challenges
    ADD CONSTRAINT signature_challenges_pkey PRIMARY KEY (id);


--
-- Name: signature_challenges signature_challenges_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_challenges
    ADD CONSTRAINT signature_challenges_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: signature_manifests signature_manifests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_manifests
    ADD CONSTRAINT signature_manifests_pkey PRIMARY KEY (id);


--
-- Name: signature_manifests signature_manifests_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_manifests
    ADD CONSTRAINT signature_manifests_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: signatures signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_pkey PRIMARY KEY (id);


--
-- Name: signatures signatures_tenant_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_tenant_id_id_key UNIQUE (tenant_id, id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);


--
-- Name: agent_delegations_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_delegations_active ON public.agent_delegations USING btree (tenant_id, agent_id, human_id) WHERE (ended_at IS NULL);


--
-- Name: audit_events_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_entity ON public.audit_events USING btree (tenant_id, entity_type, entity_id, seq);


--
-- Name: change_sets_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX change_sets_state ON public.change_sets USING btree (tenant_id, state, created_at);


--
-- Name: instrument_readings_dataset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX instrument_readings_dataset ON public.instrument_readings USING btree (tenant_id, dataset_id);


--
-- Name: instrument_readings_series; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX instrument_readings_series ON public.instrument_readings USING btree (tenant_id, instrument_id, ts);


--
-- Name: lineage_edges_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lineage_edges_to ON public.lineage_edges USING btree (tenant_id, to_id);


--
-- Name: lineage_nodes_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lineage_nodes_kind ON public.lineage_nodes USING btree (tenant_id, kind);


--
-- Name: notes_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notes_node ON public.notes USING btree (tenant_id, node_id, created_at);


--
-- Name: protocol_versions_meta_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX protocol_versions_meta_gin ON public.protocol_versions USING gin (protocol_meta jsonb_path_ops);


--
-- Name: role_grants_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX role_grants_active ON public.role_grants USING btree (tenant_id, principal_id, role, COALESCE(scope, ''::text)) WHERE (revoked_at IS NULL);


--
-- Name: runs_experiment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_experiment ON public.runs USING btree (tenant_id, experiment_id);


--
-- Name: signature_challenges_one_per_login; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX signature_challenges_one_per_login ON public.signature_challenges USING btree (tenant_id, principal_id, login_at) WHERE (login_at IS NOT NULL);


--
-- Name: signatures_one_per_challenge; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX signatures_one_per_challenge ON public.signatures USING btree (tenant_id, challenge_id) WHERE (challenge_id IS NOT NULL);


--
-- Name: signatures_valid_step; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX signatures_valid_step ON public.signatures USING btree (tenant_id, entity_type, entity_id, step) WHERE (invalidated_at IS NULL);


--
-- Name: agent_delegations agent_delegations_audited; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER agent_delegations_audited AFTER INSERT OR UPDATE ON public.agent_delegations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.lde_require_audit('agent_delegation', 'delegation.created', 'delegation.ended');


--
-- Name: agent_delegations agent_delegations_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_delegations_guard BEFORE INSERT OR DELETE OR UPDATE ON public.agent_delegations FOR EACH ROW EXECUTE FUNCTION public.agent_delegations_guard();


--
-- Name: agent_delegations agent_delegations_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_delegations_no_truncate BEFORE TRUNCATE ON public.agent_delegations FOR EACH STATEMENT EXECUTE FUNCTION public.agent_delegations_guard();


--
-- Name: audit_events audit_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_events_append_only BEFORE DELETE OR UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.audit_reject_mutation();


--
-- Name: audit_events audit_events_link; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_events_link BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.audit_events_link();


--
-- Name: audit_events audit_events_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON public.audit_events FOR EACH STATEMENT EXECUTE FUNCTION public.audit_reject_mutation();


--
-- Name: audit_chain_heads audit_heads_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_heads_append_only BEFORE DELETE ON public.audit_chain_heads FOR EACH ROW EXECUTE FUNCTION public.audit_reject_mutation();


--
-- Name: audit_chain_heads audit_heads_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_heads_no_truncate BEFORE TRUNCATE ON public.audit_chain_heads FOR EACH STATEMENT EXECUTE FUNCTION public.audit_reject_mutation();


--
-- Name: change_sets change_sets_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER change_sets_guard BEFORE INSERT OR DELETE OR UPDATE ON public.change_sets FOR EACH ROW EXECUTE FUNCTION public.change_sets_guard();


--
-- Name: change_sets change_sets_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER change_sets_no_truncate BEFORE TRUNCATE ON public.change_sets FOR EACH STATEMENT EXECUTE FUNCTION public.change_sets_guard();


--
-- Name: experiments experiments_default_signing_policy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER experiments_default_signing_policy BEFORE INSERT ON public.experiments FOR EACH ROW EXECUTE FUNCTION public.experiments_default_signing_policy();


--
-- Name: experiments experiments_policy_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER experiments_policy_gate BEFORE UPDATE ON public.experiments FOR EACH ROW WHEN ((old.signing_policy IS DISTINCT FROM new.signing_policy)) EXECUTE FUNCTION public.experiments_policy_gate();


--
-- Name: experiments experiments_revisions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER experiments_revisions AFTER INSERT OR UPDATE ON public.experiments FOR EACH ROW EXECUTE FUNCTION public.record_revise('experiment', 'title', 'signing_policy');


--
-- Name: experiments experiments_role_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER experiments_role_gate BEFORE INSERT OR DELETE OR UPDATE ON public.experiments FOR EACH STATEMENT EXECUTE FUNCTION public.lab_records_require_scientist();


--
-- Name: instrument_readings instrument_readings_role_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER instrument_readings_role_gate BEFORE INSERT OR DELETE OR UPDATE ON public.instrument_readings FOR EACH STATEMENT EXECUTE FUNCTION public.lab_records_require_scientist();


--
-- Name: instrument_readings instrument_readings_sealed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER instrument_readings_sealed AFTER INSERT ON public.instrument_readings REFERENCING NEW TABLE AS new_readings FOR EACH STATEMENT EXECUTE FUNCTION public.instrument_readings_reject_sealed();


--
-- Name: instruments instruments_role_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER instruments_role_gate BEFORE INSERT OR DELETE OR UPDATE ON public.instruments FOR EACH STATEMENT EXECUTE FUNCTION public.lab_records_require_scientist();


--
-- Name: lineage_edges lineage_edges_acyclic; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lineage_edges_acyclic BEFORE INSERT ON public.lineage_edges FOR EACH ROW EXECUTE FUNCTION public.lineage_reject_cycle();


--
-- Name: lineage_edges lineage_edges_role_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lineage_edges_role_gate BEFORE INSERT OR DELETE OR UPDATE ON public.lineage_edges FOR EACH STATEMENT EXECUTE FUNCTION public.lab_records_require_scientist();


--
-- Name: lineage_edges lineage_edges_sealed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lineage_edges_sealed BEFORE INSERT ON public.lineage_edges FOR EACH ROW EXECUTE FUNCTION public.lineage_edges_reject_sealed();


--
-- Name: lineage_nodes lineage_nodes_revisions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lineage_nodes_revisions AFTER INSERT OR UPDATE ON public.lineage_nodes FOR EACH ROW EXECUTE FUNCTION public.record_revise('lineage_node', 'label', 'attrs');


--
-- Name: lineage_nodes lineage_nodes_role_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lineage_nodes_role_gate BEFORE INSERT OR DELETE OR UPDATE ON public.lineage_nodes FOR EACH STATEMENT EXECUTE FUNCTION public.lab_records_require_scientist();


--
-- Name: lineage_nodes lineage_nodes_sealed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lineage_nodes_sealed BEFORE DELETE OR UPDATE ON public.lineage_nodes FOR EACH ROW EXECUTE FUNCTION public.lineage_nodes_reject_sealed();


--
-- Name: notes notes_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notes_guard BEFORE INSERT OR DELETE OR UPDATE ON public.notes FOR EACH ROW EXECUTE FUNCTION public.notes_reject_mutation();


--
-- Name: notes notes_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notes_no_truncate BEFORE TRUNCATE ON public.notes FOR EACH STATEMENT EXECUTE FUNCTION public.notes_reject_mutation();


--
-- Name: notes notes_revisions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notes_revisions AFTER INSERT OR UPDATE ON public.notes FOR EACH ROW EXECUTE FUNCTION public.record_revise('note', 'body');


--
-- Name: notes notes_role_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notes_role_gate BEFORE INSERT OR DELETE OR UPDATE ON public.notes FOR EACH STATEMENT EXECUTE FUNCTION public.lab_records_require_scientist();


--
-- Name: principals principals_admin_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER principals_admin_only BEFORE INSERT OR UPDATE ON public.principals FOR EACH ROW EXECUTE FUNCTION public.principals_admin_only();


--
-- Name: principals principals_audited; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER principals_audited AFTER INSERT ON public.principals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.lde_require_audit('principal', 'principal.created');


--
-- Name: principals principals_enabled_audited; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER principals_enabled_audited AFTER UPDATE ON public.principals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((old.enabled IS DISTINCT FROM new.enabled)) EXECUTE FUNCTION public.lde_require_audit('principal', '', 'principal.enabled', 'principal.disabled');


--
-- Name: principals principals_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER principals_immutable BEFORE DELETE OR UPDATE ON public.principals FOR EACH ROW EXECUTE FUNCTION public.principals_reject_mutation();


--
-- Name: principals principals_name_audited; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER principals_name_audited AFTER UPDATE ON public.principals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((old.display_name IS DISTINCT FROM new.display_name)) EXECUTE FUNCTION public.lde_require_audit('principal', '', 'principal.renamed');


--
-- Name: principals principals_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER principals_no_truncate BEFORE TRUNCATE ON public.principals FOR EACH STATEMENT EXECUTE FUNCTION public.principals_reject_mutation();


--
-- Name: protocol_versions protocol_versions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER protocol_versions_append_only BEFORE DELETE OR UPDATE ON public.protocol_versions FOR EACH ROW EXECUTE FUNCTION public.protocol_versions_reject_mutation();


--
-- Name: protocol_versions protocol_versions_gapless; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER protocol_versions_gapless BEFORE INSERT ON public.protocol_versions FOR EACH ROW EXECUTE FUNCTION public.protocol_versions_gapless();


--
-- Name: protocol_versions protocol_versions_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER protocol_versions_no_truncate BEFORE TRUNCATE ON public.protocol_versions FOR EACH STATEMENT EXECUTE FUNCTION public.protocol_versions_reject_mutation();


--
-- Name: protocol_versions protocol_versions_role_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER protocol_versions_role_gate BEFORE INSERT OR DELETE OR UPDATE ON public.protocol_versions FOR EACH STATEMENT EXECUTE FUNCTION public.lab_records_require_scientist();


--
-- Name: record_revisions record_revisions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER record_revisions_append_only BEFORE DELETE OR UPDATE ON public.record_revisions FOR EACH ROW EXECUTE FUNCTION public.record_revisions_reject_mutation();


--
-- Name: record_revisions record_revisions_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER record_revisions_no_truncate BEFORE TRUNCATE ON public.record_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.record_revisions_reject_mutation();


--
-- Name: role_grants role_grants_audited; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER role_grants_audited AFTER INSERT OR UPDATE ON public.role_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.lde_require_audit('role_grant', 'role.granted', 'role.revoked');


--
-- Name: role_grants role_grants_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER role_grants_guard BEFORE INSERT OR DELETE OR UPDATE ON public.role_grants FOR EACH ROW EXECUTE FUNCTION public.role_grants_guard();


--
-- Name: role_grants role_grants_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER role_grants_no_truncate BEFORE TRUNCATE ON public.role_grants FOR EACH STATEMENT EXECUTE FUNCTION public.role_grants_guard();


--
-- Name: runs runs_copy_signing_policy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER runs_copy_signing_policy BEFORE INSERT ON public.runs FOR EACH ROW EXECUTE FUNCTION public.runs_copy_signing_policy();


--
-- Name: runs runs_params_sealed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER runs_params_sealed BEFORE UPDATE OF params ON public.runs FOR EACH ROW WHEN ((old.params IS DISTINCT FROM new.params)) EXECUTE FUNCTION public.runs_params_sealed();


--
-- Name: runs runs_protocol_pinned; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER runs_protocol_pinned BEFORE UPDATE OF protocol_version_id ON public.runs FOR EACH ROW WHEN ((old.protocol_version_id IS DISTINCT FROM new.protocol_version_id)) EXECUTE FUNCTION public.runs_reject_repin();


--
-- Name: runs runs_revisions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER runs_revisions AFTER INSERT OR UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.record_revise('run', 'params');


--
-- Name: runs runs_role_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER runs_role_gate BEFORE INSERT OR DELETE OR UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.runs_role_gate();


--
-- Name: runs runs_signed_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER runs_signed_immutable BEFORE DELETE OR UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.runs_reject_signed_mutation();


--
-- Name: runs runs_signing_columns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER runs_signing_columns BEFORE UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.runs_signing_columns();


--
-- Name: signature_challenges signature_challenges_audited; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER signature_challenges_audited AFTER INSERT ON public.signature_challenges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.lde_require_audit('signature_challenge', 'signature.challenge_issued');


--
-- Name: signature_challenges signature_challenges_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signature_challenges_guard BEFORE INSERT OR DELETE OR UPDATE ON public.signature_challenges FOR EACH ROW EXECUTE FUNCTION public.signature_challenges_guard();


--
-- Name: signature_challenges signature_challenges_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signature_challenges_no_truncate BEFORE TRUNCATE ON public.signature_challenges FOR EACH STATEMENT EXECUTE FUNCTION public.signature_challenges_guard();


--
-- Name: signature_manifests signature_manifests_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signature_manifests_append_only BEFORE DELETE OR UPDATE ON public.signature_manifests FOR EACH ROW EXECUTE FUNCTION public.signature_manifests_reject_mutation();


--
-- Name: signature_manifests signature_manifests_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signature_manifests_no_truncate BEFORE TRUNCATE ON public.signature_manifests FOR EACH STATEMENT EXECUTE FUNCTION public.signature_manifests_reject_mutation();


--
-- Name: signatures signatures_audited; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER signatures_audited AFTER INSERT ON public.signatures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.lde_require_audit('signature', 'signature.applied');


--
-- Name: signatures signatures_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signatures_guard BEFORE INSERT OR DELETE OR UPDATE ON public.signatures FOR EACH ROW EXECUTE FUNCTION public.signatures_reject_mutation();


--
-- Name: signatures signatures_invalidated_audited; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER signatures_invalidated_audited AFTER UPDATE ON public.signatures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.invalidated_at IS NULL) AND (new.invalidated_at IS NOT NULL))) EXECUTE FUNCTION public.lde_require_audit('signature', '', 'signature.invalidated');


--
-- Name: signatures signatures_invalidated_together; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER signatures_invalidated_together AFTER UPDATE ON public.signatures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.invalidated_at IS NULL) AND (new.invalidated_at IS NOT NULL))) EXECUTE FUNCTION public.signatures_invalidate_all();


--
-- Name: signatures signatures_invalidation_reviewed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signatures_invalidation_reviewed BEFORE UPDATE ON public.signatures FOR EACH ROW WHEN ((old.invalidated_at IS NULL)) EXECUTE FUNCTION public.signatures_invalidation_reviewed();


--
-- Name: signatures signatures_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signatures_no_truncate BEFORE TRUNCATE ON public.signatures FOR EACH STATEMENT EXECUTE FUNCTION public.signatures_reject_mutation();


--
-- Name: signatures signatures_reauth_bound; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signatures_reauth_bound BEFORE INSERT OR UPDATE ON public.signatures FOR EACH ROW EXECUTE FUNCTION public.signatures_reauth_bound();


--
-- Name: signatures signatures_settle_run; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signatures_settle_run AFTER INSERT OR UPDATE ON public.signatures FOR EACH ROW EXECUTE FUNCTION public.signatures_settle_run();


--
-- Name: tenants tenants_gxp_audited; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER tenants_gxp_audited AFTER UPDATE OF gxp ON public.tenants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((old.gxp IS DISTINCT FROM new.gxp)) EXECUTE FUNCTION public.tenants_require_gxp_audit();


--
-- Name: agent_delegations agent_delegations_tenant_id_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_tenant_id_agent_id_fkey FOREIGN KEY (tenant_id, agent_id) REFERENCES public.principals(tenant_id, id);


--
-- Name: agent_delegations agent_delegations_tenant_id_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_tenant_id_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES public.principals(tenant_id, id);


--
-- Name: agent_delegations agent_delegations_tenant_id_ended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_tenant_id_ended_by_fkey FOREIGN KEY (tenant_id, ended_by) REFERENCES public.principals(tenant_id, id);


--
-- Name: agent_delegations agent_delegations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: agent_delegations agent_delegations_tenant_id_human_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_tenant_id_human_id_fkey FOREIGN KEY (tenant_id, human_id) REFERENCES public.principals(tenant_id, id);


--
-- Name: audit_chain_heads audit_chain_heads_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_chain_heads
    ADD CONSTRAINT audit_chain_heads_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: audit_events audit_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: change_sets change_sets_tenant_id_author_for_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_sets
    ADD CONSTRAINT change_sets_tenant_id_author_for_fkey FOREIGN KEY (tenant_id, author_for) REFERENCES public.principals(tenant_id, id);


--
-- Name: change_sets change_sets_tenant_id_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_sets
    ADD CONSTRAINT change_sets_tenant_id_author_id_fkey FOREIGN KEY (tenant_id, author_id) REFERENCES public.principals(tenant_id, id);


--
-- Name: change_sets change_sets_tenant_id_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_sets
    ADD CONSTRAINT change_sets_tenant_id_decided_by_fkey FOREIGN KEY (tenant_id, decided_by) REFERENCES public.principals(tenant_id, id);


--
-- Name: change_sets change_sets_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_sets
    ADD CONSTRAINT change_sets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: experiments experiments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.experiments
    ADD CONSTRAINT experiments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: instrument_readings instrument_readings_tenant_id_dataset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_readings
    ADD CONSTRAINT instrument_readings_tenant_id_dataset_id_fkey FOREIGN KEY (tenant_id, dataset_id) REFERENCES public.lineage_nodes(tenant_id, id);


--
-- Name: instrument_readings instrument_readings_tenant_id_instrument_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_readings
    ADD CONSTRAINT instrument_readings_tenant_id_instrument_id_fkey FOREIGN KEY (tenant_id, instrument_id) REFERENCES public.instruments(tenant_id, id);


--
-- Name: instruments instruments_tenant_id_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instruments
    ADD CONSTRAINT instruments_tenant_id_node_id_fkey FOREIGN KEY (tenant_id, node_id) REFERENCES public.lineage_nodes(tenant_id, id);


--
-- Name: lineage_edges lineage_edges_tenant_id_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lineage_edges
    ADD CONSTRAINT lineage_edges_tenant_id_from_id_fkey FOREIGN KEY (tenant_id, from_id) REFERENCES public.lineage_nodes(tenant_id, id);


--
-- Name: lineage_edges lineage_edges_tenant_id_to_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lineage_edges
    ADD CONSTRAINT lineage_edges_tenant_id_to_id_fkey FOREIGN KEY (tenant_id, to_id) REFERENCES public.lineage_nodes(tenant_id, id);


--
-- Name: lineage_nodes lineage_nodes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lineage_nodes
    ADD CONSTRAINT lineage_nodes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: notes notes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: notes notes_tenant_id_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_tenant_id_node_id_fkey FOREIGN KEY (tenant_id, node_id) REFERENCES public.lineage_nodes(tenant_id, id);


--
-- Name: principals principals_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: protocol_versions protocol_versions_tenant_id_experiment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_versions
    ADD CONSTRAINT protocol_versions_tenant_id_experiment_id_fkey FOREIGN KEY (tenant_id, experiment_id) REFERENCES public.experiments(tenant_id, id);


--
-- Name: protocol_versions protocol_versions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_versions
    ADD CONSTRAINT protocol_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: protocol_versions protocol_versions_tenant_id_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_versions
    ADD CONSTRAINT protocol_versions_tenant_id_node_id_fkey FOREIGN KEY (tenant_id, node_id) REFERENCES public.lineage_nodes(tenant_id, id);


--
-- Name: record_revisions record_revisions_tenant_id_change_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_revisions
    ADD CONSTRAINT record_revisions_tenant_id_change_set_id_fkey FOREIGN KEY (tenant_id, change_set_id) REFERENCES public.change_sets(tenant_id, id);


--
-- Name: record_revisions record_revisions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_revisions
    ADD CONSTRAINT record_revisions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: role_grants role_grants_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_grants
    ADD CONSTRAINT role_grants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: role_grants role_grants_tenant_id_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_grants
    ADD CONSTRAINT role_grants_tenant_id_granted_by_fkey FOREIGN KEY (tenant_id, granted_by) REFERENCES public.principals(tenant_id, id);


--
-- Name: role_grants role_grants_tenant_id_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_grants
    ADD CONSTRAINT role_grants_tenant_id_principal_id_fkey FOREIGN KEY (tenant_id, principal_id) REFERENCES public.principals(tenant_id, id);


--
-- Name: role_grants role_grants_tenant_id_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_grants
    ADD CONSTRAINT role_grants_tenant_id_revoked_by_fkey FOREIGN KEY (tenant_id, revoked_by) REFERENCES public.principals(tenant_id, id);


--
-- Name: runs runs_tenant_id_experiment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_tenant_id_experiment_id_fkey FOREIGN KEY (tenant_id, experiment_id) REFERENCES public.experiments(tenant_id, id);


--
-- Name: runs runs_tenant_id_experiment_id_protocol_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_tenant_id_experiment_id_protocol_version_id_fkey FOREIGN KEY (tenant_id, experiment_id, protocol_version_id) REFERENCES public.protocol_versions(tenant_id, experiment_id, id);


--
-- Name: runs runs_tenant_id_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_tenant_id_node_id_fkey FOREIGN KEY (tenant_id, node_id) REFERENCES public.lineage_nodes(tenant_id, id);


--
-- Name: signature_challenges signature_challenges_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_challenges
    ADD CONSTRAINT signature_challenges_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: signature_challenges signature_challenges_tenant_id_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_challenges
    ADD CONSTRAINT signature_challenges_tenant_id_principal_id_fkey FOREIGN KEY (tenant_id, principal_id) REFERENCES public.principals(tenant_id, id);


--
-- Name: signature_challenges signature_challenges_tenant_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_challenges
    ADD CONSTRAINT signature_challenges_tenant_id_run_id_fkey FOREIGN KEY (tenant_id, run_id) REFERENCES public.runs(tenant_id, id);


--
-- Name: signature_manifests signature_manifests_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_manifests
    ADD CONSTRAINT signature_manifests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: signature_manifests signature_manifests_tenant_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signature_manifests
    ADD CONSTRAINT signature_manifests_tenant_id_run_id_fkey FOREIGN KEY (tenant_id, run_id) REFERENCES public.runs(tenant_id, id);


--
-- Name: signatures signatures_challenge_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_challenge_fk FOREIGN KEY (tenant_id, challenge_id) REFERENCES public.signature_challenges(tenant_id, id);


--
-- Name: signatures signatures_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: signatures signatures_tenant_id_invalidated_by_change_set_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_tenant_id_invalidated_by_change_set_fkey FOREIGN KEY (tenant_id, invalidated_by_change_set) REFERENCES public.change_sets(tenant_id, id);


--
-- Name: signatures signatures_tenant_id_manifest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_tenant_id_manifest_id_fkey FOREIGN KEY (tenant_id, manifest_id) REFERENCES public.signature_manifests(tenant_id, id);


--
-- Name: signatures signatures_tenant_id_signer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_tenant_id_signer_id_fkey FOREIGN KEY (tenant_id, signer_id) REFERENCES public.principals(tenant_id, id);


--
-- Name: agent_delegations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_delegations ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_chain_heads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_chain_heads ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: change_sets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.change_sets ENABLE ROW LEVEL SECURITY;

--
-- Name: experiments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.experiments ENABLE ROW LEVEL SECURITY;

--
-- Name: instrument_readings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instrument_readings ENABLE ROW LEVEL SECURITY;

--
-- Name: instruments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instruments ENABLE ROW LEVEL SECURITY;

--
-- Name: lineage_edges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lineage_edges ENABLE ROW LEVEL SECURITY;

--
-- Name: lineage_nodes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lineage_nodes ENABLE ROW LEVEL SECURITY;

--
-- Name: notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_delegations owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.agent_delegations TO lde USING (true) WITH CHECK (true);


--
-- Name: audit_chain_heads owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.audit_chain_heads TO lde USING (true) WITH CHECK (true);


--
-- Name: audit_events owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.audit_events TO lde USING (true) WITH CHECK (true);


--
-- Name: change_sets owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.change_sets TO lde USING (true) WITH CHECK (true);


--
-- Name: experiments owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.experiments TO lde USING (true) WITH CHECK (true);


--
-- Name: instrument_readings owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.instrument_readings TO lde USING (true) WITH CHECK (true);


--
-- Name: instruments owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.instruments TO lde USING (true) WITH CHECK (true);


--
-- Name: lineage_edges owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.lineage_edges TO lde USING (true) WITH CHECK (true);


--
-- Name: lineage_nodes owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.lineage_nodes TO lde USING (true) WITH CHECK (true);


--
-- Name: notes owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.notes TO lde USING (true) WITH CHECK (true);


--
-- Name: principals owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.principals TO lde USING (true) WITH CHECK (true);


--
-- Name: protocol_versions owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.protocol_versions TO lde USING (true) WITH CHECK (true);


--
-- Name: record_revisions owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.record_revisions TO lde USING (true) WITH CHECK (true);


--
-- Name: role_grants owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.role_grants TO lde USING (true) WITH CHECK (true);


--
-- Name: runs owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.runs TO lde USING (true) WITH CHECK (true);


--
-- Name: signature_challenges owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.signature_challenges TO lde USING (true) WITH CHECK (true);


--
-- Name: signature_manifests owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.signature_manifests TO lde USING (true) WITH CHECK (true);


--
-- Name: signatures owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.signatures TO lde USING (true) WITH CHECK (true);


--
-- Name: tenants owner_maintenance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_maintenance ON public.tenants TO lde USING (true) WITH CHECK (true);


--
-- Name: principals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.principals ENABLE ROW LEVEL SECURITY;

--
-- Name: protocol_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.protocol_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: record_revisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.record_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: role_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;

--
-- Name: signature_challenges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.signature_challenges ENABLE ROW LEVEL SECURITY;

--
-- Name: signature_manifests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.signature_manifests ENABLE ROW LEVEL SECURITY;

--
-- Name: signatures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.signatures ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_delegations tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.agent_delegations TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: audit_chain_heads tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.audit_chain_heads TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: audit_events tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.audit_events TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: change_sets tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.change_sets TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: experiments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.experiments TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: instrument_readings tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.instrument_readings TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: instruments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.instruments TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: lineage_edges tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.lineage_edges TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: lineage_nodes tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.lineage_nodes TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: notes tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.notes TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: principals tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.principals TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: protocol_versions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.protocol_versions TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: record_revisions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.record_revisions TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: role_grants tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.role_grants TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: runs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.runs TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: signature_challenges tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.signature_challenges TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: signature_manifests tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.signature_manifests TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: signatures tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.signatures TO lde_app USING ((tenant_id = public.lde_current_tenant())) WITH CHECK ((tenant_id = public.lde_current_tenant()));


--
-- Name: tenants tenant_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_self ON public.tenants TO lde_app USING ((id = public.lde_current_tenant()));


--
-- Name: tenants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO lde_app;


--
-- Name: FUNCTION audit_digest(p_tenant uuid, p_seq bigint, p_at timestamp with time zone, p_actor text, p_action text, p_entity_type text, p_entity_id text, p_reason text, p_payload text, p_prev bytea); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.audit_digest(p_tenant uuid, p_seq bigint, p_at timestamp with time zone, p_actor text, p_action text, p_entity_type text, p_entity_id text, p_reason text, p_payload text, p_prev bytea) TO lde_app;


--
-- Name: FUNCTION audit_lp(t text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.audit_lp(t text) TO lde_app;


--
-- Name: FUNCTION audit_verify_chain(p_tenant uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.audit_verify_chain(p_tenant uuid) TO lde_app;


--
-- Name: FUNCTION change_set_touched_runs(t uuid, items jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.change_set_touched_runs(t uuid, items jsonb) TO lde_app;


--
-- Name: FUNCTION lde_current_principal(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lde_current_principal() TO lde_app;


--
-- Name: FUNCTION lde_current_tenant(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lde_current_tenant() TO lde_app;


--
-- Name: FUNCTION lde_has_role(r text, s text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lde_has_role(r text, s text) TO lde_app;


--
-- Name: FUNCTION lde_has_text(t text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lde_has_text(t text) TO lde_app;


--
-- Name: FUNCTION lde_on_behalf_of(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lde_on_behalf_of() TO lde_app;


--
-- Name: FUNCTION lde_principal_holds(p uuid, r text, s text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lde_principal_holds(p uuid, r text, s text) TO lde_app;


--
-- Name: FUNCTION lde_require_human(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lde_require_human() TO lde_app;


--
-- Name: FUNCTION lde_require_role(VARIADIC roles text[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lde_require_role(VARIADIC roles text[]) TO lde_app;


--
-- Name: FUNCTION lde_require_signing_policy_role(t uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lde_require_signing_policy_role(t uuid) TO lde_app;


--
-- Name: FUNCTION lde_reviewed_commit(kind text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lde_reviewed_commit(kind text) TO lde_app;


--
-- Name: FUNCTION lineage_node_sealed(node uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.lineage_node_sealed(node uuid) TO lde_app;


--
-- Name: FUNCTION protocol_sha256(t text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.protocol_sha256(t text) TO lde_app;


--
-- Name: FUNCTION signing_policy_valid(p jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.signing_policy_valid(p jsonb) TO lde_app;


--
-- Name: TABLE agent_delegations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.agent_delegations TO lde_app;


--
-- Name: COLUMN agent_delegations.ended_by; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(ended_by) ON TABLE public.agent_delegations TO lde_app;


--
-- Name: COLUMN agent_delegations.ended_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(ended_at) ON TABLE public.agent_delegations TO lde_app;


--
-- Name: TABLE audit_chain_heads; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.audit_chain_heads TO lde_app;


--
-- Name: TABLE audit_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.audit_events TO lde_app;


--
-- Name: TABLE change_sets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.change_sets TO lde_app;


--
-- Name: COLUMN change_sets.title; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(title) ON TABLE public.change_sets TO lde_app;


--
-- Name: COLUMN change_sets.reason; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(reason) ON TABLE public.change_sets TO lde_app;


--
-- Name: COLUMN change_sets.state; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(state) ON TABLE public.change_sets TO lde_app;


--
-- Name: COLUMN change_sets.items; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(items) ON TABLE public.change_sets TO lde_app;


--
-- Name: COLUMN change_sets.decided_by; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(decided_by) ON TABLE public.change_sets TO lde_app;


--
-- Name: COLUMN change_sets.decided_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(decided_at) ON TABLE public.change_sets TO lde_app;


--
-- Name: COLUMN change_sets.decision_reason; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(decision_reason) ON TABLE public.change_sets TO lde_app;


--
-- Name: TABLE experiments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.experiments TO lde_app;


--
-- Name: COLUMN experiments.title; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(title) ON TABLE public.experiments TO lde_app;


--
-- Name: COLUMN experiments.signing_policy; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(signing_policy) ON TABLE public.experiments TO lde_app;


--
-- Name: TABLE instrument_readings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.instrument_readings TO lde_app;


--
-- Name: TABLE instruments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.instruments TO lde_app;


--
-- Name: TABLE lineage_edges; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.lineage_edges TO lde_app;


--
-- Name: TABLE lineage_nodes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.lineage_nodes TO lde_app;


--
-- Name: COLUMN lineage_nodes.label; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(label) ON TABLE public.lineage_nodes TO lde_app;


--
-- Name: COLUMN lineage_nodes.attrs; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(attrs) ON TABLE public.lineage_nodes TO lde_app;


--
-- Name: TABLE notes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.notes TO lde_app;


--
-- Name: COLUMN notes.body; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(body) ON TABLE public.notes TO lde_app;


--
-- Name: TABLE principals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.principals TO lde_app;


--
-- Name: COLUMN principals.display_name; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(display_name) ON TABLE public.principals TO lde_app;


--
-- Name: COLUMN principals.enabled; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(enabled) ON TABLE public.principals TO lde_app;


--
-- Name: TABLE protocol_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.protocol_versions TO lde_app;


--
-- Name: TABLE record_revisions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.record_revisions TO lde_app;


--
-- Name: TABLE role_grants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.role_grants TO lde_app;


--
-- Name: COLUMN role_grants.revoked_by; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(revoked_by) ON TABLE public.role_grants TO lde_app;


--
-- Name: COLUMN role_grants.revoked_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(revoked_at) ON TABLE public.role_grants TO lde_app;


--
-- Name: COLUMN role_grants.revoke_reason; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(revoke_reason) ON TABLE public.role_grants TO lde_app;


--
-- Name: TABLE runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.runs TO lde_app;


--
-- Name: TABLE signature_challenges; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.signature_challenges TO lde_app;


--
-- Name: COLUMN signature_challenges.tenant_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(tenant_id) ON TABLE public.signature_challenges TO lde_app;


--
-- Name: COLUMN signature_challenges.run_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(run_id) ON TABLE public.signature_challenges TO lde_app;


--
-- Name: COLUMN signature_challenges.manifest_sha256; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(manifest_sha256) ON TABLE public.signature_challenges TO lde_app;


--
-- Name: COLUMN signature_challenges.used_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(used_at) ON TABLE public.signature_challenges TO lde_app;


--
-- Name: COLUMN signature_challenges.login_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(login_at) ON TABLE public.signature_challenges TO lde_app;


--
-- Name: TABLE signature_manifests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.signature_manifests TO lde_app;


--
-- Name: COLUMN signature_manifests.tenant_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(tenant_id) ON TABLE public.signature_manifests TO lde_app;


--
-- Name: COLUMN signature_manifests.run_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(run_id) ON TABLE public.signature_manifests TO lde_app;


--
-- Name: COLUMN signature_manifests.manifest; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(manifest) ON TABLE public.signature_manifests TO lde_app;


--
-- Name: TABLE signatures; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.signatures TO lde_app;


--
-- Name: COLUMN signatures.invalidated_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(invalidated_at) ON TABLE public.signatures TO lde_app;


--
-- Name: COLUMN signatures.invalidated_by_change_set; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(invalidated_by_change_set) ON TABLE public.signatures TO lde_app;


--
-- Name: TABLE tenants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.tenants TO lde_app;


--
-- PostgreSQL database dump complete
--


