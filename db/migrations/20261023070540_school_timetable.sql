-- Timetable entries remain the source of truth. Timing templates live in the
-- existing school settings; legacy lectures are never rewritten or removed.
CREATE FUNCTION app.valid_timetable_settings(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path=pg_catalog AS $$
DECLARE s jsonb; i integer:=0; previous_end time; pattern text:='^([01][0-9]|2[0-3]):[0-5][0-9]$';
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object' THEN RETURN false;END IF;
 IF NOT(p ?& ARRAY['version','days','start_time','lecture_duration','lecture_count','periods','breaks']) OR
    p-ARRAY['version','days','start_time','lecture_duration','lecture_count','periods','breaks']<>'{}'::jsonb THEN RETURN false;END IF;
 IF jsonb_typeof(p->'version')<>'number' OR jsonb_typeof(p->'lecture_duration')<>'number' OR jsonb_typeof(p->'lecture_count')<>'number' OR
    NOT coalesce(p->>'version' ~ '^[0-9]+$',false) OR (p->>'version')::bigint NOT BETWEEN 1 AND 2147483647 OR
    NOT coalesce(p->>'start_time' ~ pattern,false) OR
    NOT coalesce(p->>'lecture_duration' ~ '^[0-9]+$',false) OR (p->>'lecture_duration')::int NOT BETWEEN 5 AND 180 OR
    NOT coalesce(p->>'lecture_count' ~ '^[0-9]+$',false) OR (p->>'lecture_count')::int NOT BETWEEN 1 AND 16 THEN RETURN false;END IF;
 IF jsonb_typeof(p->'days')<>'array' OR jsonb_array_length(p->'days') NOT BETWEEN 1 AND 7 OR
    jsonb_typeof(p->'periods')<>'array' OR jsonb_array_length(p->'periods')<>(p->>'lecture_count')::int OR
    jsonb_typeof(p->'breaks')<>'array' OR jsonb_array_length(p->'breaks')>10 THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(p->'days') d WHERE jsonb_typeof(d)<>'number' OR NOT(d::text ~ '^[1-7]$')) OR
    (SELECT count(DISTINCT value) FROM jsonb_array_elements(p->'days'))<>jsonb_array_length(p->'days') THEN RETURN false;END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'periods') WITH ORDINALITY a(value,n) ORDER BY n LOOP
   i:=i+1;
   IF jsonb_typeof(s)<>'object' OR NOT(s ?& ARRAY['number','label','start_time','end_time']) OR
      s-ARRAY['number','label','start_time','end_time']<>'{}'::jsonb OR jsonb_typeof(s->'number')<>'number' OR NOT coalesce(s->>'number' ~ '^[0-9]+$',false) OR
      (s->>'number')::int<>i OR jsonb_typeof(s->'label')<>'string' OR length(btrim(s->>'label')) NOT BETWEEN 1 AND 80 OR
      NOT coalesce(s->>'start_time' ~ pattern,false) OR NOT coalesce(s->>'end_time' ~ pattern,false) THEN RETURN false;END IF;
   IF (s->>'start_time')::time<(p->>'start_time')::time OR (s->>'end_time')::time<=(s->>'start_time')::time OR
      (previous_end IS NOT NULL AND (s->>'start_time')::time<previous_end) THEN RETURN false;END IF;
   previous_end:=(s->>'end_time')::time;
 END LOOP;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'breaks') LOOP
   IF jsonb_typeof(s)<>'object' OR NOT(s ?& ARRAY['label','start_time','end_time']) OR
      s-ARRAY['label','start_time','end_time']<>'{}'::jsonb OR jsonb_typeof(s->'label')<>'string' OR length(btrim(s->>'label')) NOT BETWEEN 1 AND 80 OR
      NOT coalesce(s->>'start_time' ~ pattern,false) OR NOT coalesce(s->>'end_time' ~ pattern,false) THEN RETURN false;END IF;
   IF (s->>'start_time')::time<(p->>'start_time')::time OR (s->>'end_time')::time<=(s->>'start_time')::time THEN RETURN false;END IF;
 END LOOP;
 IF EXISTS(SELECT FROM jsonb_array_elements((p->'periods')||(p->'breaks')) WITH ORDINALITY a(s,n)
   JOIN jsonb_array_elements((p->'periods')||(p->'breaks')) WITH ORDINALITY b(s,n) ON a.n<b.n
   WHERE (a.s->>'start_time')::time<(b.s->>'end_time')::time AND (a.s->>'end_time')::time>(b.s->>'start_time')::time) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.valid_timetable_settings(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.valid_timetable_settings(jsonb) TO app_api;

CREATE FUNCTION app.guard_timetable_settings() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.settings->'timetable' IS DISTINCT FROM OLD.settings->'timetable' THEN
   IF current_user='app_platform' OR (current_user='app_api' AND app.school_role(NEW.id) IS DISTINCT FROM 'school_admin') THEN
     RAISE EXCEPTION 'TIMETABLE_ADMIN_REQUIRED' USING ERRCODE='42501';END IF;
   IF NOT app.valid_timetable_settings(NEW.settings->'timetable') THEN
     RAISE EXCEPTION 'TIMETABLE_TIMINGS_INVALID' USING ERRCODE='23514';END IF;
   IF current_user='app_api' AND (NEW.settings->'timetable'->>'version')::int<>coalesce((OLD.settings->'timetable'->>'version')::int,0)+1 THEN
     RAISE EXCEPTION 'TIMETABLE_VERSION_CONFLICT' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_timetable_settings() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER timetable_settings_guard BEFORE UPDATE OF settings ON schools FOR EACH ROW EXECUTE FUNCTION app.guard_timetable_settings();

CREATE FUNCTION app.timetable_class_visible(sid uuid,cid uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND EXISTS(SELECT FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
 WHERE c.school_id=sid AND c.id=cid AND c.retired_at IS NULL AND ac.retired_at IS NULL AND CASE app.school_role(sid)
 WHEN 'school_admin' THEN true WHEN 'principal' THEN true WHEN 'teacher' THEN app.teacher_assigned(sid,cid)
 WHEN 'student' THEN EXISTS(SELECT FROM students s JOIN enrollments e ON e.school_id=s.school_id AND e.student_id=s.id JOIN schools sc ON sc.id=s.school_id
   WHERE s.school_id=sid AND s.user_id=app.user_id() AND s.status='ACTIVE' AND e.class_id=cid AND e.status='ACTIVE'
   AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date))
 WHEN 'parent' THEN EXISTS(SELECT FROM parents p JOIN student_parents sp ON sp.school_id=p.school_id AND sp.parent_id=p.id
   JOIN students s ON s.school_id=sp.school_id AND s.id=sp.student_id JOIN enrollments e ON e.school_id=s.school_id AND e.student_id=s.id JOIN schools sc ON sc.id=p.school_id
   WHERE p.school_id=sid AND p.user_id=app.user_id() AND p.status='ACTIVE' AND sp.status='ACTIVE' AND s.status='ACTIVE' AND e.status='ACTIVE' AND e.class_id=cid
   AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date))
 ELSE false END)
