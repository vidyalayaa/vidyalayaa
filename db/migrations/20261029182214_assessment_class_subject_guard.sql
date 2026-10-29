-- Enforce the selected class subjects for examinations and marks.
-- Class Teachers need to validate configured subjects taught by other staff;
-- their staff-directory RLS must stay restricted. Return a scoped boolean only.
CREATE FUNCTION app.class_subject_configured(sid uuid,cid uuid,sub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND app.timetable_class_visible(sid,cid)
 AND (app.school_role(sid)<>'parent' OR app.parent_record_access(sid,'class',cid))
 AND EXISTS(SELECT FROM teacher_class_assignments ta JOIN subjects s ON s.school_id=ta.school_id AND s.id=ta.subject_id
 WHERE ta.school_id=sid AND ta.class_id=cid AND ta.subject_id=sub AND ta.retired_at IS NULL AND s.retired_at IS NULL)
$$;
REVOKE ALL ON FUNCTION app.class_subject_configured(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,app_platform,app_device,app_worker;
GRANT EXECUTE ON FUNCTION app.class_subject_configured(uuid,uuid,uuid) TO app_api;
CREATE FUNCTION app.guard_assessment_class_subject() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE cid uuid; BEGIN
 IF current_user<>'app_api' OR NEW.subject_id IS NULL THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='exams' THEN
  IF TG_OP='UPDATE' AND NEW.class_id IS NOT DISTINCT FROM OLD.class_id AND NEW.subject_id IS NOT DISTINCT FROM OLD.subject_id THEN RETURN NEW; END IF;
  cid=NEW.class_id;
 ELSE
  IF TG_OP='UPDATE' AND NEW.exam_id IS NOT DISTINCT FROM OLD.exam_id AND NEW.subject_id IS NOT DISTINCT FROM OLD.subject_id THEN RETURN NEW; END IF;
  SELECT class_id INTO cid FROM exams WHERE school_id=NEW.school_id AND id=NEW.exam_id;
 END IF;
 IF NOT coalesce(app.class_subject_configured(NEW.school_id,cid,NEW.subject_id),false) THEN
  RAISE EXCEPTION 'CLASS_SUBJECT_REQUIRED' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_assessment_class_subject() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER assessment_class_subject_guard BEFORE INSERT OR UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION app.guard_assessment_class_subject();
CREATE TRIGGER assessment_class_subject_guard BEFORE INSERT OR UPDATE ON marks FOR EACH ROW EXECUTE FUNCTION app.guard_assessment_class_subject();
