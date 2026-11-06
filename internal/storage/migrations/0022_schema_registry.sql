-- 0022_schema_registry: versioned JSON Schemas and references to them (SPEC-009).
--
-- A schema has numbered versions (major.minor) whose text is stored exactly as
-- written, with a generated jsonb body and SHA-256 over that text. A draft may
-- be edited by its author; a published version is immutable. Lineage nodes and
-- protocol versions may reference a published version of the right kind, and a
-- node's reference is fixed at creation. (SPEC-009-R01, R02, R03, R10, R11, R12)

CREATE TABLE schemas (
    id         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id  uuid NOT NULL REFERENCES tenants (id),
    namespace  text NOT NULL CHECK (namespace ~ '^~?[a-z0-9][a-z0-9._@+-]{0,127}$'),
    name       text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
    applies_to text NOT NULL CHECK (applies_to IN ('sample', 'reagent', 'protocol', 'run', 'instrument', 'dataset', 'analysis', 'run_params')),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, namespace, name)
);

CREATE TABLE schema_versions (
    id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES tenants (id),
    schema_id    uuid NOT NULL,
    major        int NOT NULL CHECK (major >= 0),
    minor        int NOT NULL CHECK (minor >= 0),
    status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    body_text    text NOT NULL,
    body         jsonb GENERATED ALWAYS AS (body_text::jsonb) STORED,
    sha256       bytea GENERATED ALWAYS AS (protocol_sha256(body_text)) STORED,
    author       text NOT NULL,
    author_id    uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_by uuid,
    published_at timestamptz,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, schema_id, major, minor),
    FOREIGN KEY (tenant_id, schema_id)    REFERENCES schemas (tenant_id, id),
    FOREIGN KEY (tenant_id, author_id)    REFERENCES principals (tenant_id, id),
    FOREIGN KEY (tenant_id, published_by) REFERENCES principals (tenant_id, id),
    CHECK ((status = 'published') = (published_at IS NOT NULL)),
    CHECK (jsonb_typeof(body) = 'object')
);

-- SPEC-009-R11; a schema's name and applies_to never change, because R03 reads them.
CREATE FUNCTION schemas_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM lde_require_role('scientist');
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a schema''s identity never changes (% rejected)', TG_OP USING ERRCODE = 'LDE03';
END;
$$;
CREATE TRIGGER schemas_guard BEFORE INSERT OR UPDATE OR DELETE ON schemas
    FOR EACH ROW EXECUTE FUNCTION schemas_guard();
CREATE TRIGGER schemas_no_truncate BEFORE TRUNCATE ON schemas
    FOR EACH STATEMENT EXECUTE FUNCTION schemas_guard();

-- SPEC-009-R01, R10, R11. The immutability check comes first, so it answers
-- LDE03 whoever is asking. The owner may insert a published row (SPEC-015).
CREATE FUNCTION schema_versions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'schema versions are never truncated' USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP <> 'INSERT' AND OLD.status = 'published' THEN
        RAISE EXCEPTION 'schema version % is published and immutable (% rejected)', OLD.id, TG_OP USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    PERFORM lde_require_role('scientist');
    IF TG_OP = 'INSERT' THEN
        IF current_user = 'lde_app' THEN
            IF NEW.status <> 'draft' THEN
                RAISE EXCEPTION 'a schema version starts as a draft' USING ERRCODE = 'check_violation';
            END IF;
            NEW.author_id := lde_current_principal();
            NEW.created_at := clock_timestamp();
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.schema_id, NEW.major, NEW.minor, NEW.author, NEW.author_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.schema_id, OLD.major, OLD.minor, OLD.author, OLD.author_id, OLD.created_at) THEN
        RAISE EXCEPTION 'schema version %: identity and authorship never change', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF current_user = 'lde_app' THEN
        IF NEW.status = 'draft' THEN
            IF lde_current_principal() IS DISTINCT FROM OLD.author_id THEN
                RAISE EXCEPTION 'only the author of schema version % may change its draft', OLD.id USING ERRCODE = 'LDE05';
            END IF;
        ELSE
            IF NEW.body_text IS DISTINCT FROM OLD.body_text THEN
                RAISE EXCEPTION 'schema version %: publishing cannot change the text', OLD.id USING ERRCODE = 'LDE03';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM principals pr WHERE pr.id = lde_current_principal() AND pr.kind = 'human' AND pr.enabled) THEN
                RAISE EXCEPTION 'only a human may publish a schema version' USING ERRCODE = 'LDE05';
            END IF;
            NEW.published_by := lde_current_principal();
            NEW.published_at := clock_timestamp();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER schema_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON schema_versions
    FOR EACH ROW EXECUTE FUNCTION schema_versions_guard();
