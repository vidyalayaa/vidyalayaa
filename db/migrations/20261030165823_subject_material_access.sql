-- Reuse assignments and private Storage. No material/enrollment rows are changed.
CREATE POLICY student_learning_read ON assignments AS RESTRICTIVE FOR SELECT TO app_api
 USING(app.non_student_context(school_id) OR (
  app.school_role(school_id)='student' AND retired_at IS NULL AND EXISTS(
   SELECT FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id
   JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id
   JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
   JOIN schools sc ON sc.id=e.school_id
   WHERE e.school_id=assignments.school_id AND e.class_id=assignments.class_id
   AND s.user_id=app.user_id() AND s.status='ACTIVE' AND e.status='ACTIVE'
   AND c.retired_at IS NULL AND ac.retired_at IS NULL
   AND (now() AT TIME ZONE sc.timezone)::date BETWEEN ac.starts_on AND ac.ends_on
   AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date
   AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date)
  )
 ));
CREATE POLICY student_learning_no_insert ON assignments AS RESTRICTIVE FOR INSERT TO app_api WITH CHECK(app.non_student_context(school_id));
CREATE POLICY student_learning_no_update ON assignments AS RESTRICTIVE FOR UPDATE TO app_api USING(app.non_student_context(school_id)) WITH CHECK(app.non_student_context(school_id));
CREATE POLICY student_learning_no_delete ON assignments AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_student_context(school_id));
