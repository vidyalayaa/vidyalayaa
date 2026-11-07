ALTER TABLE notification_outbox ADD COLUMN scheduled_at timestamptz;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_schedule_due
 CHECK (scheduled_at IS NULL OR next_attempt_at>=scheduled_at);
CREATE INDEX platform_notification_history ON notification_outbox(created_at DESC,id DESC)
 WHERE kind='CUSTOM' AND dedupe_key LIKE 'PLATFORM_NOTIFY:%';

CREATE OR REPLACE FUNCTION app.guard_custom_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE queue_owner name:=pg_get_userbyid((SELECT proowner FROM pg_proc
 WHERE oid='app.queue_custom_notification(text,text,uuid[],text,text)'::regprocedure));
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.kind='CUSTOM' AND current_user<>queue_owner THEN
   RAISE EXCEPTION 'Use authorized notification queue' USING ERRCODE='42501';
  END IF;
 ELSE
  IF (OLD.kind='CUSTOM' OR NEW.kind='CUSTOM') AND
   ROW(NEW.kind,NEW.payload,NEW.school_id,NEW.created_by,NEW.dedupe_key,NEW.scheduled_at) IS DISTINCT FROM
   ROW(OLD.kind,OLD.payload,OLD.school_id,OLD.created_by,OLD.dedupe_key,OLD.scheduled_at) THEN
   RAISE EXCEPTION 'NOTIFICATION_HISTORY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.cancelled_at,NEW.cancelled_by) IS DISTINCT FROM ROW(OLD.cancelled_at,OLD.cancelled_by) THEN
   IF NOT (current_user=queue_owner AND OLD.kind='CUSTOM'
     AND OLD.dedupe_key LIKE 'PLATFORM_NOTIFY:%' AND app.is_platform_staff())
     AND NOT app.notification_admin() THEN
    RAISE EXCEPTION 'Cancellation denied' USING ERRCODE='42501';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- Leadership can see the school queue. A recipient only sees a platform
-- message after release, and never sees a cancelled platform message.
CREATE POLICY platform_notification_release ON notification_outbox AS RESTRICTIVE FOR SELECT TO app_api
 USING (dedupe_key NOT LIKE 'PLATFORM_NOTIFY:%'
   OR app.school_role(school_id) IN ('school_admin','principal')
   OR (cancelled_at IS NULL AND coalesce(scheduled_at,created_at)<=now()));

CREATE FUNCTION app.queue_platform_notification(target_school uuid,title text,body text,
  send_at timestamptz,retry_key text,fingerprint text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE uid uuid:=app.user_id(); result uuid; old_hash text; recipients uuid[];
  entry_key text:='PLATFORM_NOTIFY:'||uid||':'||retry_key;
BEGIN
 IF NOT app.is_platform_staff() THEN RAISE EXCEPTION 'Platform access denied' USING ERRCODE='42501'; END IF;
 IF target_school IS NULL OR title IS NULL OR body IS NULL OR retry_key IS NULL OR fingerprint IS NULL
   OR length(btrim(title)) NOT BETWEEN 1 AND 120 OR length(btrim(body)) NOT BETWEEN 1 AND 1000
   OR retry_key!~'^[a-zA-Z0-9:_-]{8,200}$' OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'NOTIFICATION_INVALID' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(target_school||':'||entry_key,0));
 SELECT o.id,o.payload->>'request_hash' INTO result,old_hash FROM notification_outbox o
  WHERE o.school_id=target_school AND o.dedupe_key=entry_key;
 IF result IS NOT NULL THEN
  IF old_hash IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23514'; END IF;
  RETURN result;
 END IF;
 IF send_at IS NOT NULL AND (send_at<=now() OR send_at>now()+interval '1 year') THEN
  RAISE EXCEPTION 'PLATFORM_NOTIFICATION_TIME' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM schools s WHERE s.id=target_school AND s.status='ACTIVE'
  AND (SELECT sub.status FROM subscriptions sub WHERE sub.school_id=s.id
       ORDER BY sub.created_at DESC LIMIT 1) IN ('TRIALING','ACTIVE','PAST_DUE')
  AND NOT EXISTS(SELECT FROM school_offboarding off WHERE off.school_id=s.id
   AND off.status IN ('CLOSED','PURGE_REQUESTED','PURGING','PURGED')) FOR SHARE OF s;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_NOTIFICATION_SCHOOL' USING ERRCODE='23514'; END IF;
 SELECT ARRAY(SELECT m.user_id FROM school_memberships m JOIN users u ON u.id=m.user_id
   WHERE m.school_id=target_school AND m.status='ACTIVE' AND u.status='ACTIVE'
   ORDER BY m.user_id LIMIT 5001) INTO recipients;
 IF cardinality(recipients) NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'PLATFORM_NOTIFICATION_RECIPIENTS' USING ERRCODE='23514';
 END IF;
 INSERT INTO notification_outbox(school_id,kind,dedupe_key,payload,created_by,scheduled_at,next_attempt_at)
 VALUES(target_school,'CUSTOM',entry_key,jsonb_build_object('title',btrim(title),'body',btrim(body),
  'request_hash',fingerprint,'event_time',coalesce(send_at,now()),'recipients',cardinality(recipients)),
  uid,send_at,coalesce(send_at,now())) RETURNING id INTO result;
 INSERT INTO notification_recipient_targets(school_id,outbox_id,user_id)
  SELECT target_school,result,x FROM unnest(recipients) x;
 INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after)
  VALUES(target_school,'USER',uid,'notification.platform_queued','notification_outbox',result,
   jsonb_build_object('scheduled_at',send_at,'recipients',cardinality(recipients)));
 RETURN result;
