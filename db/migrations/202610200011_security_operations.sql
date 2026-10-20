CREATE POLICY platform_audit_metadata ON audit_logs FOR SELECT TO app_platform USING(
 app.is_platform_staff() AND entity_type IN ('schools','devices','subscriptions','subscription_plans','support_access_grants','platform_staff','authentication'));

CREATE TABLE app.login_events(session_hash text NOT NULL,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(session_hash,user_id));
ALTER TABLE app.login_events ENABLE ROW LEVEL SECURITY;ALTER TABLE app.login_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.login_events FROM PUBLIC,anon,authenticated,app_api,app_worker,app_device,app_platform;
CREATE FUNCTION app.record_privileged_login(uid uuid,session_identifier uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE sid uuid;claimed text;
BEGIN
 IF NOT EXISTS(SELECT FROM users WHERE id=uid AND status='ACTIVE') THEN RETURN;END IF;
 INSERT INTO app.login_events(session_hash,user_id) VALUES(md5(session_identifier::text),uid) ON CONFLICT DO NOTHING RETURNING session_hash INTO claimed;
 IF claimed IS NULL THEN RETURN;END IF;
 IF EXISTS(SELECT FROM platform_staff WHERE user_id=uid AND platform_role='SUPER_ADMIN') THEN
  INSERT INTO audit_logs(actor_type,actor_id,action,entity_type) VALUES('USER',uid,'auth.privileged_login','authentication');
 END IF;
 FOR sid IN SELECT m.school_id FROM school_memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=uid AND m.status='ACTIVE' AND r.code IN ('school_admin','principal') LOOP
  INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type) VALUES(sid,'USER',uid,'auth.privileged_login','authentication');
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.record_privileged_login(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.record_privileged_login(uuid,uuid) TO app_api;

CREATE TABLE app.http_rate_buckets(key_hash text PRIMARY KEY,window_start timestamptz NOT NULL,used integer NOT NULL);
ALTER TABLE app.http_rate_buckets ENABLE ROW LEVEL SECURITY;ALTER TABLE app.http_rate_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.http_rate_buckets FROM PUBLIC,anon,authenticated,app_api,app_worker,app_device,app_platform;
CREATE FUNCTION app.take_http_token(h text,max_requests integer,window_seconds integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE bucket app.http_rate_buckets;ts timestamptz:=clock_timestamp();
BEGIN
 IF h !~ '^[a-f0-9]{64}$' OR max_requests<1 OR max_requests>10000 OR window_seconds<1 OR window_seconds>3600 THEN RAISE EXCEPTION 'Invalid limiter';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('http:'||h,0));
 INSERT INTO app.http_rate_buckets VALUES(h,ts,0) ON CONFLICT DO NOTHING;
 SELECT * INTO bucket FROM app.http_rate_buckets WHERE key_hash=h FOR UPDATE;
 IF bucket.window_start+make_interval(secs=>window_seconds)<=ts THEN
  UPDATE app.http_rate_buckets SET window_start=ts,used=1 WHERE key_hash=h;RETURN 0;
 END IF;
 IF bucket.used>=max_requests THEN RETURN greatest(1,ceil(extract(epoch FROM bucket.window_start+make_interval(secs=>window_seconds)-ts))::integer);END IF;
 UPDATE app.http_rate_buckets SET used=used+1 WHERE key_hash=h;RETURN 0;
END $$;
REVOKE ALL ON FUNCTION app.take_http_token(text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.take_http_token(text,integer,integer) TO app_api,app_device;

CREATE POLICY platform_audit_append ON audit_logs FOR INSERT TO app_platform WITH CHECK(
 app.is_platform_staff() AND entity_type IN ('schools','devices','subscriptions','subscription_plans','support_access_grants','authentication'));
