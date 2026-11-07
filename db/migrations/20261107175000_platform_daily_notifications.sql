CREATE TABLE app.platform_daily_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
 body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
 local_time time NOT NULL CHECK (local_time < time '24:00' AND extract(second FROM local_time)=0),
 timezone text NOT NULL,
 next_run_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL REFERENCES public.users(id),
 retry_key text NOT NULL,
 UNIQUE (school_id,created_by,retry_key)
);
ALTER TABLE app.platform_daily_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.platform_daily_notifications FROM PUBLIC,anon,authenticated,app_api,app_device,app_platform,app_worker;
CREATE INDEX platform_daily_due ON app.platform_daily_notifications (school_id,next_run_at)
 WHERE next_run_at IS NOT NULL;

CREATE FUNCTION app.platform_daily_school_timezone(target_school uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT s.timezone FROM schools s WHERE s.id=target_school AND s.status='ACTIVE'
  AND (SELECT sub.status FROM subscriptions sub WHERE sub.school_id=s.id
       ORDER BY sub.created_at DESC LIMIT 1) IN ('TRIALING','ACTIVE','PAST_DUE')
  AND NOT EXISTS (SELECT FROM school_offboarding off WHERE off.school_id=s.id
   AND off.status IN ('CLOSED','PURGE_REQUESTED','PURGING','PURGED'))
$$;

CREATE FUNCTION app.create_platform_daily_notification(target_school uuid,message_title text,
 message_body text,send_time time,request_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE uid uuid:=app.user_id(); result uuid; zone text; local_today date; next_send timestamptz;
 previous app.platform_daily_notifications%ROWTYPE;
BEGIN
 IF NOT app.is_platform_staff() THEN RAISE EXCEPTION 'Platform access denied' USING ERRCODE='42501'; END IF;
 IF target_school IS NULL OR message_title IS NULL OR message_body IS NULL OR send_time IS NULL
   OR request_key IS NULL OR request_key!~'^[a-zA-Z0-9:_-]{8,200}$'
   OR length(btrim(message_title)) NOT BETWEEN 1 AND 120 OR length(btrim(message_body)) NOT BETWEEN 1 AND 1000
   OR send_time>=time '24:00' OR extract(second FROM send_time)<>0 THEN
  RAISE EXCEPTION 'NOTIFICATION_INVALID' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(target_school||':PLATFORM_DAILY:'||uid||':'||request_key,0));
 SELECT d.* INTO previous FROM app.platform_daily_notifications d
  WHERE d.school_id=target_school AND d.created_by=uid AND d.retry_key=request_key;
 IF FOUND THEN
  IF ROW(previous.title,previous.body,previous.local_time)
     IS DISTINCT FROM ROW(btrim(message_title),btrim(message_body),send_time) THEN
   RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';
  END IF;
  RETURN previous.id;
 END IF;

 zone:=app.platform_daily_school_timezone(target_school);
 IF zone IS NULL THEN RAISE EXCEPTION 'PLATFORM_NOTIFICATION_SCHOOL' USING ERRCODE='23514'; END IF;
 local_today:=(now() AT TIME ZONE zone)::date;
 next_send:=(local_today+send_time) AT TIME ZONE zone;
 IF next_send<=now() THEN next_send:=(local_today+1+send_time) AT TIME ZONE zone; END IF;
 INSERT INTO app.platform_daily_notifications(school_id,title,body,local_time,timezone,next_run_at,created_by,retry_key)
 VALUES(target_school,btrim(message_title),btrim(message_body),send_time,zone,next_send,uid,request_key)
 RETURNING id INTO result;
 INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after)
 VALUES(target_school,'USER',uid,'notification.platform_daily_created','platform_daily_notification',result,
  jsonb_build_object('local_time',send_time,'timezone',zone));
 RETURN result;
END $$;

