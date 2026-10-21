-- Existing examinations retain their identity, marks and official-exam meaning.
ALTER TABLE exams ADD COLUMN assessment_kind text NOT NULL DEFAULT 'OFFICIAL'
 CHECK(assessment_kind IN ('OFFICIAL','SUBJECT_TEST'));
ALTER TABLE exams ADD COLUMN subject_id uuid;
ALTER TABLE exams ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE exams ADD CONSTRAINT exam_subject_school FOREIGN KEY(school_id,subject_id) REFERENCES subjects(school_id,id);
ALTER TABLE exams ADD CONSTRAINT assessment_subject_kind CHECK
 ((assessment_kind='OFFICIAL' AND subject_id IS NULL) OR (assessment_kind='SUBJECT_TEST' AND subject_id IS NOT NULL));
-- Preserve legacy null-subject assignments, but never interpret them as all subjects.
ALTER TABLE teacher_class_assignments ADD CONSTRAINT assignment_subject_required
 CHECK(subject_id IS NOT NULL OR retired_at IS NOT NULL) NOT VALID;
CREATE INDEX teacher_class_subject_active ON teacher_class_assignments(school_id,class_id,subject_id,teacher_id) WHERE retired_at IS NULL;
CREATE INDEX teacher_class_teacher ON classes(school_id,class_teacher_id) WHERE class_teacher_id IS NOT NULL;
CREATE INDEX exam_class_kind ON exams(school_id,class_id,assessment_kind,subject_id) WHERE retired_at IS NULL;
CREATE INDEX exam_subject_reference ON exams(school_id,subject_id) WHERE subject_id IS NOT NULL;

