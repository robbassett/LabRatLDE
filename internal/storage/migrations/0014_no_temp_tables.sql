-- 0014_no_temp_tables: lde_app can't create TEMP tables (SPEC-007).
--
-- Triggers and role checks that don't pin search_path resolve table names
-- with pg_temp first, so a TEMP table named runs or principals would stand in
-- for the real one and switch the check off. Revoking TEMP stops lde_app doing
-- that, whichever function is involved. The login role keeps TEMP if it owns
-- the database, but it can already RESET ROLE and owns the tables.
--
-- Only the database owner or a superuser can revoke this, and a login role
-- that merely owns the schema gets no error, only no effect. So this warns
-- rather than blocking startup. The server logs an error on every boot, and
-- `labrat iq` fails, until an admin runs:
--   REVOKE TEMPORARY ON DATABASE <name> FROM PUBLIC;

-- SPEC-007-R02, SPEC-007-R06
DO $$
BEGIN
    BEGIN
        EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    IF has_database_privilege('lde_app', current_database(), 'TEMPORARY') THEN
        RAISE WARNING 'lde_app can still create TEMP tables; run as the database owner: REVOKE TEMPORARY ON DATABASE % FROM PUBLIC', current_database();
    END IF;
END;
$$;
