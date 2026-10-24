-- Extend the existing queue, delivery ledger and encrypted FCM endpoints.
INSERT INTO permissions(code) VALUES('notifications.manage'),('notifications.push') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='school_admin' AND p.code='notifications.manage' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code IN ('school_admin','principal','teacher','parent','student','finance_staff') AND p.code IN ('notifications.read','notifications.push') ON CONFLICT DO NOTHING;
CREATE FUNCTION app.notification_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT FROM school_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id WHERE m.school_id=app.school_id() AND m.user_id=app.user_id() AND m.status='ACTIVE' AND u.status='ACTIVE' AND r.code='school_admin');
$$;

CREATE TABLE school_notification_settings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL UNIQUE REFERENCES schools(id) ON DELETE CASCADE,enabled boolean NOT NULL DEFAULT true,
 channels jsonb NOT NULL DEFAULT '{"PUSH":true,"EMAIL":true,"SMS":true}',kinds jsonb NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 1 CHECK(version>0),updated_by uuid NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),
 CHECK(jsonb_typeof(channels)='object' AND jsonb_typeof(kinds)='object'));
ALTER TABLE school_notification_settings ENABLE ROW LEVEL SECURITY;ALTER TABLE school_notification_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY read_settings ON school_notification_settings FOR SELECT TO app_api,app_worker USING(school_id=app.school_id());
CREATE POLICY manage_settings ON school_notification_settings FOR ALL TO app_api USING(school_id=app.school_id() AND app.notification_admin()) WITH CHECK(school_id=app.school_id() AND app.notification_admin() AND updated_by=app.user_id());
REVOKE ALL ON school_notification_settings FROM PUBLIC,anon,authenticated,app_platform,app_device,app_worker,app_api;
GRANT SELECT,INSERT,UPDATE ON school_notification_settings TO app_api;GRANT SELECT ON school_notification_settings TO app_worker;
CREATE FUNCTION app.guard_notification_settings() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF EXISTS(SELECT FROM jsonb_each(NEW.channels) x WHERE x.key NOT IN ('PUSH','EMAIL','SMS') OR jsonb_typeof(x.value)<>'boolean') OR
 EXISTS(SELECT FROM jsonb_each(NEW.kinds) x WHERE x.key NOT IN ('STUDENT_ARRIVED','STUDENT_DEPARTED','STUDENT_ABSENT','ATTENDANCE_CORRECTED','FEE_REMINDER','ANNOUNCEMENT','DEVICE_ALERT','SUBSCRIPTION_UPDATE','CUSTOM') OR jsonb_typeof(x.value)<>'boolean') THEN RAISE EXCEPTION 'NOTIFICATION_SETTINGS_INVALID' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER validate_settings BEFORE INSERT OR UPDATE ON school_notification_settings FOR EACH ROW EXECUTE FUNCTION app.guard_notification_settings();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON school_notification_settings FOR EACH ROW EXECUTE FUNCTION app.audit_change();
CREATE FUNCTION app.notification_enabled(sid uuid,kind text,channel text) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT sid=app.school_id() AND coalesce((SELECT s.enabled AND coalesce((s.channels->>channel)::boolean,true) AND coalesce((s.kinds->>kind)::boolean,true) FROM school_notification_settings s WHERE s.school_id=sid),true);
$$;

ALTER TABLE notification_outbox ADD COLUMN created_by uuid DEFAULT app.user_id() REFERENCES users(id),ADD COLUMN cancelled_at timestamptz,ADD COLUMN cancelled_by uuid REFERENCES users(id);
CREATE TABLE notification_recipient_targets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL,outbox_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(school_id,outbox_id) REFERENCES notification_outbox(school_id,id) ON DELETE CASCADE,UNIQUE(school_id,id),UNIQUE(school_id,outbox_id,user_id));
CREATE INDEX notification_targets_user ON notification_recipient_targets(school_id,user_id,outbox_id);
ALTER TABLE notification_recipient_targets ENABLE ROW LEVEL SECURITY;ALTER TABLE notification_recipient_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY read_targets ON notification_recipient_targets FOR SELECT TO app_api USING(school_id=app.school_id() AND app.school_role(school_id) IS NOT NULL AND (app.notification_admin() OR user_id=app.user_id() OR app.school_role(school_id)='principal'));
CREATE POLICY worker_targets ON notification_recipient_targets FOR SELECT TO app_worker USING(school_id=app.school_id());
REVOKE ALL ON notification_recipient_targets FROM PUBLIC,anon,authenticated,app_api,app_platform,app_device,app_worker;
GRANT SELECT ON notification_recipient_targets TO app_api,app_worker;