CREATE TRIGGER schema_versions_no_truncate BEFORE TRUNCATE ON schema_versions
    FOR EACH STATEMENT EXECUTE FUNCTION schema_versions_guard();

-- SPEC-009-R02
ALTER TABLE schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE schemas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schemas TO lde_app
    USING (tenant_id = lde_current_tenant())
    WITH CHECK (tenant_id = lde_current_tenant());
DO $$
BEGIN
    EXECUTE format('CREATE POLICY owner_maintenance ON schemas TO %I USING (true) WITH CHECK (true)', current_user);
END;
$$;

ALTER TABLE schema_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schema_versions TO lde_app
    USING (tenant_id = lde_current_tenant())
    WITH CHECK (tenant_id = lde_current_tenant());
DO $$
BEGIN
    EXECUTE format('CREATE POLICY owner_maintenance ON schema_versions TO %I USING (true) WITH CHECK (true)', current_user);
END;
$$;

GRANT SELECT, INSERT ON schemas TO lde_app;
GRANT SELECT, INSERT, UPDATE (body_text, status) ON schema_versions TO lde_app;

-- SPEC-009-R03, R12: references to published versions.
ALTER TABLE lineage_nodes ADD COLUMN schema_version_id uuid;
ALTER TABLE lineage_nodes ADD FOREIGN KEY (tenant_id, schema_version_id) REFERENCES schema_versions (tenant_id, id);
ALTER TABLE protocol_versions ADD COLUMN params_schema_version_id uuid;
ALTER TABLE protocol_versions ADD FOREIGN KEY (tenant_id, params_schema_version_id) REFERENCES schema_versions (tenant_id, id);

-- SPEC-009-R03. Row security hides another tenant's versions, and t covers the owner.
CREATE FUNCTION schema_ref_check(t uuid, v uuid, want text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.schema_versions sv
        JOIN public.schemas s ON s.tenant_id = sv.tenant_id AND s.id = sv.schema_id
        WHERE sv.tenant_id = t AND sv.id = v AND sv.status = 'published' AND s.applies_to = want
    ) THEN
        RAISE EXCEPTION 'schema version % is not a published schema for %', v, want USING ERRCODE = 'LDE06';
    END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION schema_ref_check(uuid, uuid, text) TO lde_app;

-- SPEC-009-R03, R12
CREATE FUNCTION lineage_nodes_schema_ref() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'node %: schema_version_id is fixed when the node is created', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    PERFORM public.schema_ref_check(NEW.tenant_id, NEW.schema_version_id, NEW.kind);
    RETURN NEW;
END;
$$;
CREATE TRIGGER lineage_nodes_schema_ref BEFORE INSERT ON lineage_nodes
    FOR EACH ROW WHEN (NEW.schema_version_id IS NOT NULL)
    EXECUTE FUNCTION lineage_nodes_schema_ref();
CREATE TRIGGER lineage_nodes_schema_pinned BEFORE UPDATE OF schema_version_id ON lineage_nodes
    FOR EACH ROW WHEN (OLD.schema_version_id IS DISTINCT FROM NEW.schema_version_id)
    EXECUTE FUNCTION lineage_nodes_schema_ref();

-- SPEC-009-R03. protocol_versions is already append-only, so the reference can't change.
CREATE FUNCTION protocol_versions_schema_ref() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM public.schema_ref_check(NEW.tenant_id, NEW.params_schema_version_id, 'run_params');
    RETURN NEW;
END;
$$;
CREATE TRIGGER protocol_versions_schema_ref BEFORE INSERT ON protocol_versions
    FOR EACH ROW WHEN (NEW.params_schema_version_id IS NOT NULL)
    EXECUTE FUNCTION protocol_versions_schema_ref();
