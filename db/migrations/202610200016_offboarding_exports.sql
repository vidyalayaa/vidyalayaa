CREATE TABLE school_offboarding(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),
 requested_by uuid NOT NULL REFERENCES users(id),school_approved_by uuid REFERENCES users(id),closed_by uuid REFERENCES users(id),purge_requested_by uuid REFERENCES users(id),
 policy_ref text NOT NULL,reason text NOT NULL,export_until timestamptz NOT NULL,delete_after timestamptz NOT NULL,
 legal_hold boolean NOT NULL DEFAULT true,status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','APPROVED','CLOSED','PURGE_REQUESTED','PURGING','PURGED','CANCELLED')),
 closed_at timestamptz,purged_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(delete_after>=export_until),UNIQUE(school_id,id));
CREATE UNIQUE INDEX one_school_offboarding ON school_offboarding(school_id) WHERE status NOT IN ('CANCELLED','PURGED');
ALTER TABLE school_offboarding ENABLE ROW LEVEL SECURITY;ALTER TABLE school_offboarding FORCE ROW LEVEL SECURITY;
CREATE POLICY school ON school_offboarding TO app_api,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE POLICY platform ON school_offboarding TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());
GRANT SELECT,UPDATE ON school_offboarding TO app_api;
GRANT SELECT,INSERT,UPDATE ON school_offboarding TO app_platform;
GRANT SELECT,UPDATE ON school_offboarding TO app_worker;
CREATE TRIGGER touch BEFORE UPDATE ON school_offboarding FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON school_offboarding FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE TABLE school_exports(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),requested_by uuid NOT NULL REFERENCES users(id),
 format text NOT NULL CHECK(format IN ('JSON','CSV')),status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','FAILED','EXPIRED')),
 manifest jsonb NOT NULL DEFAULT '[]',snapshot_at timestamptz,completed_at timestamptz,error_code text,lease_token uuid,locked_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));
ALTER TABLE school_exports ENABLE ROW LEVEL SECURITY;ALTER TABLE school_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY school ON school_exports TO app_api,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE POLICY platform_metadata ON school_exports FOR SELECT TO app_platform USING(app.is_platform_staff());
GRANT SELECT,INSERT ON school_exports TO app_api;
GRANT SELECT,UPDATE ON school_exports TO app_worker;
GRANT SELECT ON school_exports TO app_platform;
CREATE TRIGGER touch BEFORE UPDATE ON school_exports FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE FUNCTION app.close_approved_school(job uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE ob school_offboarding;previous text;subid uuid;BEGIN
 IF NOT app.is_platform_staff() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';END IF;
 SELECT * INTO ob FROM school_offboarding WHERE id=job FOR UPDATE;
 IF ob.status<>'APPROVED' OR ob.school_approved_by IS NULL OR ob.school_approved_by=app.user_id() OR ob.export_until<=now() THEN RAISE EXCEPTION 'OFFBOARDING_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM devices WHERE school_id=ob.school_id AND status IN ('ACTIVE','DISABLED') AND (pending_event_count>0 OR last_seen_at IS NULL OR last_seen_at<now()-interval '5 minutes')) THEN RAISE EXCEPTION 'DEVICE_SYNC_REQUIRED' USING ERRCODE='23514';END IF;
 -- Device row locks synchronize with ingest's per-event FOR SHARE check.
 UPDATE devices SET status='REVOKED',revoked_at=now(),revoked_reason='Approved school offboarding' WHERE school_id=ob.school_id AND status<>'REVOKED';
 UPDATE device_credentials SET status='REVOKED' WHERE school_id=ob.school_id;
 UPDATE support_access_grants SET revoked_at=now() WHERE school_id=ob.school_id AND revoked_at IS NULL;
 SELECT id,status INTO subid,previous FROM subscriptions WHERE school_id=ob.school_id ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
 IF subid IS NOT NULL THEN
  UPDATE subscriptions SET status='CANCELLED' WHERE id=subid;
  INSERT INTO subscription_events(school_id,subscription_id,previous_status,new_status,reason,actor_id) VALUES(ob.school_id,subid,previous,'CANCELLED','Approved school offboarding',app.user_id());
 END IF;
 UPDATE schools SET status='SUSPENDED',access_version=access_version+1 WHERE id=ob.school_id;
 UPDATE push_tokens SET is_active=false WHERE school_id=ob.school_id;
 UPDATE notification_outbox SET status='COMPLETED',last_error='SCHOOL_OFFBOARDED',completed_at=now(),locked_until=NULL,lease_token=NULL WHERE school_id=ob.school_id AND status IN ('PENDING','PROCESSING');
 UPDATE report_documents SET status='FAILED',error_code='SCHOOL_OFFBOARDED',lease_token=NULL,locked_until=NULL WHERE school_id=ob.school_id AND status IN ('PENDING','PROCESSING');
 UPDATE school_invitations SET status='REVOKED' WHERE school_id=ob.school_id AND status IN ('SENDING','SENT','READY','FAILED');
 UPDATE school_offboarding SET status='CLOSED',closed_by=app.user_id(),closed_at=now() WHERE id=job;
END $$;
REVOKE ALL ON FUNCTION app.close_approved_school(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.close_approved_school(uuid) TO app_platform;

-- A narrow, school-scoped profile export; Auth credentials/tokens are never exported.
CREATE FUNCTION app.export_school_users() RETURNS TABLE(id uuid,email text,full_name text,phone text,status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT u.id,u.email::text,u.full_name,u.phone,u.status FROM users u WHERE EXISTS(SELECT FROM school_memberships m WHERE m.user_id=u.id AND m.school_id=app.school_id());
$$;
REVOKE ALL ON FUNCTION app.export_school_users() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.export_school_users() TO app_worker;
GRANT SELECT ON audit_logs,school_invitations,teacher_class_assignments,teachers,device_configurations,device_heartbeats,device_ota_status,attendance_corrections,api_idempotency_keys TO app_worker;
CREATE POLICY worker_export ON school_invitations FOR SELECT TO app_worker USING(school_id=app.school_id());
UPDATE storage.buckets SET file_size_limit=20971520,allowed_mime_types=ARRAY['application/pdf','image/png','image/jpeg','application/json','text/csv','application/octet-stream'] WHERE id='school-documents';

-- Export reads remain constrained by every table's existing forced tenant RLS.
GRANT SELECT ON timetable_entries,subjects,assignments,school_holidays,nfc_cards,device_locations,device_logs,notification_preferences,notification_attempts TO app_worker;
