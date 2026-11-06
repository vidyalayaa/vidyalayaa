-- Keep the school settings projection used by the API and reader worker.
CREATE FUNCTION app.reader_offline_minutes(settings jsonb) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN settings->'security'->>'device_offline_minutes' ~ '^([1-9]|[1-5][0-9]|60)$'
  THEN (settings->'security'->>'device_offline_minutes')::int ELSE 3 END
$$;
REVOKE ALL ON FUNCTION app.reader_offline_minutes(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.reader_offline_minutes(jsonb) TO app_api,app_worker;

CREATE TABLE app.school_security_policy_versions(
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 version integer NOT NULL CHECK(version>=0),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
 PRIMARY KEY(school_id,version)
);
ALTER TABLE app.school_security_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.school_security_policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY security_policy_history_read ON app.school_security_policy_versions FOR SELECT TO app_api
 USING(school_id=(SELECT app.school_id()) AND app.school_role(school_id)='school_admin');
CREATE POLICY security_policy_history_insert ON app.school_security_policy_versions FOR INSERT TO app_api
 WITH CHECK(school_id=(SELECT app.school_id()) AND app.school_role(school_id)='school_admin');
REVOKE ALL ON app.school_security_policy_versions FROM PUBLIC,anon,authenticated,app_api,app_platform,app_worker,app_device;
GRANT SELECT,INSERT ON app.school_security_policy_versions TO app_api;

CREATE OR REPLACE FUNCTION app.school_security_changed() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.settings->'security' IS DISTINCT FROM OLD.settings->'security' THEN
  IF current_user='app_platform' OR (current_user='app_api' AND
      (app.school_id() IS DISTINCT FROM OLD.id OR app.school_role(OLD.id) IS DISTINCT FROM 'school_admin')) THEN
   RAISE EXCEPTION 'SECURITY_POLICY_ADMIN_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF current_user='app_api' AND ((NEW.settings->'security'->>'version')::int IS DISTINCT FROM
      coalesce((OLD.settings->'security'->>'version')::int,0)+1) THEN
   RAISE EXCEPTION 'SECURITY_POLICY_VERSION_INVALID' USING ERRCODE='23514';
  END IF;
  NEW.access_version=OLD.access_version+1;
 END IF;
 RETURN NEW;
END $$;

-- Verify a separate active administrator has an actual provider-verified TOTP factor.
CREATE FUNCTION app.school_mfa_recovery_ready() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
 SELECT app.school_role(app.school_id())='school_admin' AND EXISTS(
   SELECT FROM auth.mfa_factors f WHERE f.user_id=app.user_id()
     AND f.factor_type='totp' AND f.status='verified'
 ) AND EXISTS(
   SELECT FROM school_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id
   WHERE m.school_id=app.school_id() AND m.user_id<>app.user_id() AND m.status='ACTIVE'
     AND r.code='school_admin' AND u.status='ACTIVE'
     AND EXISTS(SELECT FROM auth.mfa_factors f WHERE f.user_id=m.user_id
       AND f.factor_type='totp' AND f.status='verified')
     AND EXISTS(SELECT FROM app.account_security_events e WHERE e.user_id=m.user_id
       AND e.kind='MFA_VERIFIED' AND e.created_at>now()-interval '7 days'
       AND e.created_at>=date_trunc('second',m.created_at))
 )
$$;
REVOKE ALL ON FUNCTION app.school_mfa_recovery_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.school_mfa_recovery_ready() TO app_api;

ALTER TABLE app.login_session_activity
 ADD COLUMN last_interaction_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN login_observed boolean NOT NULL DEFAULT true;
-- Existing sessions were already observed or deliberately imported without alerts.
ALTER TABLE app.login_session_activity ALTER COLUMN login_observed SET DEFAULT false;
ALTER TABLE app.account_security_events
 ADD COLUMN ip_address inet,
 ADD COLUMN device_label text,
 ADD COLUMN unfamiliar_network boolean NOT NULL DEFAULT false;
ALTER TABLE app.account_security_events DROP CONSTRAINT account_security_events_kind_check;
ALTER TABLE app.account_security_events ADD CHECK (kind IN
 ('NEW_LOGIN','SESSION_ENDED','OTHER_SESSIONS_ENDED','MFA_VERIFIED'));
CREATE UNIQUE INDEX account_security_mfa_once
 ON app.account_security_events(user_id,session_id,created_at) WHERE kind='MFA_VERIFIED';

