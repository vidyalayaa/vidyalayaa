ALTER TABLE public.school_offboarding
 ADD COLUMN permanent boolean NOT NULL DEFAULT false,
 ADD COLUMN approval_recipient uuid,
 ADD COLUMN approval_expires_at timestamptz,
 ADD COLUMN approved_at timestamptz,
 ADD COLUMN purge_requested_at timestamptz,
 ADD COLUMN irreversible_at timestamptz,
 ADD COLUMN purge_lease uuid,
 ADD CONSTRAINT permanent_approval_metadata CHECK (
  NOT permanent OR (approval_recipient IS NOT NULL AND approval_expires_at IS NOT NULL
    AND approval_recipient<>requested_by AND (school_approved_by IS NULL OR
      (school_approved_by=approval_recipient AND approved_at IS NOT NULL AND approved_at<=approval_expires_at)))
 );

-- Preserve the private profile table's existing privileges. Only the worker
-- holding a current export lease can read profile details for that school.
CREATE FUNCTION app.export_school_person_details(job uuid, claim uuid, after_id uuid)
RETURNS SETOF public.school_person_details
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.school_exports e WHERE e.id=job AND e.school_id=app.school_id()
   AND e.status='PROCESSING' AND e.lease_token=claim AND e.locked_until>now())
 THEN RAISE EXCEPTION 'EXPORT_LEASE_LOST' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT d.* FROM public.school_person_details d
 WHERE d.school_id=app.school_id() AND (after_id IS NULL OR d.id>after_id)
 ORDER BY d.id LIMIT 500;