INSERT INTO permissions(code) VALUES('classrooms.read'),('assessments.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT r.id,p.id FROM roles r,permissions p
 WHERE (r.code='teacher' AND p.code IN ('classrooms.read','parents.read','assessments.write'))
 OR (r.code='school_admin' AND p.code='assessments.write') ON CONFLICT DO NOTHING;
DELETE FROM role_permissions rp USING roles r,permissions p
 WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.code='teacher' AND p.code='academics.read';

-- Narrow, boolean authorization lookups use an owner context to avoid recursive
-- RLS across classes/enrollments/assignments. They cannot return private rows.
-- Every helper explicitly binds the requested school to the API tenant context.
CREATE FUNCTION app.school_role(sid uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
 SELECT r.code FROM school_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id
 WHERE sid=app.school_id() AND m.school_id=sid AND m.user_id=app.user_id() AND m.status='ACTIVE' AND u.status='ACTIVE'
$$;
-- A suspended/removed user must not fall through to the non-teacher branch.
-- Userless contexts are trusted backend maintenance; support still needs a live grant.
CREATE FUNCTION app.non_teacher_context(sid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND (
 coalesce(app.school_role(sid)<>'teacher',false) OR app.user_id() IS NULL OR
 (current_setting('app.actor_type',true)='SUPPORT' AND app.is_platform_staff() AND EXISTS(
 SELECT FROM support_access_grants g JOIN users u ON u.id=g.staff_user_id
 WHERE g.school_id=sid AND g.staff_user_id=app.user_id() AND u.status='ACTIVE'
 AND g.approved_by IS NOT NULL AND g.starts_at<=now() AND g.expires_at>now() AND g.revoked_at IS NULL)))
$$;
REVOKE ALL ON FUNCTION app.non_teacher_context(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.non_teacher_context(uuid) TO app_api;
CREATE FUNCTION app.teacher_assigned(sid uuid,cid uuid,sub uuid DEFAULT NULL) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND app.school_role(sid)='teacher' AND EXISTS(
 SELECT FROM classes c JOIN teachers te ON te.school_id=c.school_id AND te.user_id=app.user_id()
 JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
 JOIN schools s ON s.id=c.school_id WHERE c.school_id=sid AND c.id=cid
 AND te.status='ACTIVE' AND te.staff_role='teacher' AND c.retired_at IS NULL
 AND ac.is_current AND ac.retired_at IS NULL AND
 ((sub IS NULL AND c.class_teacher_id=te.id) OR EXISTS(SELECT FROM teacher_class_assignments a
 WHERE a.school_id=sid AND a.class_id=cid AND a.teacher_id=te.id AND a.retired_at IS NULL
 AND a.starts_on<=(now() AT TIME ZONE s.timezone)::date
 AND (a.ends_on IS NULL OR a.ends_on>=(now() AT TIME ZONE s.timezone)::date)
 AND (sub IS NULL OR a.subject_id=sub))))
$$;
CREATE FUNCTION app.valid_class_teacher(sid uuid,cid uuid,tid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND cid IS NOT NULL AND EXISTS(SELECT FROM teachers te
 WHERE te.school_id=sid AND te.id=tid AND te.status='ACTIVE' AND te.staff_role='teacher')
$$;
CREATE FUNCTION app.is_class_teacher(sid uuid,cid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT app.teacher_assigned(sid,cid) AND EXISTS(SELECT FROM classes c JOIN teachers te ON te.school_id=c.school_id AND te.id=c.class_teacher_id
 WHERE c.school_id=sid AND c.id=cid AND te.user_id=app.user_id() AND app.valid_class_teacher(sid,cid,te.id))
$$;
CREATE FUNCTION app.teacher_student_access(sid uuid,student uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND EXISTS(SELECT FROM enrollments e JOIN schools s ON s.id=e.school_id
 WHERE e.school_id=sid AND e.student_id=student AND e.status='ACTIVE'
 AND e.starts_on<=(now() AT TIME ZONE s.timezone)::date AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE s.timezone)::date)
 AND app.teacher_assigned(sid,e.class_id))
$$;
CREATE FUNCTION app.teacher_parent_access(sid uuid,pid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND EXISTS(SELECT FROM student_parents sp JOIN parents p ON p.school_id=sp.school_id AND p.id=sp.parent_id
 WHERE sp.school_id=sid AND sp.parent_id=pid AND sp.status='ACTIVE' AND p.status='ACTIVE' AND app.teacher_student_access(sid,sp.student_id))
$$;
CREATE FUNCTION app.teacher_subject_access(sid uuid,sub uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND EXISTS(SELECT FROM classes c WHERE c.school_id=sid AND
 (app.teacher_assigned(sid,c.id,sub) OR app.is_class_teacher(sid,c.id)))
$$;
CREATE FUNCTION app.teacher_exam_access(sid uuid,eid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND EXISTS(SELECT FROM exams e WHERE e.school_id=sid AND e.id=eid AND e.retired_at IS NULL AND
 ((e.assessment_kind='SUBJECT_TEST' AND app.teacher_assigned(sid,e.class_id,e.subject_id)) OR
 (e.assessment_kind='OFFICIAL' AND app.is_class_teacher(sid,e.class_id))))
$$;
CREATE FUNCTION app.teacher_mark_access(sid uuid,eid uuid,sub uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND EXISTS(SELECT FROM exams e WHERE e.school_id=sid AND e.id=eid AND e.retired_at IS NULL AND
 ((e.assessment_kind='SUBJECT_TEST' AND e.subject_id=sub AND app.teacher_assigned(sid,e.class_id,sub)) OR
 (e.assessment_kind='OFFICIAL' AND app.is_class_teacher(sid,e.class_id))))
$$;
REVOKE ALL ON FUNCTION app.school_role(uuid),app.teacher_assigned(uuid,uuid,uuid),app.valid_class_teacher(uuid,uuid,uuid),
 app.is_class_teacher(uuid,uuid),app.teacher_student_access(uuid,uuid),app.teacher_parent_access(uuid,uuid),
 app.teacher_subject_access(uuid,uuid),app.teacher_exam_access(uuid,uuid),app.teacher_mark_access(uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.school_role(uuid),app.teacher_assigned(uuid,uuid,uuid),app.valid_class_teacher(uuid,uuid,uuid),
 app.is_class_teacher(uuid,uuid),app.teacher_student_access(uuid,uuid),app.teacher_parent_access(uuid,uuid),
 app.teacher_subject_access(uuid,uuid),app.teacher_exam_access(uuid,uuid),app.teacher_mark_access(uuid,uuid,uuid) TO app_api;

-- Restrictive policies combine with existing forced tenant policies. Worker and
-- device roles retain their separate contracts; browser database grants stay off.
CREATE POLICY teacher_scope ON students AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR app.teacher_student_access(school_id,id))
 WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON parents AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR app.teacher_parent_access(school_id,id))
 WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON student_parents AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR (status='ACTIVE' AND app.teacher_student_access(school_id,student_id) AND app.teacher_parent_access(school_id,parent_id)))
 WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON classes AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR app.teacher_assigned(school_id,id))
 WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON subjects AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR app.teacher_subject_access(school_id,id))
 WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON enrollments AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR app.teacher_assigned(school_id,class_id))
 WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON academic_sessions AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR (is_current AND EXISTS(SELECT FROM classes c WHERE c.school_id=academic_sessions.school_id AND c.academic_session_id=academic_sessions.id AND app.teacher_assigned(c.school_id,c.id)))) WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON teacher_class_assignments AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR (app.school_role(school_id)='teacher' AND teacher_id IN(SELECT id FROM teachers WHERE school_id=app.school_id() AND user_id=app.user_id())))
 WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON daily_attendance AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR app.teacher_assigned(school_id,class_id))
 WITH CHECK(app.non_teacher_context(school_id) OR (app.is_class_teacher(school_id,class_id) AND app.teacher_student_access(school_id,student_id)));
CREATE POLICY teacher_scope ON assignments AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR (subject_id IS NOT NULL AND app.teacher_assigned(school_id,class_id,subject_id)))
 WITH CHECK(app.non_teacher_context(school_id) OR (subject_id IS NOT NULL AND app.teacher_assigned(school_id,class_id,subject_id)));
