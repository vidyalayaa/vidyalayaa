-- Policy flags preserve existing account availability unless the school explicitly changes it.
CREATE FUNCTION app.school_security_policy(target_school uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
 SELECT coalesce(settings->'security','{}'::jsonb) FROM schools WHERE id=target_school;
$$;
REVOKE ALL ON FUNCTION app.school_security_policy(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.school_security_policy(uuid) TO app_api;

CREATE FUNCTION app.school_security_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.settings->'security' IS DISTINCT FROM OLD.settings->'security' THEN NEW.access_version=OLD.access_version+1;END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.school_security_changed() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER school_security BEFORE UPDATE ON schools FOR EACH ROW EXECUTE FUNCTION app.school_security_changed();

CREATE FUNCTION app.queue_device_security_alert(alert_code text,event_uuid uuid,device_uuid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE contact record;sid uuid:=app.school_id();
BEGIN
 IF alert_code NOT IN ('REJECTED_CARD_BLOCKED','QUARANTINED_TIMESTAMP','SEQUENCE_GAP','QUEUE_CORRUPTION','ABSENCE_PROVISIONAL') THEN RETURN;END IF;
 IF NOT EXISTS(SELECT FROM devices WHERE school_id=sid AND id=device_uuid) THEN RETURN;END IF;
 FOR contact IN SELECT u.id,u.email FROM school_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.school_id=sid AND m.status='ACTIVE' AND u.status='ACTIVE' AND r.code='school_admin' LOOP
  INSERT INTO notification_outbox(school_id,kind,dedupe_key,payload)
  VALUES(sid,'DEVICE_ALERT','SECURITY:'||device_uuid||':'||alert_code||':'||contact.id||':'||current_date,
   jsonb_build_object('recipient_user_id',contact.id,'recipient_email',contact.email,'alert_code',alert_code,'device_id',device_uuid,'event_id',event_uuid,'event_time',now()))
  ON CONFLICT(school_id,dedupe_key) DO NOTHING;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.queue_device_security_alert(text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.queue_device_security_alert(text,uuid,uuid) TO app_device,app_worker;
