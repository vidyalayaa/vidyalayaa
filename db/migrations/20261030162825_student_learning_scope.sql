-- Restrict student reads using the existing authenticated identity, enrollments
-- and publication status. Other roles retain all existing restrictive policies.
CREATE POLICY student_learning_read ON exams AS RESTRICTIVE FOR SELECT TO app_api
 USING(app.non_student_context(school_id) OR (
  status='PUBLISHED' AND retired_at IS NULL AND EXISTS(
   SELECT FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id
   WHERE e.school_id=exams.school_id AND e.class_id=exams.class_id
   AND s.user_id=app.user_id() AND s.status='ACTIVE'
  )
 ));
CREATE POLICY student_learning_read ON marks AS RESTRICTIVE FOR SELECT TO app_api
 USING(app.non_student_context(school_id) OR (
  EXISTS(SELECT FROM students s WHERE s.school_id=marks.school_id AND s.id=marks.student_id
   AND s.user_id=app.user_id() AND s.status='ACTIVE')
  AND EXISTS(SELECT FROM exams ex WHERE ex.school_id=marks.school_id AND ex.id=marks.exam_id
   AND ex.status='PUBLISHED' AND ex.retired_at IS NULL)
 ));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['marks','exams'] LOOP
  EXECUTE format('CREATE POLICY student_learning_no_insert ON %I AS RESTRICTIVE FOR INSERT TO app_api WITH CHECK(app.non_student_context(school_id))',t);
  EXECUTE format('CREATE POLICY student_learning_no_update ON %I AS RESTRICTIVE FOR UPDATE TO app_api USING(app.non_student_context(school_id)) WITH CHECK(app.non_student_context(school_id))',t);
  EXECUTE format('CREATE POLICY student_learning_no_delete ON %I AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_student_context(school_id))',t);
 END LOOP;
END $$;

-- Keep the current-class catalogue boundary and also allow the subject labels
-- needed by the student's own published historical marks. No records are copied.
DROP POLICY student_class_subjects ON subjects;
CREATE POLICY student_class_subjects ON subjects AS RESTRICTIVE FOR SELECT TO app_api
 USING(app.non_student_context(school_id) OR EXISTS(
  SELECT FROM teacher_class_assignments ta JOIN enrollments e ON e.school_id=ta.school_id AND e.class_id=ta.class_id
  JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id
  JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id
  JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
  JOIN schools sc ON sc.id=e.school_id
  WHERE ta.school_id=subjects.school_id AND ta.subject_id=subjects.id AND ta.retired_at IS NULL
  AND s.user_id=app.user_id() AND s.status='ACTIVE' AND e.status='ACTIVE' AND c.retired_at IS NULL AND ac.retired_at IS NULL
  AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date)
  AND ta.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE sc.timezone)::date)
 ) OR EXISTS(
  SELECT FROM marks m JOIN students s ON s.school_id=m.school_id AND s.id=m.student_id
  JOIN exams ex ON ex.school_id=m.school_id AND ex.id=m.exam_id
  WHERE m.school_id=subjects.school_id AND m.subject_id=subjects.id
  AND s.user_id=app.user_id() AND s.status='ACTIVE' AND ex.status='PUBLISHED' AND ex.retired_at IS NULL
 ));