CREATE POLICY teacher_scope ON exams AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR (assessment_kind='SUBJECT_TEST' AND app.teacher_assigned(school_id,class_id,subject_id)) OR (assessment_kind='OFFICIAL' AND app.is_class_teacher(school_id,class_id)))
 WITH CHECK(app.non_teacher_context(school_id) OR (assessment_kind='SUBJECT_TEST' AND app.teacher_assigned(school_id,class_id,subject_id)));
CREATE POLICY teacher_scope ON marks AS RESTRICTIVE TO app_api
 USING(app.non_teacher_context(school_id) OR app.teacher_mark_access(school_id,exam_id,subject_id))
 WITH CHECK(app.non_teacher_context(school_id) OR app.teacher_mark_access(school_id,exam_id,subject_id));

CREATE FUNCTION app.guard_teaching_write() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='classes' THEN
  IF current_user='app_api' AND NEW.class_teacher_id IS NULL AND NEW.retired_at IS NULL THEN
   RAISE EXCEPTION 'CLASS_TEACHER_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF NEW.class_teacher_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.class_teacher_id IS DISTINCT FROM OLD.class_teacher_id) AND NOT app.valid_class_teacher(NEW.school_id,NEW.id,NEW.class_teacher_id) THEN
   RAISE EXCEPTION 'ASSIGNED_CLASS_TEACHER_REQUIRED' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='exams' THEN
  IF NEW.assessment_kind IS DISTINCT FROM OLD.assessment_kind OR NEW.class_id IS DISTINCT FROM OLD.class_id OR NEW.subject_id IS DISTINCT FROM OLD.subject_id THEN
   RAISE EXCEPTION 'ASSESSMENT_SCOPE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_teaching_write() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER assigned_class_teacher BEFORE INSERT OR UPDATE ON classes FOR EACH ROW EXECUTE FUNCTION app.guard_teaching_write();
CREATE TRIGGER immutable_assessment_scope BEFORE UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION app.guard_teaching_write();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['classes','subjects','academic_sessions','teacher_class_assignments','enrollments','students','parents','student_parents'] LOOP
  EXECUTE format('CREATE POLICY teacher_no_delete ON %I AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_teacher_context(school_id))',t);
 END LOOP;
