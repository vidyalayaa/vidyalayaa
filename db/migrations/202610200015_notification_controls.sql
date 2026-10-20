ALTER TABLE parents ADD COLUMN no_names_on_lock_screen boolean NOT NULL DEFAULT true;
CREATE FUNCTION app.retry_notification(delivery uuid,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE target uuid;sid uuid:=app.school_id();BEGIN
 IF length(reason)<5 OR NOT EXISTS(SELECT FROM school_memberships m JOIN role_permissions rp ON rp.role_id=m.role_id JOIN permissions p ON p.id=rp.permission_id WHERE m.school_id=sid AND m.user_id=app.user_id() AND m.status='ACTIVE' AND p.code='users.manage') THEN RAISE EXCEPTION 'Retry denied' USING ERRCODE='42501';END IF;
 SELECT outbox_id INTO target FROM notification_deliveries WHERE school_id=sid AND id=delivery AND status IN ('FAILED','DEAD');
 IF target IS NULL THEN RAISE EXCEPTION 'No retryable delivery' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM notification_outbox WHERE school_id=sid AND id=target FOR UPDATE;
 UPDATE notification_deliveries SET status='PENDING',attempts=0,last_error=NULL,next_attempt_at=now() WHERE school_id=sid AND outbox_id=target AND status IN ('FAILED','DEAD');
 UPDATE notification_outbox SET status='PENDING',attempts=0,next_attempt_at=now(),locked_until=NULL,lease_token=NULL,last_error=NULL,completed_at=NULL WHERE school_id=sid AND id=target;
 INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES(sid,'USER',app.user_id(),'notification.retry','notification_outbox',target,jsonb_build_object('reason',reason));
END $$;
REVOKE ALL ON FUNCTION app.retry_notification(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.retry_notification(uuid,text) TO app_api;