$$;
CREATE FUNCTION app.timetable_assignment_valid(sid uuid,cid uuid,sub uuid,teacher uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND EXISTS(SELECT FROM teacher_class_assignments ta JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id
 JOIN subjects s ON s.school_id=ta.school_id AND s.id=ta.subject_id JOIN classes c ON c.school_id=ta.school_id AND c.id=ta.class_id
 JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id JOIN schools sc ON sc.id=ta.school_id
 WHERE ta.school_id=sid AND ta.class_id=cid AND ta.subject_id=sub AND ta.teacher_id=teacher AND ta.retired_at IS NULL
 AND te.status='ACTIVE' AND te.staff_role='teacher' AND s.retired_at IS NULL AND c.retired_at IS NULL AND ac.retired_at IS NULL
 AND ta.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE sc.timezone)::date))
$$;
REVOKE ALL ON FUNCTION app.timetable_class_visible(uuid,uuid),app.timetable_assignment_valid(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.timetable_class_visible(uuid,uuid),app.timetable_assignment_valid(uuid,uuid,uuid,uuid) TO app_api;

CREATE POLICY timetable_read ON timetable_entries AS RESTRICTIVE FOR SELECT TO app_api
 USING(app.timetable_class_visible(school_id,class_id) AND (retired_at IS NULL OR app.school_role(school_id)='school_admin'));
CREATE POLICY timetable_insert ON timetable_entries AS RESTRICTIVE FOR INSERT TO app_api WITH CHECK(app.school_role(school_id)='school_admin');
CREATE POLICY timetable_update ON timetable_entries AS RESTRICTIVE FOR UPDATE TO app_api USING(app.school_role(school_id)='school_admin') WITH CHECK(app.school_role(school_id)='school_admin');
CREATE POLICY timetable_delete ON timetable_entries AS RESTRICTIVE FOR DELETE TO app_api USING(app.school_role(school_id)='school_admin');

CREATE FUNCTION app.guard_timetable_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE config jsonb;
BEGIN
 -- Migration/restore owners retain their existing maintenance paths; no browser
 -- role has table grants. Runtime API writes are checked even outside Express.
 IF current_user<>'app_api' THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF app.school_role(CASE WHEN TG_OP='DELETE' THEN OLD.school_id ELSE NEW.school_id END) IS DISTINCT FROM 'school_admin' THEN
   RAISE EXCEPTION 'TIMETABLE_ADMIN_REQUIRED' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF NEW.retired_at IS NOT NULL THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND OLD.retired_at IS NULL AND
    ROW(NEW.school_id,NEW.class_id,NEW.subject_id,NEW.teacher_id,NEW.weekday,NEW.starts_at,NEW.ends_at)
    IS NOT DISTINCT FROM ROW(OLD.school_id,OLD.class_id,OLD.subject_id,OLD.teacher_id,OLD.weekday,OLD.starts_at,OLD.ends_at) THEN RETURN NEW;END IF;
 IF NOT app.timetable_assignment_valid(NEW.school_id,NEW.class_id,NEW.subject_id,NEW.teacher_id) THEN
   RAISE EXCEPTION 'TIMETABLE_ASSIGNMENT_INVALID' USING ERRCODE='23514';END IF;
 SELECT settings->'timetable' INTO config FROM schools WHERE id=NEW.school_id FOR SHARE;
 IF config IS NOT NULL AND (NOT(config->'days' @> jsonb_build_array(NEW.weekday)) OR
   NOT EXISTS(SELECT FROM jsonb_array_elements(config->'periods') p WHERE (p->>'start_time')::time=NEW.starts_at AND (p->>'end_time')::time=NEW.ends_at)) THEN
   RAISE EXCEPTION 'TIMETABLE_PERIOD_INVALID' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_timetable_entry() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER timetable_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON timetable_entries FOR EACH ROW EXECUTE FUNCTION app.guard_timetable_entry();
CREATE INDEX timetable_class_week ON timetable_entries(school_id,class_id,weekday,starts_at) WHERE retired_at IS NULL;
