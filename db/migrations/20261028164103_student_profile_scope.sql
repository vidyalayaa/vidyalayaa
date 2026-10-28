-- Only projections/policies over existing records; no new profile fields or data.
CREATE FUNCTION app.non_student_context(sid uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND (coalesce(app.school_role(sid)<>'student',false) OR app.user_id() IS NULL
 OR (current_setting('app.actor_type',true)='SUPPORT' AND app.non_teacher_context(sid)))
$$;
-- Private boolean lookups avoid recursive RLS on the family/enrollment graph.
-- Identity is always taken from the trusted transaction, never a supplied user ID.
CREATE FUNCTION app.student_profile_record_access(sid uuid,kind text,rid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND app.school_role(sid)='student' AND CASE kind
 WHEN 'parent' THEN EXISTS(SELECT FROM student_parents sp JOIN students s ON s.school_id=sp.school_id AND s.id=sp.student_id
 JOIN parents p ON p.school_id=sp.school_id AND p.id=sp.parent_id
 WHERE sp.school_id=sid AND sp.parent_id=rid AND sp.status='ACTIVE' AND p.status='ACTIVE' AND s.user_id=app.user_id())
 WHEN 'link' THEN EXISTS(SELECT FROM student_parents sp JOIN students s ON s.school_id=sp.school_id AND s.id=sp.student_id
 JOIN parents p ON p.school_id=sp.school_id AND p.id=sp.parent_id
 WHERE sp.school_id=sid AND sp.id=rid AND sp.status='ACTIVE' AND p.status='ACTIVE' AND s.user_id=app.user_id())
 WHEN 'enrollment' THEN EXISTS(SELECT FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id
 WHERE e.school_id=sid AND e.id=rid AND s.user_id=app.user_id())
 WHEN 'class' THEN EXISTS(SELECT FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id
 WHERE e.school_id=sid AND e.class_id=rid AND s.user_id=app.user_id())
 WHEN 'session' THEN EXISTS(SELECT FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id
 WHERE e.school_id=sid AND e.academic_session_id=rid AND s.user_id=app.user_id())
 ELSE false END
$$;
REVOKE ALL ON FUNCTION app.non_student_context(uuid),app.student_profile_record_access(uuid,text,uuid) FROM PUBLIC,anon,authenticated,app_platform,app_device,app_worker;
GRANT EXECUTE ON FUNCTION app.non_student_context(uuid),app.student_profile_record_access(uuid,text,uuid) TO app_api;
CREATE POLICY student_profile_read ON students AS RESTRICTIVE FOR SELECT TO app_api
 USING(app.non_student_context(school_id) OR (app.school_role(school_id)='student' AND user_id=app.user_id()));
DO $$ DECLARE t text; k text; BEGIN
 FOR t,k IN SELECT * FROM (VALUES ('parents','parent'),('student_parents','link'),('enrollments','enrollment'),('classes','class'),('academic_sessions','session')) AS x(t,k) LOOP
  EXECUTE format('CREATE POLICY student_profile_read ON %I AS RESTRICTIVE FOR SELECT TO app_api USING(app.non_student_context(school_id) OR app.student_profile_record_access(school_id,%L,id))',t,k);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['students','parents','student_parents','enrollments','classes','academic_sessions'] LOOP
  EXECUTE format('CREATE POLICY student_profile_no_insert ON %I AS RESTRICTIVE FOR INSERT TO app_api WITH CHECK(app.non_student_context(school_id))',t);
  EXECUTE format('CREATE POLICY student_profile_no_update ON %I AS RESTRICTIVE FOR UPDATE TO app_api USING(app.non_student_context(school_id)) WITH CHECK(app.non_student_context(school_id))',t);
  EXECUTE format('CREATE POLICY student_profile_no_delete ON %I AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_student_context(school_id))',t);
 END LOOP;
END $$;
