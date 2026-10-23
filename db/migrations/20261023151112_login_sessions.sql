-- Supabase auth.sessions remains authoritative. Never store access/refresh tokens.
-- Provider logout deletes auth.sessions; refresh_tokens has an ON DELETE CASCADE FK.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='auth.refresh_tokens'::regclass
   AND confrelid='auth.sessions'::regclass AND contype='f' AND confdeltype='c') THEN
   RAISE EXCEPTION 'AUTH_SESSION_CASCADE_REQUIRED';
 END IF;
END $$;

CREATE TABLE app.login_session_activity(
 session_id uuid PRIMARY KEY REFERENCES auth.sessions(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 last_active_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_session_activity_owner ON app.login_session_activity(user_id);
ALTER TABLE app.login_session_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.login_session_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY own_session_activity ON app.login_session_activity FOR SELECT TO app_api USING(user_id=(SELECT app.user_id()));
REVOKE ALL ON app.login_session_activity FROM PUBLIC,anon,authenticated,app_api,app_platform,app_worker,app_device;
GRANT SELECT ON app.login_session_activity TO app_api;

CREATE TABLE app.account_security_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('NEW_LOGIN','SESSION_ENDED','OTHER_SESSIONS_ENDED')),
 affected_count integer NOT NULL DEFAULT 1 CHECK(affected_count>=0),created_at timestamptz NOT NULL DEFAULT now(),
 email_status text NOT NULL DEFAULT 'PENDING' CHECK(email_status IN ('PENDING','PROCESSING','SENT','FAILED','NOT_REQUIRED')),
 attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),locked_until timestamptz,
 lease_token uuid
);
CREATE UNIQUE INDEX account_security_login_once ON app.account_security_events(user_id,session_id) WHERE kind='NEW_LOGIN';
CREATE INDEX account_security_events_owner ON app.account_security_events(user_id,created_at DESC);
CREATE INDEX account_security_events_pending ON app.account_security_events(next_attempt_at) WHERE email_status IN ('PENDING','PROCESSING');
ALTER TABLE app.account_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_security_events FORCE ROW LEVEL SECURITY;
CREATE POLICY own_security_events ON app.account_security_events FOR SELECT TO app_api USING(user_id=(SELECT app.user_id()));
REVOKE ALL ON app.account_security_events FROM PUBLIC,anon,authenticated,app_api,app_platform,app_worker,app_device;
GRANT SELECT ON app.account_security_events TO app_api;

-- Existing logins are listed, but installation must not send old-login emails.
INSERT INTO app.login_session_activity(session_id,user_id,last_active_at)
 SELECT s.id,s.user_id,greatest(s.created_at,s.refreshed_at AT TIME ZONE 'UTC') FROM auth.sessions s JOIN users u ON u.id=s.user_id;

