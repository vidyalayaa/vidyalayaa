-- Invitations select an existing record. Acceptance links that exact record,
-- never a record inferred from an email/name supplied by the recipient.
ALTER TABLE students ADD COLUMN email citext;
ALTER TABLE teachers ADD COLUMN email citext;
ALTER TABLE teachers ADD COLUMN staff_role text NOT NULL DEFAULT 'teacher'
 CHECK(staff_role IN ('teacher','principal','school_admin'));
UPDATE students s SET email=u.email FROM users u WHERE u.id=s.user_id;
UPDATE teachers t SET email=u.email FROM users u WHERE u.id=t.user_id;
UPDATE teachers t SET staff_role=r.code FROM school_memberships m JOIN roles r ON r.id=m.role_id
 WHERE m.school_id=t.school_id AND m.user_id=t.user_id AND m.status='ACTIVE' AND r.code IN ('principal','school_admin');
CREATE INDEX student_invitation_email ON students(school_id,email) WHERE email IS NOT NULL;
CREATE INDEX staff_invitation_email ON teachers(school_id,staff_role,email) WHERE email IS NOT NULL;
ALTER TABLE school_invitations ADD COLUMN student_id uuid;
ALTER TABLE school_invitations ADD COLUMN parent_id uuid;
ALTER TABLE school_invitations ADD COLUMN teacher_id uuid;
ALTER TABLE school_invitations ADD COLUMN bootstrap_administrator boolean NOT NULL DEFAULT false;
ALTER TABLE school_invitations ADD CONSTRAINT invitation_student FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id);
ALTER TABLE school_invitations ADD CONSTRAINT invitation_parent FOREIGN KEY(school_id,parent_id) REFERENCES parents(school_id,id);
ALTER TABLE school_invitations ADD CONSTRAINT invitation_staff FOREIGN KEY(school_id,teacher_id) REFERENCES teachers(school_id,id);
ALTER TABLE school_invitations ADD CONSTRAINT invitation_record_role CHECK(
 num_nonnulls(student_id,parent_id,teacher_id)<=1
 AND (student_id IS NULL OR role_code='student')
 AND (parent_id IS NULL OR role_code='parent')
 AND (teacher_id IS NULL OR role_code IN ('teacher','principal','school_admin'))
 AND (NOT bootstrap_administrator OR (role_code='school_admin' AND num_nonnulls(student_id,parent_id,teacher_id)=0)));
UPDATE school_invitations i SET bootstrap_administrator=true
 WHERE i.role_code='school_admin' AND EXISTS(SELECT FROM platform_staff p WHERE p.user_id=i.invited_by AND p.platform_role='SUPER_ADMIN')
 AND EXISTS(SELECT FROM schools s WHERE s.id=i.school_id AND s.administrator_onboarded_at IS NULL);

