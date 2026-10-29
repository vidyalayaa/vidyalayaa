-- Reuse the existing class/section subject relationships. No subject/enrollment
-- rows are copied, deleted or reassigned, including historical shared mappings.
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
 ));
CREATE FUNCTION app.guard_homework_class_subject() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF current_user<>'app_api' OR NEW.subject_id IS NULL THEN RETURN NEW; END IF;
 -- Retain existing historical records when only title/body/due date changes.
 IF TG_OP='UPDATE' AND NEW.class_id IS NOT DISTINCT FROM OLD.class_id AND NEW.subject_id IS NOT DISTINCT FROM OLD.subject_id THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT FROM teacher_class_assignments ta WHERE ta.school_id=NEW.school_id AND ta.class_id=NEW.class_id AND ta.subject_id=NEW.subject_id AND ta.retired_at IS NULL) THEN
  RAISE EXCEPTION 'CLASS_SUBJECT_REQUIRED' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_homework_class_subject() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER homework_class_subject_guard BEFORE INSERT OR UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION app.guard_homework_class_subject();