-- Only the trusted API role can call this after provider getUser verification.
CREATE FUNCTION app.observe_login_session(uid uuid,sid uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE inserted uuid;
BEGIN
 PERFORM 1 FROM auth.sessions s JOIN users u ON u.id=s.user_id
   WHERE s.id=sid AND s.user_id=uid AND u.status='ACTIVE' AND (s.not_after IS NULL OR s.not_after>clock_timestamp()) FOR KEY SHARE OF s;
 IF NOT FOUND THEN RETURN false;END IF;
 INSERT INTO app.login_session_activity(session_id,user_id) VALUES(sid,uid)
   ON CONFLICT DO NOTHING RETURNING session_id INTO inserted;
 IF inserted IS NOT NULL THEN
   INSERT INTO app.account_security_events(user_id,session_id,kind) VALUES(uid,sid,'NEW_LOGIN') ON CONFLICT DO NOTHING;
 ELSE
   UPDATE app.login_session_activity SET last_active_at=clock_timestamp()
     WHERE session_id=sid AND user_id=uid AND last_active_at<clock_timestamp()-interval '1 minute';
 END IF;
 RETURN true;
END $$;

CREATE FUNCTION app.own_live_session(sid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT FROM auth.sessions s JOIN users u ON u.id=s.user_id WHERE s.id=sid
   AND s.user_id=app.user_id() AND u.status='ACTIVE' AND (s.not_after IS NULL OR s.not_after>now()))
$$;
CREATE FUNCTION app.account_sessions(current_sid uuid) RETURNS TABLE(id uuid,user_agent text,ip_address text,login_at timestamptz,last_active_at timestamptz,expires_at timestamptz,is_current boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT app.own_live_session(current_sid) THEN RAISE EXCEPTION 'SESSION_EXPIRED' USING ERRCODE='28000';END IF;
 RETURN QUERY SELECT s.id,left(s.user_agent,512),host(s.ip),s.created_at,
   greatest(s.created_at,s.refreshed_at AT TIME ZONE 'UTC',a.last_active_at),s.not_after,s.id=current_sid
 FROM auth.sessions s LEFT JOIN app.login_session_activity a ON a.session_id=s.id
 WHERE s.user_id=app.user_id() AND (s.not_after IS NULL OR s.not_after>now())
 ORDER BY (s.id=current_sid) DESC,s.created_at DESC;
END $$;

CREATE FUNCTION app.end_account_sessions(current_sid uuid,target_sid uuid,others boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE changed integer;uid uuid:=app.user_id();
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('account-sessions:'||uid::text,0));
 IF NOT app.own_live_session(current_sid) THEN RAISE EXCEPTION 'SESSION_EXPIRED' USING ERRCODE='28000';END IF;
 -- Same provider operation as Supabase's LogoutSession / LogoutAllExceptMe.
 -- Ownership is enforced here, independent of the route or current school.
 DELETE FROM auth.sessions WHERE user_id=uid AND
   (CASE WHEN others THEN id<>current_sid ELSE id=target_sid END);
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN
   INSERT INTO app.account_security_events(user_id,session_id,kind,affected_count,email_status)
     VALUES(uid,CASE WHEN others THEN current_sid ELSE target_sid END,
       CASE WHEN others THEN 'OTHER_SESSIONS_ENDED' ELSE 'SESSION_ENDED' END,changed,'NOT_REQUIRED');
 END IF;
 RETURN changed;
END $$;

-- Account-level alerts cannot use the school/parent-only attendance outbox.
-- Reuse the worker's configured email provider and its idempotent delivery.
CREATE FUNCTION app.claim_login_alerts(lease uuid) RETURNS TABLE(id uuid,email text,login_at timestamptz,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 RETURN QUERY WITH picked AS (
   SELECT e.id FROM app.account_security_events e JOIN users u ON u.id=e.user_id JOIN auth.users au ON au.id=u.id
   WHERE e.kind='NEW_LOGIN' AND u.status='ACTIVE' AND au.email_confirmed_at IS NOT NULL AND au.email IS NOT NULL
   AND e.created_at>now()-interval '24 hours' AND e.attempts<6 AND e.next_attempt_at<=now()
   AND (e.email_status='PENDING' OR (e.email_status='PROCESSING' AND e.locked_until<now()))
   ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 10
 ), claimed AS (
   UPDATE app.account_security_events e SET email_status='PROCESSING',attempts=e.attempts+1,
     locked_until=now()+interval '5 minutes',lease_token=lease FROM picked p WHERE e.id=p.id RETURNING e.*
 ) SELECT c.id,au.email::text,c.created_at,c.attempts FROM claimed c JOIN auth.users au ON au.id=c.user_id;
END $$;
CREATE FUNCTION app.finish_login_alert(event_id uuid,lease uuid,sent boolean,permanent boolean DEFAULT false) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 UPDATE app.account_security_events SET email_status=CASE WHEN sent THEN 'SENT' WHEN permanent OR attempts>=6 THEN 'FAILED' ELSE 'PENDING' END,
   next_attempt_at=now()+make_interval(secs=>least(3600,30*(2^attempts)::integer)),locked_until=NULL,lease_token=NULL
 WHERE id=event_id AND lease_token=lease AND email_status='PROCESSING';
$$;
CREATE FUNCTION app.prune_account_security_events() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DELETE FROM app.account_security_events WHERE created_at<now()-interval '90 days';
$$;

REVOKE ALL ON FUNCTION app.observe_login_session(uuid,uuid),app.own_live_session(uuid),app.account_sessions(uuid),app.end_account_sessions(uuid,uuid,boolean),app.claim_login_alerts(uuid),app.finish_login_alert(uuid,uuid,boolean,boolean),app.prune_account_security_events() FROM PUBLIC,anon,authenticated,app_api,app_platform,app_worker,app_device;
GRANT EXECUTE ON FUNCTION app.observe_login_session(uuid,uuid),app.account_sessions(uuid),app.end_account_sessions(uuid,uuid,boolean) TO app_api;
GRANT EXECUTE ON FUNCTION app.claim_login_alerts(uuid),app.finish_login_alert(uuid,uuid,boolean,boolean),app.prune_account_security_events() TO app_worker;