CREATE FUNCTION app.security_device_label(agent text) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog AS $$
 SELECT CASE
  WHEN agent ~* 'iPhone' THEN 'iPhone' WHEN agent ~* 'iPad' THEN 'iPad'
  WHEN agent ~* 'Android' THEN 'Android' WHEN agent ~* 'Windows' THEN 'Windows'
  WHEN agent ~* 'Macintosh|Mac OS' THEN 'Mac' WHEN agent ~* 'Linux' THEN 'Linux'
  ELSE NULL END
$$;
REVOKE ALL ON FUNCTION app.security_device_label(text) FROM PUBLIC,anon,authenticated;

-- Only trusted API callers can observe a session, after verifying the provider JWT and user.
-- Polls and token refresh do not extend an interactive deadline.
CREATE FUNCTION app.check_workspace_login_session(uid uuid,sid uuid,interacted boolean,admitted boolean,verified_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 sess record; ts timestamptz:=clock_timestamp(); last_interaction timestamptz;
 idle_end timestamptz; observed boolean; unfamiliar boolean:=false;
 notify_login boolean; notify_unfamiliar boolean; membership_count integer;
BEGIN
 SELECT s.created_at,s.ip,s.user_agent INTO sess FROM auth.sessions s JOIN users u ON u.id=s.user_id
 WHERE s.id=sid AND s.user_id=uid AND u.status='ACTIVE'
  AND (s.not_after IS NULL OR s.not_after>ts) FOR UPDATE OF s;
 IF NOT FOUND THEN RETURN jsonb_build_object('live',false); END IF;

 SELECT a.last_interaction_at,a.login_observed INTO last_interaction,observed FROM app.login_session_activity a
 WHERE a.session_id=sid AND a.user_id=uid;
 last_interaction:=coalesce(last_interaction,sess.created_at);
 WITH member_policies AS (
  SELECT s.settings->'security' AS policy,r.code
  FROM school_memberships m JOIN schools s ON s.id=m.school_id JOIN roles r ON r.id=m.role_id
  WHERE m.user_id=uid AND m.status='ACTIVE' AND s.status<>'TERMINATED'
 ), allowed AS (
  SELECT policy FROM member_policies WHERE NOT (
    (code='student' AND coalesce(policy->'student_login_enabled'='false'::jsonb,false))
    OR (code='parent' AND coalesce(policy->'parent_login_enabled'='false'::jsonb,false))
  )
 ), eligible_idle AS (
  SELECT policy FROM allowed WHERE policy->>'idle_timeout_minutes' ~ '^([5-9]|[1-9][0-9]|1[0-9][0-9]|2[0-3][0-9]|240)$'
 )
 SELECT
  (SELECT min(greatest(last_interaction,(policy->>'idle_timeout_changed_at')::timestamptz)
    + make_interval(mins=>(policy->>'idle_timeout_minutes')::int)) FROM eligible_idle),
  (SELECT bool_or(coalesce(policy->'new_login_alerts'<>'false'::jsonb,true)) FROM allowed),
  (SELECT bool_or(policy->'suspicious_login_alerts'='true'::jsonb) FROM allowed),
  (SELECT count(*) FROM member_policies)
 INTO idle_end,notify_login,notify_unfamiliar,membership_count;
 IF idle_end IS NOT NULL AND idle_end<=ts THEN
  DELETE FROM auth.sessions WHERE id=sid AND user_id=uid;
  INSERT INTO app.account_security_events(user_id,session_id,kind,email_status,ip_address,device_label)
   VALUES(uid,sid,'SESSION_ENDED','NOT_REQUIRED',sess.ip,app.security_device_label(sess.user_agent));
  RETURN jsonb_build_object('live',false,'inactive',true);
 END IF;
 IF admitted AND verified_at>ts-interval '15 minutes' AND verified_at<=ts THEN
  INSERT INTO app.account_security_events(user_id,session_id,kind,created_at,email_status,ip_address,device_label)
   VALUES(uid,sid,'MFA_VERIFIED',verified_at,'NOT_REQUIRED',sess.ip,app.security_device_label(sess.user_agent))
   ON CONFLICT DO NOTHING;
 END IF;
 IF admitted AND NOT coalesce(observed,false) THEN
  IF sess.ip IS NOT NULL AND coalesce(notify_unfamiliar,false) THEN
   unfamiliar:=EXISTS(SELECT FROM app.account_security_events e
     WHERE e.user_id=uid AND e.kind='NEW_LOGIN' AND e.ip_address IS NOT NULL
       AND e.created_at>ts-interval '30 days')
     AND NOT EXISTS(SELECT FROM app.account_security_events e
       WHERE e.user_id=uid AND e.kind='NEW_LOGIN' AND e.ip_address IS NOT NULL
        AND e.created_at>ts-interval '30 days'
        AND network(set_masklen(e.ip_address,CASE WHEN family(e.ip_address)=4 THEN 24 ELSE 64 END))
          =network(set_masklen(sess.ip,CASE WHEN family(sess.ip)=4 THEN 24 ELSE 64 END)));
  END IF;
  INSERT INTO app.account_security_events(user_id,session_id,kind,email_status,ip_address,device_label,unfamiliar_network)
   VALUES(uid,sid,'NEW_LOGIN',
    CASE WHEN coalesce(notify_login,membership_count=0)
       OR (unfamiliar AND coalesce(notify_unfamiliar,false))
       OR EXISTS(SELECT FROM platform_staff p WHERE p.user_id=uid AND p.platform_role='SUPER_ADMIN')
      THEN 'PENDING' ELSE 'NOT_REQUIRED' END,
    sess.ip,app.security_device_label(sess.user_agent),unfamiliar AND coalesce(notify_unfamiliar,false))
   ON CONFLICT DO NOTHING;
 END IF;
 INSERT INTO app.login_session_activity(session_id,user_id,last_interaction_at,login_observed)
 VALUES(sid,uid,last_interaction,admitted)
 ON CONFLICT(session_id) DO UPDATE SET last_active_at=ts,login_observed=(app.login_session_activity.login_observed OR admitted)
 WHERE app.login_session_activity.last_active_at<ts-interval '1 minute'
   OR (admitted AND NOT app.login_session_activity.login_observed);
 IF interacted THEN
  UPDATE app.login_session_activity SET last_interaction_at=ts WHERE session_id=sid AND user_id=uid;
  SELECT min(ts+make_interval(mins=>(s.settings->'security'->>'idle_timeout_minutes')::int))
   INTO idle_end FROM school_memberships m JOIN schools s ON s.id=m.school_id JOIN roles r ON r.id=m.role_id
   WHERE m.user_id=uid AND m.status='ACTIVE' AND s.status<>'TERMINATED'
    AND s.settings->'security'->>'idle_timeout_minutes' ~ '^([5-9]|[1-9][0-9]|1[0-9][0-9]|2[0-3][0-9]|240)$'
    AND NOT ((r.code='student' AND coalesce(s.settings->'security'->'student_login_enabled'='false'::jsonb,false))
      OR (r.code='parent' AND coalesce(s.settings->'security'->'parent_login_enabled'='false'::jsonb,false)));
 END IF;
 RETURN jsonb_build_object('live',true,'idle_expires_at',idle_end);
END $$;
REVOKE ALL ON FUNCTION app.check_workspace_login_session(uuid,uuid,boolean,boolean,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.check_workspace_login_session(uuid,uuid,boolean,boolean,timestamptz) TO app_api;

CREATE OR REPLACE FUNCTION app.observe_login_session(uid uuid,sid uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT (app.check_workspace_login_session(uid,sid,false,true,NULL)->>'live')::boolean
$$;

-- Keep ownership and revocation semantics while attaching the initiating device to the event.
CREATE OR REPLACE FUNCTION app.end_account_sessions(current_sid uuid,target_sid uuid,others boolean DEFAULT false)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE changed integer; uid uuid:=app.user_id(); device_ip inet; agent text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('account-sessions:'||uid::text,0));
 SELECT s.ip,s.user_agent INTO device_ip,agent FROM auth.sessions s
 WHERE s.id=current_sid AND app.own_live_session(current_sid);
 IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_EXPIRED' USING ERRCODE='28000'; END IF;
 DELETE FROM auth.sessions WHERE user_id=uid AND
   (CASE WHEN others THEN id<>current_sid ELSE id=target_sid END);
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN
  INSERT INTO app.account_security_events(user_id,session_id,kind,affected_count,email_status,ip_address,device_label)
   VALUES(uid,CASE WHEN others THEN current_sid ELSE target_sid END,
    CASE WHEN others THEN 'OTHER_SESSIONS_ENDED' ELSE 'SESSION_ENDED' END,changed,'NOT_REQUIRED',
    device_ip,app.security_device_label(agent));
 END IF;
 RETURN changed;
END $$;

DROP FUNCTION app.claim_login_alerts(uuid);
CREATE FUNCTION app.claim_login_alerts(lease uuid)
RETURNS TABLE(id uuid,email text,login_at timestamptz,attempts integer,unfamiliar_network boolean)
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
 ) SELECT c.id,au.email::text,c.created_at,c.attempts,c.unfamiliar_network
   FROM claimed c JOIN auth.users au ON au.id=c.user_id;
END $$;
REVOKE ALL ON FUNCTION app.claim_login_alerts(uuid) FROM PUBLIC,anon,authenticated,app_api,app_platform,app_device;
GRANT EXECUTE ON FUNCTION app.claim_login_alerts(uuid) TO app_worker;

-- The school membership is the school deactivation switch. Do not revoke other
-- schools' or platform access when a shared identity loses one membership.
CREATE FUNCTION app.end_deactivated_workspace_sessions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.status IS DISTINCT FROM 'ACTIVE' OR NEW.status NOT IN ('SUSPENDED','REMOVED') THEN
  RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('workspace-security:'||NEW.user_id::text,0));
 IF NOT EXISTS(SELECT FROM school_memberships m WHERE m.user_id=NEW.user_id AND m.status='ACTIVE')
  AND NOT EXISTS(SELECT FROM platform_staff p WHERE p.user_id=NEW.user_id) THEN
  WITH ended AS (
   DELETE FROM auth.sessions s WHERE s.user_id=NEW.user_id RETURNING s.id,s.ip,s.user_agent
  ) INSERT INTO app.account_security_events(user_id,session_id,kind,email_status,ip_address,device_label)
    SELECT NEW.user_id,id,'SESSION_ENDED','NOT_REQUIRED',ip,app.security_device_label(user_agent) FROM ended;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.end_deactivated_workspace_sessions() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER revoke_deactivated_workspace AFTER UPDATE OF status ON school_memberships
 FOR EACH ROW EXECUTE FUNCTION app.end_deactivated_workspace_sessions();

