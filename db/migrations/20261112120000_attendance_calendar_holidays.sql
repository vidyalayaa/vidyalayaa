-- Family calendars can explain historical attendance without widening access to
-- the school events API or revealing an event's other target sections.
CREATE FUNCTION app.attendance_calendar_holidays(sid uuid, child uuid, from_date date, to_date date)
RETURNS TABLE(id uuid, kind text, label text, on_date date, ends_on date, target_class_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF sid IS DISTINCT FROM app.school_id() OR NOT coalesce(
  CASE app.school_role(sid)
   WHEN 'parent' THEN app.parent_student_access(sid,child)
   WHEN 'student' THEN EXISTS(SELECT FROM students s
     WHERE s.school_id=sid AND s.id=child AND s.user_id=app.user_id() AND s.status='ACTIVE')
   ELSE false
  END,false) THEN RAISE EXCEPTION 'ATTENDANCE_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 IF from_date IS NULL OR to_date IS NULL OR to_date<from_date OR to_date-from_date>365
 THEN RAISE EXCEPTION 'INVALID_ATTENDANCE_RANGE' USING ERRCODE='22023'; END IF;
 RETURN QUERY
 WITH events AS (
  SELECT h.id,h.kind,h.label,h.on_date,coalesce(h.ends_on,h.on_date) AS end_date,
   cardinality(h.target_class_ids)=0 AS whole_school,
   ARRAY(SELECT DISTINCT e.class_id FROM enrollments e
    JOIN academic_sessions a ON a.school_id=e.school_id AND a.id=e.academic_session_id
    WHERE e.school_id=sid AND e.student_id=child AND e.class_id=ANY(h.target_class_ids)
      AND (e.status='ACTIVE' OR e.ends_on IS NOT NULL)
      AND greatest(e.starts_on,a.starts_on,h.on_date,from_date)
          <=least(e.ends_on,a.ends_on,coalesce(h.ends_on,h.on_date),to_date)) AS visible_targets
  FROM school_holidays h WHERE h.school_id=sid AND h.retired_at IS NULL
    AND h.kind IN ('HOLIDAY','WEEKEND_OVERRIDE','EXAM_DAY','SHORT_DAY')
    AND h.on_date<=to_date AND coalesce(h.ends_on,h.on_date)>=from_date
 )
 SELECT h.id,h.kind,h.label,h.on_date,h.end_date,h.visible_targets
 FROM events h WHERE h.whole_school OR cardinality(h.visible_targets)>0;
END $$;
REVOKE ALL ON FUNCTION app.attendance_calendar_holidays(uuid,uuid,date,date)
 FROM PUBLIC,anon,authenticated,app_platform,app_device,app_worker;
GRANT EXECUTE ON FUNCTION app.attendance_calendar_holidays(uuid,uuid,date,date) TO app_api;

CREATE POLICY student_attendance_read ON daily_attendance AS RESTRICTIVE FOR SELECT TO app_api
 USING(app.non_student_context(school_id) OR EXISTS(
  SELECT FROM students s WHERE s.school_id=daily_attendance.school_id
   AND s.id=daily_attendance.student_id AND s.user_id=app.user_id() AND s.status='ACTIVE'
 ));
