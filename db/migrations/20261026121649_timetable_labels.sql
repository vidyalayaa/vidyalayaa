-- Complete class timetables need other lecturers' display names, while the
-- teacher/subject directory RLS must stay unchanged. Expose only labels for an
-- already authorized active lecture, never staff contacts or other class data.
CREATE FUNCTION app.timetable_entry_labels(sid uuid,eid uuid)
RETURNS TABLE(subject_label text,teacher_label text,class_label text,class_grade text,class_section text,session_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT s.name,te.full_name,concat_ws(' ',c.grade,c.section),c.grade,c.section,ac.name
 FROM timetable_entries t JOIN classes c ON c.school_id=t.school_id AND c.id=t.class_id
 JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
 LEFT JOIN subjects s ON s.school_id=t.school_id AND s.id=t.subject_id
 LEFT JOIN teachers te ON te.school_id=t.school_id AND te.id=t.teacher_id
 WHERE sid=app.school_id() AND t.school_id=sid AND t.id=eid AND t.retired_at IS NULL
 AND app.timetable_class_visible(sid,t.class_id)
 AND (app.school_role(sid)<>'parent' OR app.parent_record_access(sid,'class',t.class_id))
$$;
REVOKE ALL ON FUNCTION app.timetable_entry_labels(uuid,uuid) FROM PUBLIC,anon,authenticated,app_platform,app_device,app_worker;
GRANT EXECUTE ON FUNCTION app.timetable_entry_labels(uuid,uuid) TO app_api;
