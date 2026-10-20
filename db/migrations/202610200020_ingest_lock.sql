-- A read lock is needed during replay as well as HTTP ingest. Avoid granting the
-- worker arbitrary device updates merely to satisfy PostgreSQL's row-lock ACL.
CREATE FUNCTION app.lock_active_device(target uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$ BEGIN
 PERFORM id FROM devices WHERE id=target AND school_id=app.school_id() AND status='ACTIVE' FOR SHARE;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app.lock_active_device(uuid) FROM PUBLIC,anon,authenticated,app_api,app_platform;
GRANT EXECUTE ON FUNCTION app.lock_active_device(uuid) TO app_device,app_worker;