CREATE FUNCTION app.invitation_record(sid uuid,code text,rid uuid,target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; BEGIN
 IF rid IS NULL THEN RAISE EXCEPTION 'INVITATION_RECORD_REQUIRED' USING ERRCODE='23514'; END IF;
 IF code='student' THEN
  SELECT jsonb_build_object('id',id,'full_name',concat_ws(' ',first_name,last_name),'user_id',user_id,'email',email)
  INTO result FROM students WHERE school_id=sid AND id=rid AND status='ACTIVE' AND email=target::citext FOR UPDATE;
 ELSIF code='parent' THEN
  SELECT jsonb_build_object('id',id,'full_name',full_name,'user_id',user_id,'email',email)
  INTO result FROM parents WHERE school_id=sid AND id=rid AND status='ACTIVE' AND email=target::citext FOR UPDATE;
  IF result IS NOT NULL AND NOT EXISTS(SELECT FROM student_parents sp JOIN students s ON s.school_id=sp.school_id AND s.id=sp.student_id
    WHERE sp.school_id=sid AND sp.parent_id=rid AND sp.status='ACTIVE' AND s.status='ACTIVE')
  THEN RAISE EXCEPTION 'PARENT_CHILD_REQUIRED' USING ERRCODE='23514'; END IF;
 ELSIF code IN ('teacher','principal','school_admin') THEN
  SELECT jsonb_build_object('id',id,'full_name',full_name,'user_id',user_id,'email',email)
  INTO result FROM teachers WHERE school_id=sid AND id=rid AND staff_role=code AND status='ACTIVE' AND email=target::citext FOR UPDATE;
 END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'INVITATION_RECORD_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 IF result->>'user_id' IS NOT NULL AND NOT EXISTS(SELECT FROM users WHERE id=(result->>'user_id')::uuid AND email=target::citext)
 THEN RAISE EXCEPTION 'INVITATION_RECORD_LINKED' USING ERRCODE='23514'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.invitation_record(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,app_api,app_platform,app_worker,app_device;

ALTER FUNCTION app.begin_school_invitation(uuid,text,text,text,boolean) RENAME TO begin_unbound_school_invitation;
ALTER FUNCTION app.finish_school_invitation(uuid,uuid,uuid,boolean) RENAME TO finish_unbound_school_invitation;
ALTER FUNCTION app.respond_school_invitation(uuid,boolean) RENAME TO respond_unbound_school_invitation;
REVOKE ALL ON FUNCTION app.begin_unbound_school_invitation(uuid,text,text,text,boolean),
 app.finish_unbound_school_invitation(uuid,uuid,uuid,boolean),app.respond_unbound_school_invitation(uuid,boolean)
 FROM PUBLIC,anon,authenticated,app_api,app_platform,app_worker,app_device;

CREATE FUNCTION app.begin_school_invitation(sid uuid,target text,person text,code text,resend boolean DEFAULT false,record_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; profile jsonb; existing school_invitations; bootstrap boolean; BEGIN
 target:=lower(trim(target));
 PERFORM pg_advisory_xact_lock(hashtextextended(sid::text||':memberships',0));
 IF NOT app.can_invite_member(sid,code,target) THEN RAISE EXCEPTION 'ONBOARDING_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
 bootstrap:=code='school_admin' AND record_id IS NULL AND app.is_platform_staff()
  AND EXISTS(SELECT FROM schools WHERE id=sid AND administrator_onboarded_at IS NULL);
 IF NOT bootstrap THEN
  profile:=app.invitation_record(sid,code,record_id,target);
  person:=profile->>'full_name';
 END IF;
 SELECT * INTO existing FROM school_invitations WHERE school_id=sid AND email=target::citext FOR UPDATE;
 IF existing.id IS NOT NULL AND existing.status IN ('SENDING','SENT','READY') AND existing.expires_at>now()
  AND (existing.role_code<>code OR existing.bootstrap_administrator<>bootstrap
   OR coalesce(existing.student_id,existing.parent_id,existing.teacher_id) IS DISTINCT FROM record_id)
 THEN RAISE EXCEPTION 'INVITATION_CHANGED' USING ERRCODE='40001'; END IF;
 IF NOT bootstrap AND EXISTS(SELECT FROM school_invitations i WHERE i.school_id=sid AND i.email<>target::citext
  AND i.role_code=code AND coalesce(i.student_id,i.parent_id,i.teacher_id)=record_id
  AND i.status IN ('SENDING','SENT','READY') AND i.expires_at>now())
 THEN RAISE EXCEPTION 'INVITATION_RECORD_BUSY' USING ERRCODE='23505'; END IF;
 result:=app.begin_unbound_school_invitation(sid,target,person,code,resend);
 IF result->>'action'<>'none' THEN
  UPDATE school_invitations SET student_id=CASE WHEN code='student' THEN record_id END,
   parent_id=CASE WHEN code='parent' THEN record_id END,
   teacher_id=CASE WHEN code IN ('teacher','principal','school_admin') THEN record_id END,
   bootstrap_administrator=bootstrap WHERE id=(result->>'id')::uuid;
 END IF;
 RETURN result||jsonb_build_object('full_name',person);
END $$;

CREATE FUNCTION app.finish_school_invitation(iid uuid,claim uuid,identity uuid,mailed boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item school_invitations; profile jsonb; BEGIN
 SELECT * INTO item FROM school_invitations WHERE id=iid;
 IF item.id IS NULL THEN RAISE EXCEPTION 'INVITATION_CHANGED' USING ERRCODE='40001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(item.school_id::text||':memberships',0));
 SELECT * INTO item FROM school_invitations WHERE id=iid FOR UPDATE;
 IF NOT app.can_invite_member(item.school_id,item.role_code,item.email::text)
 THEN RAISE EXCEPTION 'ONBOARDING_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
 IF NOT item.bootstrap_administrator THEN
  profile:=app.invitation_record(item.school_id,item.role_code,coalesce(item.student_id,item.parent_id,item.teacher_id),item.email::text);
  IF profile->>'user_id' IS NOT NULL AND (profile->>'user_id')::uuid<>identity
  THEN RAISE EXCEPTION 'INVITATION_RECORD_LINKED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN app.finish_unbound_school_invitation(iid,claim,identity,mailed);
END $$;

CREATE FUNCTION app.respond_school_invitation(iid uuid,accept boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item school_invitations; profile jsonb; result jsonb; affected integer; BEGIN
 SELECT * INTO item FROM school_invitations WHERE id=iid;
 IF item.id IS NULL OR NOT EXISTS(SELECT FROM app.pending_school_invitations() p WHERE p.id=iid)
 THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(item.school_id::text||':memberships',0));
 SELECT * INTO item FROM school_invitations WHERE id=iid FOR UPDATE;
 IF accept AND NOT item.bootstrap_administrator THEN
  profile:=app.invitation_record(item.school_id,item.role_code,coalesce(item.student_id,item.parent_id,item.teacher_id),item.email::text);
  IF profile->>'user_id' IS NOT NULL AND (profile->>'user_id')::uuid<>app.user_id()
  THEN RAISE EXCEPTION 'INVITATION_RECORD_LINKED' USING ERRCODE='23514'; END IF;
 END IF;
 result:=app.respond_unbound_school_invitation(iid,accept);
 IF accept AND NOT item.bootstrap_administrator THEN
  IF item.role_code='student' THEN
   UPDATE students SET user_id=app.user_id() WHERE school_id=item.school_id AND id=item.student_id AND (user_id IS NULL OR user_id=app.user_id());
  ELSIF item.role_code='parent' THEN
   UPDATE parents SET user_id=app.user_id() WHERE school_id=item.school_id AND id=item.parent_id AND (user_id IS NULL OR user_id=app.user_id());
  ELSE
   UPDATE teachers SET user_id=app.user_id() WHERE school_id=item.school_id AND id=item.teacher_id AND (user_id IS NULL OR user_id=app.user_id());
  END IF;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'INVITATION_RECORD_LINKED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.begin_school_invitation(uuid,text,text,text,boolean,uuid),
 app.finish_school_invitation(uuid,uuid,uuid,boolean),app.respond_school_invitation(uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.begin_school_invitation(uuid,text,text,text,boolean,uuid),app.finish_school_invitation(uuid,uuid,uuid,boolean) TO app_api,app_platform;
GRANT EXECUTE ON FUNCTION app.respond_school_invitation(uuid,boolean) TO app_api;

-- Bound invitations now reference profiles: remove them before profile deletion.
CREATE OR REPLACE FUNCTION app.purge_approved_school(job uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE ob school_offboarding;t text;BEGIN
 SELECT * INTO ob FROM school_offboarding WHERE id=job AND school_id=app.school_id() FOR UPDATE;
 IF ob.id IS NULL OR ob.status<>'PURGING' OR ob.legal_hold OR ob.school_approved_by IS NULL OR ob.closed_by IS NULL
 OR ob.school_approved_by=ob.closed_by OR ob.purge_requested_by IS NULL OR ob.storage_purged_at IS NULL
 OR now()<ob.delete_after OR now()<ob.export_until OR NOT EXISTS(SELECT FROM school_exports WHERE school_id=ob.school_id AND status='COMPLETED' AND completed_at>=ob.closed_at)
 THEN RAISE EXCEPTION 'PURGE_NOT_APPROVED' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM devices WHERE school_id=ob.school_id AND status<>'REVOKED') THEN RAISE EXCEPTION 'DEVICES_NOT_RETIRED';END IF;
 -- Explicit dependency order; never disable FK, RLS, or immutable-audit controls.
 FOREACH t IN ARRAY ARRAY['school_invitations','push_delivery_targets','notification_attempts','notification_deliveries','notification_outbox',
 'notification_preferences','push_tokens','attendance_reconciliation_requests','attendance_corrections','daily_attendance','attendance_events',
 'nfc_cards','marks','fee_records','assignments','timetable_entries','teacher_class_assignments','school_holidays','attendance_rule_versions',
 'report_documents','api_idempotency_keys','student_parents','enrollments','exams','device_ota_assignments','device_ota_status','device_heartbeats','device_logs','device_configurations',
 'device_credentials','devices','device_locations','classes','subjects','academic_sessions','students','parents','teachers'] LOOP
  EXECUTE format('DELETE FROM %I WHERE school_id=$1',t) USING ob.school_id;
 END LOOP;
 UPDATE school_exports SET status='EXPIRED',manifest='[]' WHERE school_id=ob.school_id;
 UPDATE schools SET status='TERMINATED',settings='{}',access_version=access_version+1 WHERE id=ob.school_id;
 UPDATE school_offboarding SET status='PURGED',purged_at=now(),last_error=NULL WHERE id=job;
 INSERT INTO audit_logs(school_id,actor_type,action,entity_type,entity_id,after) VALUES(ob.school_id,'SYSTEM','school.operational_data_purged','school_offboarding',job,jsonb_build_object('policy_ref',ob.policy_ref,'school_approved_by',ob.school_approved_by,'closed_by',ob.closed_by,'purge_requested_by',ob.purge_requested_by));
 -- Global Auth identities, immutable audit, contractual subscription metadata and usage aggregates
 -- are deliberately retained under their separate approved retention policies. They may serve other schools.
END $$;
