-- Boolean ownership lookups live in the private app schema. Definer access is
-- required only to avoid recursive RLS on the relationship tables themselves.
-- They accept no caller identity and bind both tenant and live membership.
CREATE FUNCTION app.non_parent_context(sid uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND (coalesce(app.school_role(sid)<>'parent',false) OR app.user_id() IS NULL
 OR (current_setting('app.actor_type',true)='SUPPORT' AND app.non_teacher_context(sid)))
$$;
REVOKE ALL ON FUNCTION app.non_parent_context(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.non_parent_context(uuid) TO app_api;
CREATE FUNCTION app.parent_student_access(sid uuid, child uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND app.school_role(sid)='parent'
 AND (nullif(current_setting('app.parent_child_id',true),'') IS NULL
      OR child=nullif(current_setting('app.parent_child_id',true),'')::uuid)
 AND EXISTS(SELECT FROM parents p JOIN student_parents sp ON sp.school_id=p.school_id AND sp.parent_id=p.id
 JOIN students s ON s.school_id=sp.school_id AND s.id=sp.student_id
 WHERE p.school_id=sid AND p.user_id=app.user_id() AND p.status='ACTIVE'
 AND sp.status='ACTIVE' AND s.status='ACTIVE' AND s.id=child)
$$;
CREATE FUNCTION app.parent_record_access(sid uuid, kind text, rid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND app.school_role(sid)='parent' AND CASE kind
 WHEN 'parent' THEN EXISTS(SELECT FROM parents p WHERE p.school_id=sid AND p.id=rid AND p.user_id=app.user_id() AND p.status='ACTIVE')
 WHEN 'class' THEN EXISTS(SELECT FROM enrollments e JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id
 JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id JOIN schools sc ON sc.id=e.school_id
 WHERE e.school_id=sid AND e.class_id=rid AND app.parent_student_access(sid,e.student_id)
 AND e.status='ACTIVE' AND c.retired_at IS NULL AND ac.retired_at IS NULL
 AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date))
 WHEN 'session' THEN EXISTS(SELECT FROM enrollments e WHERE e.school_id=sid AND e.academic_session_id=rid AND app.parent_student_access(sid,e.student_id))
 WHEN 'subject' THEN EXISTS(SELECT FROM teacher_class_assignments ta JOIN schools sc ON sc.id=ta.school_id
 WHERE ta.school_id=sid AND ta.subject_id=rid AND ta.retired_at IS NULL AND app.parent_record_access(sid,'class',ta.class_id)
 AND ta.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE sc.timezone)::date))
 OR EXISTS(SELECT FROM marks m JOIN exams ex ON ex.school_id=m.school_id AND ex.id=m.exam_id
 WHERE m.school_id=sid AND m.subject_id=rid AND app.parent_student_access(sid,m.student_id) AND ex.status='PUBLISHED' AND ex.retired_at IS NULL)
 WHEN 'teacher' THEN EXISTS(SELECT FROM classes c WHERE c.school_id=sid AND c.class_teacher_id=rid AND app.parent_record_access(sid,'class',c.id))
 OR EXISTS(SELECT FROM teacher_class_assignments ta JOIN schools sc ON sc.id=ta.school_id WHERE ta.school_id=sid AND ta.teacher_id=rid
 AND ta.retired_at IS NULL AND app.parent_record_access(sid,'class',ta.class_id)
 AND ta.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE sc.timezone)::date))
 WHEN 'exam' THEN EXISTS(SELECT FROM exams ex WHERE ex.school_id=sid AND ex.id=rid AND ex.status='PUBLISHED' AND ex.retired_at IS NULL
 AND (app.parent_record_access(sid,'class',ex.class_id) OR EXISTS(SELECT FROM marks m WHERE m.school_id=sid AND m.exam_id=rid AND app.parent_student_access(sid,m.student_id))))
 WHEN 'notice' THEN EXISTS(SELECT FROM notification_outbox o WHERE o.school_id=sid AND o.id=rid
 AND (o.student_id IS NULL OR app.parent_student_access(sid,o.student_id)) AND
 (EXISTS(SELECT FROM notification_recipient_targets t WHERE t.school_id=sid AND t.outbox_id=rid AND t.user_id=app.user_id())
 OR EXISTS(SELECT FROM notification_deliveries d LEFT JOIN parents p ON p.school_id=d.school_id AND p.id=d.parent_id
 WHERE d.school_id=sid AND d.outbox_id=rid AND (d.recipient_user_id=app.user_id() OR (p.user_id=app.user_id() AND p.status='ACTIVE')))))
 ELSE false END
