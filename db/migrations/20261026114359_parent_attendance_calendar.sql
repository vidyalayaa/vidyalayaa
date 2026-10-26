-- Return only a linked child's date-by-date attendance/calendar projection.
-- Historical section holidays must be resolved even after a class transfer;
-- no unrelated class or raw rule configuration is exposed to the caller.
CREATE FUNCTION app.parent_attendance_days(child uuid, from_date date, to_date date)
RETURNS TABLE(id uuid,attendance_date text,attendance_status text,school_day boolean,
 day_note text,schedule_source text,first_arrival_at timestamptz,last_departure_at timestamptz,grade text,section text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sid uuid:=app.school_id(); today date;
BEGIN
 IF NOT coalesce(app.parent_student_access(sid,child),false) THEN
  RAISE EXCEPTION 'CHILD_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 SELECT (now() AT TIME ZONE sc.timezone)::date INTO today FROM schools sc WHERE sc.id=sid;
 IF from_date IS NULL OR to_date IS NULL OR to_date<from_date OR to_date-from_date>365 OR from_date>today THEN
  RAISE EXCEPTION 'INVALID_ATTENDANCE_RANGE' USING ERRCODE='22023'; END IF;
 RETURN QUERY
 WITH days AS (SELECT d::date AS on_date FROM generate_series(from_date::timestamp,least(to_date,today)::timestamp,interval '1 day') d),
 facts AS (
 SELECT ds.on_date,da.id,da.attendance_status AS recorded_status,da.first_arrival_at,da.last_departure_at,
 c.grade,c.section,en.id AS enrollment_id,ev.kind AS event_kind,ev.label AS event_label,
 CASE WHEN rv.id IS NOT NULL THEN 'ATTENDANCE_RULE' WHEN jsonb_typeof(sc.settings->'timetable'->'days')='array' THEN 'TIMETABLE' ELSE 'DEFAULT' END AS source,
 CASE WHEN ev.kind='WEEKEND_OVERRIDE' THEN true
 WHEN rv.id IS NOT NULL THEN NOT(coalesce(rv.rules->'weekly_off','[]'::jsonb) ? (ARRAY['SUN','MON','TUE','WED','THU','FRI','SAT'])[extract(dow FROM ds.on_date)::int+1])
 WHEN jsonb_typeof(sc.settings->'timetable'->'days')='array' THEN (sc.settings->'timetable'->'days') @> to_jsonb(extract(isodow FROM ds.on_date)::int)
 ELSE extract(isodow FROM ds.on_date)::int BETWEEN 1 AND 6 END AS working
 FROM days ds JOIN schools sc ON sc.id=sid
 LEFT JOIN daily_attendance da ON da.school_id=sid AND da.student_id=child AND da.attendance_date=ds.on_date
 LEFT JOIN LATERAL (SELECT e.* FROM enrollments e JOIN academic_sessions ac ON ac.school_id=e.school_id AND ac.id=e.academic_session_id
 WHERE e.school_id=sid AND e.student_id=child AND e.starts_on<=ds.on_date AND (e.ends_on IS NULL OR e.ends_on>=ds.on_date)
 AND (e.status='ACTIVE' OR (e.status='ENDED' AND e.ends_on IS NOT NULL)) AND ac.starts_on<=ds.on_date AND ac.ends_on>=ds.on_date
 ORDER BY (e.class_id=da.class_id) DESC,e.starts_on DESC,e.id LIMIT 1) en ON true
 LEFT JOIN classes c ON c.school_id=sid AND c.id=coalesce(da.class_id,en.class_id)
 LEFT JOIN LATERAL (SELECT h.kind,h.label FROM school_holidays h WHERE h.school_id=sid AND h.retired_at IS NULL
 AND h.on_date<=ds.on_date AND coalesce(h.ends_on,h.on_date)>=ds.on_date AND h.kind IN ('HOLIDAY','WEEKEND_OVERRIDE','EXAM_DAY','SHORT_DAY')
 AND (cardinality(h.target_class_ids)=0 OR h.target_class_ids@>ARRAY[c.id])
 ORDER BY (cardinality(h.target_class_ids)>0) DESC,CASE h.kind WHEN 'HOLIDAY' THEN 0 WHEN 'WEEKEND_OVERRIDE' THEN 1 WHEN 'EXAM_DAY' THEN 2 ELSE 3 END,h.id LIMIT 1) ev ON true
 LEFT JOIN LATERAL (SELECT r.* FROM attendance_rule_versions r WHERE r.school_id=sid AND
 ((da.rule_version_id IS NOT NULL AND r.id=da.rule_version_id) OR (da.rule_version_id IS NULL AND (r.class_id=c.id OR r.class_id IS NULL)
 AND r.day_type=CASE ev.kind WHEN 'EXAM_DAY' THEN 'EXAM' WHEN 'SHORT_DAY' THEN 'SHORT_DAY' ELSE 'REGULAR' END
 AND r.effective_from<=ds.on_date AND (r.effective_to IS NULL OR r.effective_to>ds.on_date)))
 ORDER BY r.class_id NULLS LAST,r.effective_from DESC LIMIT 1) rv ON true
 ), classified AS (
 SELECT f.*,CASE WHEN f.id IS NOT NULL THEN true WHEN f.enrollment_id IS NULL THEN false
 WHEN f.event_kind='HOLIDAY' THEN false ELSE f.working END AS is_school_day
 FROM facts f)
 SELECT f.id,f.on_date::text,
 coalesce(f.recorded_status,CASE WHEN f.enrollment_id IS NULL THEN 'NOT_ENROLLED' WHEN f.event_kind='HOLIDAY' THEN 'HOLIDAY'
 WHEN NOT f.working THEN 'WEEKLY_OFF' ELSE 'NOT_RECORDED' END),f.is_school_day,
 CASE WHEN f.recorded_status IS NOT NULL THEN NULL WHEN f.enrollment_id IS NULL THEN 'Outside enrolled school dates'
 WHEN f.event_kind='HOLIDAY' THEN coalesce(nullif(f.event_label,''),'School holiday') WHEN NOT f.working THEN 'School weekly off'
 ELSE 'The school has not recorded attendance for this date.' END,
 f.source,f.first_arrival_at,f.last_departure_at,f.grade,f.section FROM classified f ORDER BY f.on_date DESC;
END $$;
REVOKE ALL ON FUNCTION app.parent_attendance_days(uuid,date,date) FROM PUBLIC,anon,authenticated,app_worker,app_platform,app_device;
GRANT EXECUTE ON FUNCTION app.parent_attendance_days(uuid,date,date) TO app_api;