END $$;

CREATE FUNCTION app.platform_notification_history()
RETURNS TABLE(id uuid,school_id uuid,school_name text,timezone text,title text,status text,
 scheduled_at timestamptz,created_at timestamptz,recipients integer,sent integer,failed integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.is_platform_staff() THEN RAISE EXCEPTION 'Platform access denied' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT o.id,o.school_id,s.name,s.timezone,o.payload->>'title',
  CASE WHEN o.cancelled_at IS NOT NULL THEN 'CANCELLED'
       WHEN o.status='PENDING' AND o.scheduled_at>now() THEN 'SCHEDULED'
       WHEN o.status='PENDING' AND o.attempts=0 THEN 'QUEUED'
       WHEN o.status='PENDING' THEN 'RETRYING' ELSE o.status END,
  o.scheduled_at,o.created_at,(o.payload->>'recipients')::int,d.sent,d.failed
 FROM notification_outbox o JOIN schools s ON s.id=o.school_id
 CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE nd.status='SENT')::int AS sent,
   count(*) FILTER (WHERE nd.status IN ('FAILED','DEAD'))::int AS failed
  FROM notification_deliveries nd WHERE nd.school_id=o.school_id AND nd.outbox_id=o.id
 ) d
 WHERE o.kind='CUSTOM' AND o.dedupe_key LIKE 'PLATFORM_NOTIFY:%';
END $$;

CREATE FUNCTION app.cancel_platform_notification(target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE sid uuid;
BEGIN
 IF NOT app.is_platform_staff() THEN RAISE EXCEPTION 'Platform access denied' USING ERRCODE='42501'; END IF;
 UPDATE notification_outbox SET cancelled_at=now(),cancelled_by=app.user_id(),
  status='COMPLETED',completed_at=now(),last_error='CANCELLED_BY_PLATFORM'
 WHERE id=target AND kind='CUSTOM' AND dedupe_key LIKE 'PLATFORM_NOTIFY:%'
  AND status='PENDING' AND attempts=0 AND cancelled_at IS NULL RETURNING school_id INTO sid;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id)
  VALUES(sid,'USER',app.user_id(),'notification.platform_cancelled','notification_outbox',target);
 RETURN true;
END $$;

REVOKE ALL ON FUNCTION app.queue_platform_notification(uuid,text,text,timestamptz,text,text),
 app.platform_notification_history(),app.cancel_platform_notification(uuid)
 FROM PUBLIC,anon,authenticated,app_api,app_device,app_worker;
GRANT EXECUTE ON FUNCTION app.queue_platform_notification(uuid,text,text,timestamptz,text,text),
 app.platform_notification_history(),app.cancel_platform_notification(uuid) TO app_platform;
