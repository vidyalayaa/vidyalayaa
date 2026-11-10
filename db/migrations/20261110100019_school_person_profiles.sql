ALTER TABLE students ADD COLUMN profile_photo_id uuid;
ALTER TABLE teachers ADD COLUMN profile_photo_id uuid;

CREATE TABLE school_person_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  student_id uuid,
  staff_id uuid,
  details jsonb NOT NULL DEFAULT '{}',
  CHECK (num_nonnulls(student_id,staff_id)=1),
  CHECK (jsonb_typeof(details)='object' AND octet_length(details::text)<=16384),
  FOREIGN KEY (school_id,student_id) REFERENCES students(school_id,id) ON DELETE CASCADE,
  FOREIGN KEY (school_id,staff_id) REFERENCES teachers(school_id,id) ON DELETE CASCADE,
  UNIQUE (school_id,student_id),
  UNIQUE (school_id,staff_id)
);
ALTER TABLE school_person_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_person_details FORCE ROW LEVEL SECURITY;
REVOKE ALL ON school_person_details FROM PUBLIC,anon,authenticated,app_device,app_platform,app_worker,app_api;
GRANT SELECT,INSERT,UPDATE ON school_person_details TO app_api;

CREATE POLICY person_details_read ON school_person_details FOR SELECT TO app_api USING (
  school_id=(SELECT app.school_id()) AND (
    (SELECT app.school_role(app.school_id()))='school_admin'
    OR (student_id IS NOT NULL AND (
      ((SELECT app.school_role(app.school_id()))='student' AND EXISTS (
        SELECT FROM students s WHERE s.school_id=school_person_details.school_id
          AND s.id=student_id AND s.user_id=(SELECT app.user_id())
      ))
      OR ((SELECT app.school_role(app.school_id()))='parent' AND app.parent_student_access(school_id,student_id))
    ))
    OR (staff_id IS NOT NULL AND (SELECT app.school_role(app.school_id())) IN ('teacher','principal','finance_staff')
      AND EXISTS (SELECT FROM teachers t WHERE t.school_id=school_person_details.school_id
        AND t.id=staff_id AND t.user_id=(SELECT app.user_id())))
  )
);
CREATE POLICY person_details_insert ON school_person_details FOR INSERT TO app_api
  WITH CHECK (school_id=(SELECT app.school_id()) AND (SELECT app.school_role(app.school_id()))='school_admin');
CREATE POLICY person_details_update ON school_person_details FOR UPDATE TO app_api
  USING (school_id=(SELECT app.school_id()) AND (SELECT app.school_role(app.school_id()))='school_admin')
  WITH CHECK (school_id=(SELECT app.school_id()) AND (SELECT app.school_role(app.school_id()))='school_admin');

CREATE FUNCTION app.guard_person_photo() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE changed boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    changed:=NEW.profile_photo_id IS NOT NULL;
  ELSE
    changed:=NEW.profile_photo_id IS DISTINCT FROM OLD.profile_photo_id;
  END IF;
  IF changed AND pg_has_role(current_user,'app_api','USAGE')
    AND (NEW.school_id IS DISTINCT FROM app.school_id()
      OR app.school_role(NEW.school_id) IS DISTINCT FROM 'school_admin') THEN
    RAISE EXCEPTION 'Profile photo management requires School Admin' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_person_photo() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER student_photo_guard BEFORE INSERT OR UPDATE OF profile_photo_id ON students
  FOR EACH ROW EXECUTE FUNCTION app.guard_person_photo();
CREATE TRIGGER staff_photo_guard BEFORE INSERT OR UPDATE OF profile_photo_id ON teachers
  FOR EACH ROW EXECUTE FUNCTION app.guard_person_photo();

-- Keep historical identifiers intact while preventing new ambiguous matches.
CREATE INDEX student_profile_code_match ON students(school_id,lower(normalize(btrim(student_code),NFKC)));
CREATE INDEX staff_profile_code_match ON teachers(school_id,lower(normalize(btrim(staff_code),NFKC)));
CREATE FUNCTION app.guard_profile_code() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE code_column text:=TG_ARGV[0]; submitted text:=to_jsonb(NEW)->>code_column; existing boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF submitted IS NOT DISTINCT FROM (to_jsonb(OLD)->>code_column) THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.school_id||':'||TG_TABLE_NAME,0));
  EXECUTE format('SELECT EXISTS(SELECT FROM public.%I WHERE school_id=$1 AND id<>$2
    AND lower(normalize(btrim(%I),NFKC))=lower(normalize(btrim($3),NFKC)))',TG_TABLE_NAME,code_column)
    INTO existing USING NEW.school_id,NEW.id,submitted;
  IF existing THEN RAISE EXCEPTION 'PROFILE_CODE_DUPLICATE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_profile_code() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER student_profile_code_guard BEFORE INSERT OR UPDATE OF student_code ON students
  FOR EACH ROW EXECUTE FUNCTION app.guard_profile_code('student_code');
CREATE TRIGGER staff_profile_code_guard BEFORE INSERT OR UPDATE OF staff_code ON teachers
  FOR EACH ROW EXECUTE FUNCTION app.guard_profile_code('staff_code');