-- Exact active school accounts only; no raw push tokens are exposed to administrators.
CREATE FUNCTION app.notification_members() RETURNS TABLE(user_id uuid,full_name text,email text,role text,push_devices bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF NOT app.notification_admin() THEN RAISE EXCEPTION 'Notification management denied' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT u.id,u.full_name,u.email::text,r.code,(SELECT count(*) FROM push_tokens t WHERE t.school_id=m.school_id AND t.user_id=u.id AND t.is_active AND t.last_seen_at>now()-interval '60 days')
 FROM school_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id
 WHERE m.school_id=app.school_id() AND m.status='ACTIVE' AND u.status='ACTIVE';
END $$;
CREATE FUNCTION app.queue_custom_notification(title text,body text,recipients uuid[],retry_key text,fingerprint text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE sid uuid:=app.school_id();uid uuid:=app.user_id();result uuid;old_hash text;BEGIN
 IF NOT app.notification_admin() THEN RAISE EXCEPTION 'Notification management denied' USING ERRCODE='42501';END IF;
 IF title IS NULL OR body IS NULL OR recipients IS NULL OR retry_key IS NULL OR fingerprint IS NULL OR length(btrim(title)) NOT BETWEEN 1 AND 120 OR length(btrim(body)) NOT BETWEEN 1 AND 1000 OR retry_key!~'^[a-zA-Z0-9:_-]{8,200}$' OR fingerprint!~'^[a-f0-9]{64}$' OR cardinality(recipients) NOT BETWEEN 1 AND 5000 OR array_position(recipients,NULL) IS NOT NULL THEN RAISE EXCEPTION 'NOTIFICATION_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('notification:'||sid||':'||uid||':'||retry_key,0));
 SELECT o.id,o.payload->>'request_hash' INTO result,old_hash FROM notification_outbox o WHERE o.school_id=sid AND o.dedupe_key='CUSTOM:'||uid||':'||retry_key;
 IF result IS NOT NULL THEN IF old_hash<>fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN result;END IF;
 IF EXISTS(SELECT x FROM unnest(recipients) x WHERE NOT EXISTS(SELECT FROM school_memberships m JOIN users u ON u.id=m.user_id WHERE m.school_id=sid AND m.user_id=x AND m.status='ACTIVE' AND u.status='ACTIVE')) THEN RAISE EXCEPTION 'NOTIFICATION_RECIPIENT_INVALID' USING ERRCODE='23514';END IF;
 INSERT INTO notification_outbox(school_id,kind,dedupe_key,payload,created_by) VALUES(sid,'CUSTOM','CUSTOM:'||uid||':'||retry_key,jsonb_build_object('title',btrim(title),'body',btrim(body),'request_hash',fingerprint),uid) RETURNING id INTO result;
 INSERT INTO notification_recipient_targets(school_id,outbox_id,user_id) SELECT sid,result,x FROM (SELECT DISTINCT unnest(recipients) x) t;
 INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES(sid,'USER',uid,'notification.custom_queued','notification_outbox',result,jsonb_build_object('recipients',cardinality(recipients)));
 RETURN result;END $$;
CREATE FUNCTION app.guard_custom_notification() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF TG_OP='INSERT' THEN IF NEW.kind='CUSTOM' AND current_user='app_api' THEN RAISE EXCEPTION 'Use authorized notification queue' USING ERRCODE='42501';END IF;
 ELSE
  IF (OLD.kind='CUSTOM' OR NEW.kind='CUSTOM') AND ROW(NEW.kind,NEW.payload,NEW.school_id,NEW.created_by,NEW.dedupe_key) IS DISTINCT FROM ROW(OLD.kind,OLD.payload,OLD.school_id,OLD.created_by,OLD.dedupe_key) THEN RAISE EXCEPTION 'NOTIFICATION_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF ROW(NEW.cancelled_at,NEW.cancelled_by) IS DISTINCT FROM ROW(OLD.cancelled_at,OLD.cancelled_by) THEN IF NOT app.notification_admin() THEN RAISE EXCEPTION 'Cancellation denied' USING ERRCODE='42501';END IF;END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER custom_immutable BEFORE INSERT OR UPDATE ON notification_outbox FOR EACH ROW EXECUTE FUNCTION app.guard_custom_notification();
CREATE FUNCTION app.cancel_school_notification(target uuid,reason text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ DECLARE changed integer;BEGIN
 IF NOT app.notification_admin() OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 5 AND 1000 THEN RAISE EXCEPTION 'Cancellation denied' USING ERRCODE='42501';END IF;
 UPDATE notification_outbox SET cancelled_at=now(),cancelled_by=app.user_id(),status='COMPLETED',completed_at=now(),last_error='CANCELLED_BY_SCHOOL',lease_token=NULL,locked_until=NULL WHERE school_id=app.school_id() AND id=target AND status IN ('PENDING','PROCESSING') AND cancelled_at IS NULL;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN
  UPDATE notification_deliveries SET status='SUPPRESSED',last_error='CANCELLED_BY_SCHOOL' WHERE school_id=app.school_id() AND outbox_id=target AND status IN ('PENDING','FAILED');
  INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES(app.school_id(),'USER',app.user_id(),'notification.cancelled','notification_outbox',target,jsonb_build_object('reason',reason));
 END IF;RETURN changed>0;END $$;

-- Scope history at the database as well as the API. Legacy parent links/publications remain checked.
CREATE FUNCTION app.notification_visible(sid uuid,oid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE uid uuid:=app.user_id();r text;o notification_outbox;BEGIN
 IF sid<>app.school_id() OR NOT EXISTS(SELECT FROM school_memberships m JOIN users u ON u.id=m.user_id WHERE m.school_id=sid AND m.user_id=uid AND m.status='ACTIVE' AND u.status='ACTIVE') THEN RETURN false;END IF;
 r:=app.school_role(sid);IF r IN ('school_admin','principal') THEN RETURN true;END IF;
 SELECT * INTO o FROM notification_outbox WHERE school_id=sid AND id=oid;IF NOT FOUND THEN RETURN false;END IF;
 IF o.kind='CUSTOM' THEN RETURN EXISTS(SELECT FROM notification_recipient_targets t WHERE t.school_id=sid AND t.outbox_id=oid AND t.user_id=uid);END IF;
 IF o.created_by=uid THEN RETURN true;END IF;
 IF r='parent' AND o.payload->>'class_id' IS NOT NULL AND NOT EXISTS(SELECT FROM enrollments en JOIN student_parents sp ON sp.school_id=en.school_id AND sp.student_id=en.student_id JOIN parents p ON p.school_id=sp.school_id AND p.id=sp.parent_id WHERE en.school_id=sid AND en.class_id=(o.payload->>'class_id')::uuid AND en.status='ACTIVE' AND sp.status='ACTIVE' AND p.status='ACTIVE' AND p.user_id=uid) THEN RETURN false;END IF;
 IF o.kind='ANNOUNCEMENT' AND NOT EXISTS(SELECT FROM announcements a WHERE a.school_id=sid AND a.id=(o.payload->>'announcement_id')::uuid AND a.published_at<=now() AND (r<>'parent' OR a.audience<>'STAFF')) THEN RETURN false;END IF;
 RETURN EXISTS(SELECT FROM notification_deliveries d WHERE d.school_id=sid AND d.outbox_id=oid AND (
  (r<>'parent' AND d.recipient_user_id=uid) OR EXISTS(SELECT FROM parents p WHERE p.school_id=sid AND p.id=d.parent_id AND p.user_id=uid AND p.status='ACTIVE'
   AND (o.student_id IS NULL OR EXISTS(SELECT FROM student_parents sp JOIN students s ON s.school_id=sp.school_id AND s.id=sp.student_id WHERE sp.school_id=sid AND sp.parent_id=p.id AND sp.student_id=o.student_id AND sp.status='ACTIVE' AND s.status='ACTIVE')))));
END $$;
DROP POLICY IF EXISTS finance_scope ON notification_outbox;DROP POLICY IF EXISTS finance_scope ON notification_deliveries;DROP POLICY IF EXISTS finance_scope ON notification_attempts;DROP POLICY IF EXISTS finance_scope ON push_tokens;
CREATE POLICY notification_read ON notification_outbox AS RESTRICTIVE FOR SELECT TO app_api USING((created_by=app.user_id() AND app.school_role(school_id) IS NOT NULL) OR app.notification_visible(school_id,id));
CREATE POLICY notification_delivery_read ON notification_deliveries AS RESTRICTIVE FOR SELECT TO app_api USING(app.notification_visible(school_id,outbox_id) AND (app.school_role(school_id) IN ('school_admin','principal') OR recipient_user_id=app.user_id() OR EXISTS(SELECT FROM parents p WHERE p.school_id=notification_deliveries.school_id AND p.id=parent_id AND p.user_id=app.user_id() AND p.status='ACTIVE')));
CREATE POLICY notification_attempt_read ON notification_attempts AS RESTRICTIVE FOR SELECT TO app_api USING(EXISTS(SELECT FROM notification_deliveries d WHERE d.school_id=notification_attempts.school_id AND d.id=delivery_id));

CREATE OR REPLACE FUNCTION app.register_push_endpoint(h text,encrypted text,device_platform text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE uid uuid:=app.user_id();sid uuid:=app.school_id();result uuid;BEGIN
 IF h IS NULL OR encrypted IS NULL OR length(encrypted)<20 OR device_platform IS NULL OR h!~'^[a-f0-9]{64}$' OR length(encrypted)>12000 OR device_platform NOT IN ('WEB','ANDROID','IOS') OR NOT EXISTS(SELECT FROM school_memberships m JOIN users u ON u.id=m.user_id WHERE m.school_id=sid AND m.user_id=uid AND m.status='ACTIVE' AND u.status='ACTIVE') THEN RAISE EXCEPTION 'Push registration denied' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('push:'||h,0));
 INSERT INTO app.push_endpoint_owners VALUES(h,uid) ON CONFLICT(token_hash) DO UPDATE SET user_id=EXCLUDED.user_id;
 UPDATE push_tokens SET is_active=false WHERE token_hash=h AND user_id<>uid;
 INSERT INTO push_tokens(school_id,user_id,token_hash,token_encrypted,platform) VALUES(sid,uid,h,encrypted,device_platform) ON CONFLICT(school_id,user_id,token_hash) DO UPDATE SET is_active=true,last_seen_at=now(),token_encrypted=EXCLUDED.token_encrypted RETURNING id INTO result;RETURN result;END $$;

CREATE OR REPLACE FUNCTION app.retry_notification(delivery uuid,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid;sid uuid:=app.school_id();BEGIN
 IF NOT app.notification_admin() OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 5 AND 1000 THEN RAISE EXCEPTION 'Retry denied' USING ERRCODE='42501';END IF;
 SELECT d.outbox_id INTO target FROM notification_deliveries d JOIN notification_outbox o ON o.school_id=d.school_id AND o.id=d.outbox_id WHERE d.school_id=sid AND d.id=delivery AND (d.status IN ('FAILED','DEAD') OR (d.status='SUPPRESSED' AND d.last_error IN ('NO_ENABLED_DEVICE','SCHOOL_POLICY_DISABLED'))) AND o.cancelled_at IS NULL;
 IF target IS NULL THEN RAISE EXCEPTION 'No retryable delivery' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM notification_outbox WHERE school_id=sid AND id=target AND cancelled_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'No retryable delivery' USING ERRCODE='23514';END IF;
 UPDATE notification_deliveries SET status='PENDING',attempts=0,last_error=NULL,next_attempt_at=now() WHERE school_id=sid AND id=delivery;
 UPDATE notification_outbox SET status='PENDING',attempts=0,next_attempt_at=now(),locked_until=NULL,lease_token=NULL,last_error=NULL,completed_at=NULL WHERE school_id=sid AND id=target;
 INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES(sid,'USER',app.user_id(),'notification.retry','notification_outbox',target,jsonb_build_object('reason',reason));END $$;

REVOKE ALL ON FUNCTION app.notification_admin(),app.notification_enabled(uuid,text,text),app.guard_notification_settings(),app.guard_custom_notification(),app.notification_members(),app.queue_custom_notification(text,text,uuid[],text,text),app.cancel_school_notification(uuid,text),app.notification_visible(uuid,uuid) FROM PUBLIC,anon,authenticated,app_api,app_device,app_platform,app_worker;
GRANT EXECUTE ON FUNCTION app.notification_admin(),app.notification_members(),app.queue_custom_notification(text,text,uuid[],text,text),app.cancel_school_notification(uuid,text),app.notification_visible(uuid,uuid) TO app_api;
GRANT EXECUTE ON FUNCTION app.notification_enabled(uuid,text,text) TO app_api,app_worker;
-- Cascading target cleanup integrates with the existing approved purge/retention paths.

-- Old workers must not treat a new custom message as a legacy parent broadcast.
-- This is deployment compatibility, not an authorization grant.
CREATE POLICY custom_worker_protocol ON notification_outbox AS RESTRICTIVE FOR ALL TO app_worker
 USING(kind<>'CUSTOM' OR current_setting('app.notification_protocol',true)='custom-v1')
 WITH CHECK(kind<>'CUSTOM' OR current_setting('app.notification_protocol',true)='custom-v1');