END $$;
REVOKE ALL ON FUNCTION app.export_school_person_details(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.export_school_person_details(uuid,uuid,uuid) TO app_worker;

GRANT SELECT ON public.academic_promotions TO app_worker;
CREATE POLICY school_export_read ON public.academic_promotions FOR SELECT TO app_worker
 USING(school_id=(SELECT app.school_id()));

CREATE FUNCTION app.school_deletion_approvers(target uuid) RETURNS TABLE(id uuid,full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT u.id,u.full_name FROM public.school_memberships m
 JOIN public.roles r ON r.id=m.role_id
 JOIN public.users u ON u.id=m.user_id
 JOIN auth.users au ON au.id=u.id
 WHERE app.is_platform_staff() AND m.school_id=target AND m.status='ACTIVE'
 AND r.code='school_admin' AND u.status='ACTIVE' AND au.email_confirmed_at IS NOT NULL
 AND u.id<>app.user_id()
 AND EXISTS(SELECT FROM auth.mfa_factors f WHERE f.user_id=u.id AND f.factor_type='totp' AND f.status='verified')
 ORDER BY u.full_name,u.id;
$$;
REVOKE ALL ON FUNCTION app.school_deletion_approvers(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.school_deletion_approvers(uuid) TO app_platform;

-- Authorize the narrowly scoped exception to the operational DELETE guards.
-- Only the owner of the purge routine can use it, with a locked approved job
-- for the specific school. Ordinary API/worker sessions cannot opt out.
CREATE FUNCTION app.in_school_erasure(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN current_user=pg_get_userbyid(
   (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('app.erase_school(uuid,uuid)')))
   AND target IS NOT NULL AND target=app.school_id()
   AND nullif(current_setting('app.erasing_school',true),'') IS NOT NULL
 THEN EXISTS(SELECT FROM public.school_offboarding o
   WHERE o.school_id=target AND o.id::text=current_setting('app.erasing_school',true)
     AND o.permanent AND o.status='PURGING' AND o.irreversible_at IS NOT NULL AND NOT o.legal_hold)
 ELSE false END
$$;
REVOKE ALL ON FUNCTION app.in_school_erasure(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.in_school_erasure(uuid) TO app_api,app_device,app_platform,app_worker;

-- Preserve the existing triggers for normal writes. Route their DELETE event
-- through the same trigger function except during the approved erasure.
DO $$
DECLARE guard record; fn text; update_events text;
BEGIN
 FOR guard IN
  SELECT c.relname table_name,t.tgname,t.tgtype,p.proname
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal AND (t.tgtype::int & 8)>0
  AND p.proname IN ('guard_promotion_record','guard_closed_academic_year','fee_immutable',
   'fee_record_guard','calendar_class_reference_guard','guard_timetable_entry','protect_last_school_admin')
 LOOP
  fn:=format('app.%I()',guard.proname);
  EXECUTE format('DROP TRIGGER %I ON public.%I',guard.tgname,guard.table_name);
  update_events:=concat_ws(' OR ',CASE WHEN (guard.tgtype::int & 4)>0 THEN 'INSERT' END,
    CASE WHEN (guard.tgtype::int & 16)>0 THEN 'UPDATE' END);
  IF update_events<>'' THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE %s ON public.%I FOR EACH ROW EXECUTE FUNCTION %s',
    guard.tgname,update_events,guard.table_name,fn);
  END IF;
  EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW WHEN (NOT app.in_school_erasure(OLD.school_id)) EXECUTE FUNCTION %s',
    guard.tgname||'_delete',guard.table_name,fn);
 END LOOP;
END $$;

CREATE FUNCTION app.school_erasure_relations() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE
 -- Child tables precede their parents. Keep the authorization row until all
 -- guarded deletes finish. audit_logs is cleared again after access triggers.
 relations text[]:=ARRAY[
  'academic_promotions','announcements','api_idempotency_keys','assignments',
  'attendance_corrections','attendance_reconciliation_requests','audit_logs','device_configurations',
  'device_credentials','device_heartbeats','device_logs','device_ota_assignments',
  'device_ota_status','enrollments','fee_payment_allocations','fee_payment_reversals',
  'fee_structure_sections','job_runs','marks','notification_attempts',
  'notification_preferences','notification_recipient_targets','platform_notices','push_delivery_targets',
  'report_documents','school_exports','school_holidays','school_invitations',
  'school_memberships','school_notification_settings','school_offboarding','school_person_details',
  'school_profile_assets','school_profile_private','school_usage_snapshots','student_parents',
  'subscription_events','support_requests','teacher_class_assignments','timetable_entries',
  'daily_attendance','exams','fee_payments','fee_records',
  'notification_deliveries','push_tokens','subscriptions','support_access_grants',
  'attendance_rule_versions','fee_structure_items','fee_transport_assignments','notification_outbox',
  'parents','subjects','attendance_events','fee_structures',
  'fee_transport_routes','devices','nfc_cards','device_locations',
  'students','classes','academic_sessions','teachers'
 ];
BEGIN
 -- Reject unreviewed tenant tables instead of guessing how to erase them.
 IF EXISTS(SELECT FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE c.relnamespace IN ('public'::regnamespace,'app'::regnamespace)
  AND c.relkind IN ('r','p') AND a.attname='school_id' AND NOT a.attisdropped
  AND NOT ((c.relnamespace='public'::regnamespace AND c.relname::text=ANY(relations))
    OR (c.relnamespace='app'::regnamespace
      AND c.relname IN ('school_security_policy_versions','platform_daily_notifications'))))
 THEN RAISE EXCEPTION 'SCHOOL_ERASURE_SCHEMA_CHANGED'; END IF;

 RETURN relations;
END $$;
REVOKE ALL ON FUNCTION app.school_erasure_relations() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.school_erasure_relations() TO app_worker;

CREATE FUNCTION app.erase_school(job uuid, lease uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 ob public.school_offboarding;
 relation_name text;
 candidate uuid;
 candidates uuid[];
 reference record;
 shared boolean;
 relations text[];
BEGIN
 SELECT * INTO ob FROM public.school_offboarding WHERE id=job AND school_id=app.school_id() FOR UPDATE;
 IF ob.id IS NULL OR NOT ob.permanent OR ob.status<>'PURGING' OR ob.legal_hold
 OR ob.purge_lease IS DISTINCT FROM lease OR lease IS NULL OR ob.irreversible_at IS NULL
 OR ob.school_approved_by IS DISTINCT FROM ob.approval_recipient OR ob.approved_at IS NULL
 OR ob.closed_by IS NULL OR ob.purge_requested_by IS NULL OR ob.purge_requested_at IS NULL
 OR ob.storage_purged_at IS NULL OR now()<ob.delete_after OR now()<ob.export_until
 OR NOT EXISTS(SELECT FROM public.school_exports WHERE school_id=ob.school_id AND status='COMPLETED'
              AND snapshot_at>=ob.closed_at)
 THEN RAISE EXCEPTION 'PURGE_NOT_APPROVED' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.schools WHERE id=ob.school_id AND status='SUSPENDED' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_NOT_CLOSED'; END IF;
 IF EXISTS(SELECT FROM public.devices WHERE school_id=ob.school_id AND status<>'REVOKED')
 THEN RAISE EXCEPTION 'DEVICES_NOT_RETIRED'; END IF;


 relations:=app.school_erasure_relations();
 SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO candidates FROM (
  SELECT user_id FROM public.school_memberships WHERE school_id=ob.school_id
  UNION SELECT user_id FROM public.students WHERE school_id=ob.school_id
  UNION SELECT user_id FROM public.teachers WHERE school_id=ob.school_id
  UNION SELECT user_id FROM public.parents WHERE school_id=ob.school_id
  UNION SELECT user_id FROM public.school_invitations WHERE school_id=ob.school_id
 ) u WHERE user_id IS NOT NULL;
 -- An identity cannot gain a new FK reference while its sharing is checked.
 PERFORM 1 FROM public.users WHERE id=ANY(candidates) ORDER BY id FOR UPDATE;
 PERFORM set_config('app.erasing_school',job::text,true);
 FOREACH relation_name IN ARRAY relations LOOP
  IF relation_name<>'school_offboarding' THEN
   EXECUTE format('DELETE FROM public.%I WHERE school_id=$1',relation_name) USING ob.school_id;
  END IF;
 END LOOP;
 DELETE FROM public.school_offboarding WHERE school_id=ob.school_id;
 DELETE FROM public.audit_logs WHERE school_id=ob.school_id
  OR (school_id IS NULL AND entity_type='schools' AND entity_id=ob.school_id);
 -- The school FK cascades to security-policy history and scheduled notifications.
 DELETE FROM public.schools WHERE id=ob.school_id;
 PERFORM set_config('app.erasing_school','',true);

 FOREACH candidate IN ARRAY coalesce(candidates,ARRAY[]::uuid[]) LOOP
  -- Preserve identities with any surviving school or platform relationship,
  -- including email-only invitations. Account-local security history is erased.
  SELECT EXISTS(SELECT FROM public.school_invitations i JOIN public.users u ON i.email=u.email
               WHERE u.id=candidate AND i.status IN ('SENDING','SENT','READY','FAILED')) INTO shared;
  FOR reference IN
   SELECT n.nspname,c.relname,a.attname FROM pg_constraint k
   JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.conkey[1]
   WHERE k.contype='f' AND k.confrelid='public.users'::regclass
     AND NOT (n.nspname='app' AND c.relname IN ('login_events','push_endpoint_owners',
      'account_security_events','login_session_activity'))
  LOOP
   EXIT WHEN shared;
   EXECUTE format('SELECT EXISTS(SELECT FROM %I.%I WHERE %I=$1)',reference.nspname,reference.relname,reference.attname)
   INTO shared USING candidate;
  END LOOP;
  IF NOT shared THEN
   DELETE FROM app.login_events WHERE user_id=candidate;
   DELETE FROM app.push_endpoint_owners WHERE user_id=candidate;
   DELETE FROM auth.sessions WHERE user_id=candidate;
   DELETE FROM public.users WHERE id=candidate;
   DELETE FROM auth.users WHERE id=candidate;
  END IF;
 END LOOP;

 INSERT INTO public.audit_logs(actor_type,actor_id,action,entity_type,entity_id,after)
 VALUES('SYSTEM',ob.purge_requested_by,'school.permanently_deleted','school_deletion',ob.id,
  jsonb_build_object('school_id',ob.school_id,'initiated_by',ob.requested_by,'initiated_at',ob.created_at,
    'approved_by',ob.school_approved_by,'approved_at',ob.approved_at,'executed_by',ob.purge_requested_by,
    'executed_at',ob.purge_requested_at,'irreversible_at',ob.irreversible_at));
END $$;
REVOKE ALL ON FUNCTION app.erase_school(uuid,uuid) FROM PUBLIC,anon,authenticated,app_api,app_platform,app_device;
GRANT EXECUTE ON FUNCTION app.erase_school(uuid,uuid) TO app_worker;


-- The older operational purge cannot be used on a permanent deletion job.
ALTER FUNCTION app.purge_approved_school(uuid) RENAME TO purge_school_operational_data;
REVOKE ALL ON FUNCTION app.purge_school_operational_data(uuid) FROM app_worker;
CREATE FUNCTION app.purge_approved_school(job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.school_offboarding
   WHERE id=job AND school_id=app.school_id() AND NOT permanent)
 THEN RAISE EXCEPTION 'PURGE_NOT_APPROVED' USING ERRCODE='42501'; END IF;
 PERFORM app.purge_school_operational_data(job);
END $$;
REVOKE ALL ON FUNCTION app.purge_approved_school(uuid) FROM PUBLIC,anon,authenticated,app_api,app_platform,app_device;
GRANT EXECUTE ON FUNCTION app.purge_approved_school(uuid) TO app_worker;
