ALTER TABLE worker_instances ADD COLUMN release text NOT NULL DEFAULT 'unknown';
-- Public health reports contain only release readiness, never worker IDs or tenant data.
CREATE FUNCTION app.worker_release_ready(expected text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT FROM worker_instances WHERE release=expected AND state='RUNNING'
 AND last_seen_at>now()-interval '90 seconds' AND last_success_at>now()-interval '5 minutes');
$$;
REVOKE ALL ON FUNCTION app.worker_release_ready(text) FROM PUBLIC,anon,authenticated,app_platform,app_worker,app_device;
GRANT EXECUTE ON FUNCTION app.worker_release_ready(text) TO app_api;
