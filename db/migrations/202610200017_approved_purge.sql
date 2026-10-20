ALTER TABLE school_offboarding ADD COLUMN storage_purged_at timestamptz;
ALTER TABLE school_offboarding ADD COLUMN last_error text;
-- This narrow maintenance capability is distinct from normal immutable-record privileges.
CREATE FUNCTION app.purge_approved_school(job uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE ob school_offboarding;t text;BEGIN
 SELECT * INTO ob FROM school_offboarding WHERE id=job AND school_id=app.school_id() FOR UPDATE;
 IF ob.id IS NULL OR ob.status<>'PURGING' OR ob.legal_hold OR ob.school_approved_by IS NULL OR ob.closed_by IS NULL
 OR ob.school_approved_by=ob.closed_by OR ob.purge_requested_by IS NULL OR ob.storage_purged_at IS NULL
 OR now()<ob.delete_after OR now()<ob.export_until OR NOT EXISTS(SELECT FROM school_exports WHERE school_id=ob.school_id AND status='COMPLETED' AND completed_at>=ob.closed_at)
 THEN RAISE EXCEPTION 'PURGE_NOT_APPROVED' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM devices WHERE school_id=ob.school_id AND status<>'REVOKED') THEN RAISE EXCEPTION 'DEVICES_NOT_RETIRED';END IF;
 -- Explicit dependency order; never disable FK, RLS, or immutable-audit controls.
 FOREACH t IN ARRAY ARRAY['push_delivery_targets','notification_attempts','notification_deliveries','notification_outbox',
 'notification_preferences','push_tokens','attendance_reconciliation_requests','attendance_corrections','daily_attendance','attendance_events',
 'nfc_cards','marks','fee_records','assignments','timetable_entries','teacher_class_assignments','school_holidays','attendance_rule_versions',
 'report_documents','api_idempotency_keys','student_parents','enrollments','exams','device_ota_assignments','device_ota_status','device_heartbeats','device_logs','device_configurations',
 'device_credentials','devices','device_locations','classes','subjects','academic_sessions','students','parents','teachers','school_invitations'] LOOP
  EXECUTE format('DELETE FROM %I WHERE school_id=$1',t) USING ob.school_id;
 END LOOP;
 UPDATE school_exports SET status='EXPIRED',manifest='[]' WHERE school_id=ob.school_id;
 UPDATE schools SET status='TERMINATED',settings='{}',access_version=access_version+1 WHERE id=ob.school_id;
 UPDATE school_offboarding SET status='PURGED',purged_at=now(),last_error=NULL WHERE id=job;
 INSERT INTO audit_logs(school_id,actor_type,action,entity_type,entity_id,after) VALUES(ob.school_id,'SYSTEM','school.operational_data_purged','school_offboarding',job,jsonb_build_object('policy_ref',ob.policy_ref,'school_approved_by',ob.school_approved_by,'closed_by',ob.closed_by,'purge_requested_by',ob.purge_requested_by));
 -- Global Auth identities, immutable audit, contractual subscription metadata and usage aggregates
 -- are deliberately retained under their separate approved retention policies. They may serve other schools.
END $$;
REVOKE ALL ON FUNCTION app.purge_approved_school(uuid) FROM PUBLIC,anon,authenticated,app_api,app_device,app_platform;
GRANT EXECUTE ON FUNCTION app.purge_approved_school(uuid) TO app_worker;