CREATE FUNCTION app.platform_daily_notification_history()
RETURNS TABLE(id uuid,school_name text,title text,local_time text,timezone text,next_run_at timestamptz,
 status text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.is_platform_staff() THEN RAISE EXCEPTION 'Platform access denied' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT d.id,s.name,d.title,to_char(date '2000-01-01'+d.local_time,'HH24:MI'),
  d.timezone,d.next_run_at,
  CASE WHEN d.next_run_at IS NULL THEN 'CANCELLED'
       WHEN app.platform_daily_school_timezone(d.school_id) IS NULL THEN 'PAUSED'
       ELSE 'ACTIVE' END,
  d.created_at
 FROM app.platform_daily_notifications d JOIN schools s ON s.id=d.school_id;
END $$;

CREATE FUNCTION app.cancel_platform_daily_notification(target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE sid uuid;
BEGIN
 IF NOT app.is_platform_staff() THEN RAISE EXCEPTION 'Platform access denied' USING ERRCODE='42501'; END IF;
 UPDATE app.platform_daily_notifications SET next_run_at=NULL
  WHERE id=target AND next_run_at IS NOT NULL RETURNING school_id INTO sid;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id)
 VALUES(sid,'USER',app.user_id(),'notification.platform_daily_cancelled','platform_daily_notification',target);
 RETURN true;
END $$;

-- One outbox record per schedule and school-local date. Advance and enqueue atomically.
-- After downtime, only the current local day's occurrence can be queued.
CREATE FUNCTION app.enqueue_due_platform_daily_notifications() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE sid uuid:=app.school_id(); schedule app.platform_daily_notifications%ROWTYPE;
 local_today date; send_at timestamptz; recipients uuid[]; message_id uuid;
BEGIN
 FOR schedule IN SELECT d.* FROM app.platform_daily_notifications d
  WHERE d.school_id=sid AND d.next_run_at<=now() ORDER BY d.next_run_at,d.id
  FOR UPDATE SKIP LOCKED LIMIT 5
 LOOP
  local_today:=(now() AT TIME ZONE schedule.timezone)::date;
  send_at:=(local_today+schedule.local_time) AT TIME ZONE schedule.timezone;
  UPDATE app.platform_daily_notifications SET next_run_at=CASE WHEN send_at>now() THEN send_at
   ELSE (local_today+1+schedule.local_time) AT TIME ZONE schedule.timezone END
   WHERE id=schedule.id;
  IF send_at>now() OR app.platform_daily_school_timezone(sid) IS NULL THEN CONTINUE; END IF;

  SELECT ARRAY(SELECT m.user_id FROM school_memberships m JOIN users u ON u.id=m.user_id
   WHERE m.school_id=sid AND m.status='ACTIVE' AND u.status='ACTIVE'
   ORDER BY m.user_id LIMIT 5001) INTO recipients;
  IF cardinality(recipients) NOT BETWEEN 1 AND 5000 THEN CONTINUE; END IF;

  INSERT INTO notification_outbox(school_id,kind,dedupe_key,payload,created_by,scheduled_at,next_attempt_at)
  VALUES(sid,'CUSTOM','PLATFORM_NOTIFY:DAILY:'||schedule.id||':'||to_char(local_today,'YYYY-MM-DD'),
   jsonb_build_object('title',schedule.title,'body',schedule.body,'event_time',send_at,
    'recipients',cardinality(recipients)),NULL,send_at,send_at)
  ON CONFLICT (school_id,dedupe_key) DO NOTHING RETURNING id INTO message_id;
  IF message_id IS NOT NULL THEN
   INSERT INTO notification_recipient_targets(school_id,outbox_id,user_id)
   SELECT sid,message_id,x FROM unnest(recipients) x;
  END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app.cleanup_school_notification_settings() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF OLD.status='PURGING' AND NEW.status='PURGED' THEN
  DELETE FROM school_notification_settings WHERE school_id=NEW.school_id;
  DELETE FROM app.platform_daily_notifications WHERE school_id=NEW.school_id;
 END IF;
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.platform_daily_school_timezone(uuid),
 app.create_platform_daily_notification(uuid,text,text,time,text),app.platform_daily_notification_history(),
 app.cancel_platform_daily_notification(uuid),app.enqueue_due_platform_daily_notifications()
 FROM PUBLIC,anon,authenticated,app_api,app_device,app_platform,app_worker;
GRANT EXECUTE ON FUNCTION app.create_platform_daily_notification(uuid,text,text,time,text),
 app.platform_daily_notification_history(),app.cancel_platform_daily_notification(uuid) TO app_platform;
GRANT EXECUTE ON FUNCTION app.enqueue_due_platform_daily_notifications() TO app_worker;