$$;
REVOKE ALL ON FUNCTION app.parent_student_access(uuid,uuid),app.parent_record_access(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.parent_student_access(uuid,uuid),app.parent_record_access(uuid,text,uuid) TO app_api;

-- Add restrictive parent policies without changing any other role's policies.
DO $$ DECLARE t text; expr text; BEGIN
 FOR t,expr IN SELECT * FROM (VALUES
 ('students','app.parent_student_access(school_id,id)'),
 ('parents','app.parent_record_access(school_id,''parent'',id)'),
 ('student_parents','status=''ACTIVE'' AND app.parent_record_access(school_id,''parent'',parent_id) AND app.parent_student_access(school_id,student_id)'),
 ('enrollments','app.parent_student_access(school_id,student_id)'),
 ('classes','app.parent_record_access(school_id,''class'',id)'),
 ('academic_sessions','app.parent_record_access(school_id,''session'',id)'),
 ('subjects','retired_at IS NULL AND app.parent_record_access(school_id,''subject'',id)'),
 ('teachers','app.parent_record_access(school_id,''teacher'',id)'),
 ('teacher_class_assignments','retired_at IS NULL AND app.parent_record_access(school_id,''class'',class_id)'),
 ('assignments','retired_at IS NULL AND app.parent_record_access(school_id,''class'',class_id)'),
 ('exams','app.parent_record_access(school_id,''exam'',id)'),
 ('marks','app.parent_student_access(school_id,student_id) AND app.parent_record_access(school_id,''exam'',exam_id)'),
 ('daily_attendance','app.parent_student_access(school_id,student_id)'),
 ('attendance_events','app.parent_student_access(school_id,student_id)'),
 ('nfc_cards','app.parent_student_access(school_id,student_id)'),
 ('attendance_corrections','requested_by=app.user_id() AND EXISTS(SELECT FROM daily_attendance d WHERE d.school_id=attendance_corrections.school_id AND d.id=attendance_corrections.daily_attendance_id)'),
 ('announcements','retired_at IS NULL AND published_at<=now() AND audience IN (''SCHOOL'',''CLASS'',''PARENTS'') AND (class_id IS NULL OR app.parent_record_access(school_id,''class'',class_id))'),
 ('report_documents','requested_by=app.user_id() AND app.parent_student_access(school_id,student_id)'),
 ('notification_outbox','app.parent_record_access(school_id,''notice'',id)'),
 ('notification_deliveries','(recipient_user_id=app.user_id() OR app.parent_record_access(school_id,''parent'',parent_id)) AND app.parent_record_access(school_id,''notice'',outbox_id)')
 ) rules(tab,predicate) LOOP
 EXECUTE format('CREATE POLICY parent_read ON %I AS RESTRICTIVE FOR SELECT TO app_api USING(app.non_parent_context(school_id) OR (%s))',t,expr);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['students','parents','student_parents','enrollments','classes','subjects','teachers','academic_sessions',
 'teacher_class_assignments','assignments','exams','marks','daily_attendance','attendance_events','nfc_cards','announcements'] LOOP
 EXECUTE format('CREATE POLICY parent_no_insert ON %I AS RESTRICTIVE FOR INSERT TO app_api WITH CHECK(app.non_parent_context(school_id))',t);
 IF t<>'parents' THEN
 EXECUTE format('CREATE POLICY parent_no_update ON %I AS RESTRICTIVE FOR UPDATE TO app_api USING(app.non_parent_context(school_id)) WITH CHECK(app.non_parent_context(school_id))',t);
 END IF;
 EXECUTE format('CREATE POLICY parent_no_delete ON %I AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_parent_context(school_id))',t);
 END LOOP;
END $$;
CREATE POLICY parent_request ON attendance_corrections AS RESTRICTIVE FOR INSERT TO app_api
 WITH CHECK(app.non_parent_context(school_id) OR (requested_by=app.user_id() AND status='REQUESTED'
 AND approved_by IS NULL AND decided_at IS NULL AND applied_at IS NULL AND EXISTS(SELECT FROM daily_attendance d WHERE d.school_id=attendance_corrections.school_id AND d.id=attendance_corrections.daily_attendance_id)));
CREATE POLICY parent_no_decision ON attendance_corrections AS RESTRICTIVE FOR UPDATE TO app_api USING(app.non_parent_context(school_id)) WITH CHECK(app.non_parent_context(school_id));
CREATE POLICY parent_no_delete ON attendance_corrections AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_parent_context(school_id));
CREATE POLICY parent_report_request ON report_documents AS RESTRICTIVE FOR INSERT TO app_api WITH CHECK(app.non_parent_context(school_id) OR (requested_by=app.user_id() AND app.parent_student_access(school_id,student_id) AND status='PENDING' AND authorization_version IS NULL AND authorization_role IS NULL AND authorization_scope IS NULL));
CREATE POLICY parent_no_update ON report_documents AS RESTRICTIVE FOR UPDATE TO app_api USING(app.non_parent_context(school_id)) WITH CHECK(app.non_parent_context(school_id));
CREATE POLICY parent_no_delete ON report_documents AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_parent_context(school_id));
-- Parent privacy preferences remain editable; official identity/link fields do not.
CREATE FUNCTION app.guard_parent_profile() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF current_user='app_api' AND app.school_role(OLD.school_id)='parent' AND
 (OLD.user_id IS DISTINCT FROM app.user_id() OR (to_jsonb(NEW)-ARRAY['no_names_on_lock_screen','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['no_names_on_lock_screen','updated_at'])) THEN
 RAISE EXCEPTION 'PARENT_PROFILE_READ_ONLY' USING ERRCODE='42501'; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_parent_profile() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER parent_profile_guard BEFORE UPDATE ON parents FOR EACH ROW EXECUTE FUNCTION app.guard_parent_profile();
