-- Generated documents can expire without deleting the underlying school records.
ALTER TABLE report_documents DROP CONSTRAINT report_documents_status_check;
ALTER TABLE report_documents ADD CONSTRAINT report_documents_status_check
 CHECK(status IN ('PENDING','PROCESSING','COMPLETED','FAILED','EXPIRED'));
CREATE INDEX report_retention_queue ON report_documents(school_id,created_at) WHERE status='COMPLETED' AND storage_path IS NOT NULL;
CREATE INDEX notification_retention_queue ON notification_outbox(school_id,completed_at) WHERE status='COMPLETED';

-- No cleanup occurs until the School Admin records an approved policy reference.
-- In-flight/dead work and append-only audit/child attendance records are retained.
CREATE FUNCTION app.prune_terminal_notifications() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE policy jsonb;days integer;ids uuid[];removed integer; BEGIN
 SELECT settings->'retention' INTO policy FROM schools WHERE id=app.school_id();
 IF policy IS NULL OR policy->>'approved_at' IS NULL OR policy->>'policy_ref' IS NULL THEN RETURN 0;END IF;
 days:=(policy->>'notification_days')::integer;
 IF days<7 OR days>3650 THEN RAISE EXCEPTION 'Invalid approved retention policy';END IF;
 SELECT array_agg(id) INTO ids FROM (SELECT id FROM notification_outbox WHERE school_id=app.school_id()
   AND status='COMPLETED' AND completed_at<now()-make_interval(days=>days)
   ORDER BY completed_at FOR UPDATE SKIP LOCKED LIMIT 100) old;
 IF ids IS NULL THEN RETURN 0;END IF;
 DELETE FROM push_delivery_targets WHERE school_id=app.school_id() AND delivery_id IN
   (SELECT id FROM notification_deliveries WHERE school_id=app.school_id() AND outbox_id=ANY(ids));
 DELETE FROM notification_attempts WHERE school_id=app.school_id() AND delivery_id IN
   (SELECT id FROM notification_deliveries WHERE school_id=app.school_id() AND outbox_id=ANY(ids));
 DELETE FROM notification_deliveries WHERE school_id=app.school_id() AND outbox_id=ANY(ids);
 DELETE FROM notification_outbox WHERE school_id=app.school_id() AND id=ANY(ids);
 GET DIAGNOSTICS removed=ROW_COUNT;
 INSERT INTO audit_logs(school_id,actor_type,action,entity_type,after) VALUES(app.school_id(),'SYSTEM','retention.notifications','notification_outbox',jsonb_build_object('removed',removed,'policy_ref',policy->>'policy_ref'));
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.prune_terminal_notifications() FROM PUBLIC,anon,authenticated,app_api,app_device,app_platform;
GRANT EXECUTE ON FUNCTION app.prune_terminal_notifications() TO app_worker;