CREATE FUNCTION app.audit_workspace_identity_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE target uuid;
BEGIN
 IF NEW.status='DISABLED' AND OLD.status IS DISTINCT FROM NEW.status THEN
  DELETE FROM auth.sessions WHERE user_id=NEW.id;
 END IF;
 FOR target IN SELECT school_id FROM school_memberships WHERE user_id=NEW.id AND status='ACTIVE' LOOP
  IF OLD.email IS DISTINCT FROM NEW.email THEN
   INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id)
    VALUES(target,'USER',NEW.id,'auth.email_changed','authentication',NEW.id);
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('ACTIVE','DISABLED') THEN
   INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id)
    VALUES(target,'SYSTEM',app.user_id(),CASE WHEN NEW.status='ACTIVE' THEN 'auth.account_activated'
     ELSE 'auth.account_deactivated' END,'authentication',NEW.id);
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.audit_workspace_identity_change() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER audit_workspace_identity AFTER UPDATE OF email,status ON users
 FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.status IS DISTINCT FROM NEW.status)
 EXECUTE FUNCTION app.audit_workspace_identity_change();

-- Fixed fields only. Never return Auth payloads, user agents, credentials, or
-- global account events from identities that belong to another tenant.
CREATE FUNCTION app.school_security_events(max_rows integer, skip_rows integer)
RETURNS TABLE(id text,actor text,account text,action text,outcome text,occurred_at timestamptz,ip_address text,device text,source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE school uuid:=app.school_id();
BEGIN
 IF app.school_role(school) IS DISTINCT FROM 'school_admin' THEN
  RAISE EXCEPTION 'SECURITY_AUDIT_ADMIN_REQUIRED' USING ERRCODE='42501';
 END IF;
 RETURN QUERY WITH local_accounts AS (
  SELECT m.user_id,m.created_at AS joined_at,m.updated_at AS membership_changed,m.status,u.full_name
   FROM school_memberships m JOIN users u ON u.id=m.user_id WHERE m.school_id=school
     AND NOT EXISTS(SELECT FROM school_memberships x WHERE x.user_id=m.user_id AND x.school_id<>school)
     AND NOT EXISTS(SELECT FROM platform_staff p WHERE p.user_id=m.user_id)
 ), events AS (
  SELECT 'app:'||e.id AS event_id,m.full_name AS performed_by,m.full_name AS subject,
    CASE WHEN e.kind='NEW_LOGIN' THEN 'Session created'
      WHEN e.kind='MFA_VERIFIED' THEN 'Authenticator verified'
      WHEN e.kind='OTHER_SESSIONS_ENDED' THEN 'Other sessions terminated' ELSE 'Session terminated' END AS event_action,
    'SUCCESS'::text AS result,e.created_at AS event_time,host(e.ip_address) AS event_ip,e.device_label AS event_device,
    'VIDYALAYAA'::text AS event_source
  FROM app.account_security_events e JOIN local_accounts m ON m.user_id=e.user_id
  WHERE e.created_at>now()-interval '90 days' AND e.created_at>=m.joined_at
    AND (m.status='ACTIVE' OR e.created_at<=m.membership_changed)
  UNION ALL
  SELECT 'audit:'||l.id,u.full_name,subject.full_name,
   CASE
    WHEN l.action='security.policy.updated' THEN 'Security policy updated'
    WHEN l.action='auth.email_changed' THEN 'Verified email changed'
    WHEN l.action='auth.account_activated' THEN 'Account activated'
    WHEN l.action='auth.account_deactivated' THEN 'Account deactivated'
    WHEN l.entity_type='authentication' THEN 'Privileged sign-in'
    WHEN l.before->>'status' IS DISTINCT FROM l.after->>'status' AND l.after->>'status'='ACTIVE' THEN 'School membership activated'
    WHEN l.before->>'status' IS DISTINCT FROM l.after->>'status' AND l.after->>'status' IN ('SUSPENDED','REMOVED') THEN 'School membership deactivated'
    WHEN l.before->>'role_id' IS DISTINCT FROM l.after->>'role_id' THEN 'School role assigned or changed'
    ELSE 'School membership updated'
   END,'SUCCESS',l.occurred_at,host(l.ip),app.security_device_label(l.user_agent),'VIDYALAYAA'
  FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id
  LEFT JOIN users subject ON subject.id::text=coalesce(l.after->>'user_id',
    CASE WHEN l.action IN ('auth.email_changed','auth.account_activated','auth.account_deactivated') THEN l.entity_id::text
      WHEN l.action='auth.privileged_login' THEN l.actor_id::text END)
  WHERE l.school_id=school AND l.occurred_at>now()-interval '90 days' AND (
   l.action IN ('security.policy.updated','auth.email_changed','auth.account_activated','auth.account_deactivated','auth.privileged_login')
   OR (l.entity_type='school_memberships' AND
    (l.before->>'status' IS DISTINCT FROM l.after->>'status' OR l.before->>'role_id' IS DISTINCT FROM l.after->>'role_id')))
  UNION ALL
  SELECT 'auth:'||e.id,m.full_name,m.full_name,
   CASE e.payload->>'action'
    WHEN 'login' THEN 'Provider sign-in'
    WHEN 'login_failed' THEN 'Provider sign-in failed'
    WHEN 'logout' THEN 'Provider sign-out'
    WHEN 'user_updated_password' THEN 'Password changed'
    WHEN 'factor_in_progress' THEN 'MFA enrollment started'
    WHEN 'factor_unenrolled' THEN 'MFA factor removed'
    WHEN 'factor_deleted' THEN 'MFA factor removed'
    WHEN 'mfa_code_login' THEN 'MFA sign-in'
    ELSE 'MFA verification attempted'
   END,
   CASE WHEN e.payload->>'action'='login_failed' THEN 'FAILED'
        WHEN e.payload->>'action' IN ('login','verification_attempted','factor_in_progress') THEN 'ATTEMPTED'
        ELSE 'SUCCESS' END,
   e.created_at,
   CASE WHEN e.ip_address::text ~ '^[0-9a-fA-F:.]{3,45}$' THEN e.ip_address::text END,
   NULL,'SUPABASE'
  FROM auth.audit_log_entries e JOIN local_accounts m ON m.user_id::text=e.payload->>'actor_id'
  WHERE e.created_at>now()-interval '90 days' AND e.created_at>=m.joined_at
   AND (m.status='ACTIVE' OR e.created_at<=m.membership_changed)
   AND e.payload->>'action' IN ('login','login_failed','logout','user_updated_password','factor_in_progress',
    'factor_unenrolled','factor_deleted','verification_attempted','mfa_code_login')
 ) SELECT event_id,performed_by,subject,event_action,result,event_time,event_ip,event_device,event_source
   FROM events WHERE event_time>now()-interval '90 days' ORDER BY event_time DESC,event_id DESC
   LIMIT least(greatest(max_rows,1),101) OFFSET greatest(skip_rows,0);
END $$;
REVOKE ALL ON FUNCTION app.school_security_events(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.school_security_events(integer,integer) TO app_api;