END $$;
CREATE POLICY teacher_no_official_delete ON exams AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_teacher_context(school_id) OR assessment_kind='SUBJECT_TEST');
CREATE POLICY teacher_scope ON teachers AS RESTRICTIVE TO app_api USING(app.non_teacher_context(school_id) OR (app.school_role(school_id)='teacher' AND user_id=app.user_id())) WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_no_delete ON teachers AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON timetable_entries AS RESTRICTIVE TO app_api USING(app.non_teacher_context(school_id) OR app.teacher_assigned(school_id,class_id)) WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_no_delete ON timetable_entries AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON attendance_events AS RESTRICTIVE TO app_api USING(app.non_teacher_context(school_id) OR app.teacher_student_access(school_id,student_id)) WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON fee_records AS RESTRICTIVE TO app_api USING(app.non_teacher_context(school_id)) WITH CHECK(app.non_teacher_context(school_id));
CREATE FUNCTION app.guard_teacher_mark() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ex exams;
BEGIN
 IF current_user<>'app_api' THEN RETURN NEW; END IF;
 IF app.school_role(NEW.school_id)='teacher' THEN
  SELECT * INTO ex FROM exams WHERE school_id=NEW.school_id AND id=NEW.exam_id FOR SHARE;
  IF NEW.entered_by<>app.user_id() OR NOT app.teacher_mark_access(NEW.school_id,NEW.exam_id,NEW.subject_id) OR ex.status IS DISTINCT FROM 'OPEN' OR NEW.score>ex.max_score OR
   NOT EXISTS(SELECT FROM enrollments en WHERE en.school_id=NEW.school_id AND en.student_id=NEW.student_id AND en.class_id=ex.class_id AND en.status='ACTIVE') THEN
   RAISE EXCEPTION 'TEACHER_MARK_ACCESS_DENIED' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_teacher_mark() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER teacher_mark_guard BEFORE INSERT OR UPDATE ON marks FOR EACH ROW EXECUTE FUNCTION app.guard_teacher_mark();
CREATE POLICY teacher_scope ON school_holidays AS RESTRICTIVE TO app_api USING(app.non_teacher_context(school_id) OR (app.school_role(school_id)='teacher' AND class_id IS NULL) OR app.teacher_assigned(school_id,class_id)) WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_no_delete ON school_holidays AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_teacher_context(school_id));
CREATE POLICY teacher_scope ON attendance_corrections AS RESTRICTIVE TO app_api USING(app.non_teacher_context(school_id) OR EXISTS(SELECT FROM daily_attendance d WHERE d.school_id=attendance_corrections.school_id AND d.id=attendance_corrections.daily_attendance_id)) WITH CHECK(app.non_teacher_context(school_id) OR (app.school_role(school_id)='teacher' AND requested_by=app.user_id() AND status='REQUESTED' AND approved_by IS NULL AND EXISTS(SELECT FROM daily_attendance d WHERE d.school_id=attendance_corrections.school_id AND d.id=attendance_corrections.daily_attendance_id AND app.is_class_teacher(d.school_id,d.class_id))));
CREATE POLICY teacher_no_decision ON attendance_corrections AS RESTRICTIVE FOR UPDATE TO app_api USING(app.non_teacher_context(school_id)) WITH CHECK(app.non_teacher_context(school_id));
CREATE POLICY teacher_no_delete ON attendance_corrections AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_teacher_context(school_id));
CREATE POLICY teacher_no_delete ON daily_attendance AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_teacher_context(school_id));
CREATE POLICY teacher_no_delete ON marks AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_teacher_context(school_id));
CREATE POLICY teacher_no_delete ON assignments AS RESTRICTIVE FOR DELETE TO app_api USING(app.non_teacher_context(school_id));
CREATE FUNCTION app.guard_teacher_attendance() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF current_user<>'app_api' THEN RETURN NEW; END IF;
 IF app.school_role(NEW.school_id)='teacher' THEN
  IF NOT app.is_class_teacher(NEW.school_id,NEW.class_id) THEN
   RAISE EXCEPTION 'CLASS_TEACHER_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.source='NFC' AND OLD.version>0 THEN RAISE EXCEPTION 'CORRECTION_REQUIRED' USING ERRCODE='42501'; END IF;
  END IF;
  IF NOT EXISTS(SELECT FROM enrollments e WHERE e.school_id=NEW.school_id AND e.student_id=NEW.student_id AND e.class_id=NEW.class_id AND e.starts_on<=NEW.attendance_date AND (e.ends_on IS NULL OR e.ends_on>=NEW.attendance_date)) THEN
   RAISE EXCEPTION 'ENROLLMENT_REQUIRED' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_teacher_attendance() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER teacher_attendance_guard BEFORE INSERT OR UPDATE ON daily_attendance FOR EACH ROW EXECUTE FUNCTION app.guard_teacher_attendance();
-- Changes to class-teacher designation invalidate existing report authorizations.
-- classes already has an access_revision trigger from migration 012.
