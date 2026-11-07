-- Dedicated logins inherit their runtime group without changing current_user.
CREATE OR REPLACE FUNCTION app.school_profile_editor(sid uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF pg_has_role(current_user,'app_platform','USAGE') THEN
  RETURN app.is_platform_staff();
 END IF;
 RETURN sid=app.school_id() AND (
  app.school_role(sid)='school_admin' OR
  (app.school_role(sid)='principal' AND EXISTS(
   SELECT FROM public.school_profile_private WHERE school_id=sid AND principal_edit_authorized
  ))
 );
END $$;

CREATE OR REPLACE FUNCTION app.guard_school_profile_private() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text; v jsonb;
BEGIN
 IF TG_OP='UPDATE' AND NEW.school_id IS DISTINCT FROM OLD.school_id THEN
  RAISE EXCEPTION 'Profile school is immutable' USING ERRCODE='23514';
 END IF;
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
    AND pg_has_role(current_user,'app_api','USAGE')
    AND NOT pg_has_role(current_user,'app_platform','USAGE') THEN
  IF app.school_role(NEW.school_id) IS DISTINCT FROM 'school_admin' AND (
   (TG_OP='INSERT' AND NEW.principal_edit_authorized) OR
   (TG_OP='UPDATE' AND NEW.principal_edit_authorized IS DISTINCT FROM OLD.principal_edit_authorized)
  ) THEN
   RAISE EXCEPTION 'Only School Admin can authorize profile editing' USING ERRCODE='42501';
  END IF;
 END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(NEW.details) LOOP
  IF k NOT IN('management_name','management_contact_name','management_email','management_phone',
   'management_address','internal_emergency_contacts','internal_policies') OR jsonb_typeof(v)<>'string' THEN
   RAISE EXCEPTION 'Invalid administrative profile field' USING ERRCODE='23514';
  END IF;
 END LOOP;
 NEW.updated_at:=now();
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.guard_school_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text; v jsonb;
BEGIN
 IF TG_OP='UPDATE' AND (
  NEW.profile IS DISTINCT FROM OLD.profile OR NEW.name IS DISTINCT FROM OLD.name OR
  NEW.timezone IS DISTINCT FROM OLD.timezone OR NEW.profile_version IS DISTINCT FROM OLD.profile_version OR
  NEW.settings->'locale' IS DISTINCT FROM OLD.settings->'locale'
 ) THEN
  IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
     AND (pg_has_role(current_user,'app_api','USAGE') OR pg_has_role(current_user,'app_platform','USAGE')) THEN
   IF NOT coalesce(app.school_profile_editor(NEW.id),false) THEN
    RAISE EXCEPTION 'School profile editing is not authorized' USING ERRCODE='42501';
   END IF;
  END IF;
  NEW.profile_version:=OLD.profile_version+1;
 ELSIF TG_OP='UPDATE' THEN
  NEW.profile_version:=OLD.profile_version;
 END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(NEW.profile) LOOP
  IF k NOT IN('tagline','motto','about','established_year','school_type','address_line1',
   'address_line2','locality','city','district','state','postal_code','country','email','phone',
   'alternate_phone','website','principal_name','principal_email','principal_phone',
   'principal_qualification','board','affiliation_number','recognition_number','recognized_by',
   'recognition_valid_until','udise_code','grades_offered','medium','academic_pattern','office_hours',
   'visiting_hours','facilities','infrastructure','accessibility','transport_information',
   'emergency_phone','emergency_instructions','policies')
   OR (k<>'facilities' AND jsonb_typeof(v)<>'string')
   OR (k='facilities' AND (jsonb_typeof(v)<>'array' OR jsonb_array_length(v)>40)) THEN
   RAISE EXCEPTION 'Invalid public school profile field' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.guard_timetable_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 platform_role boolean;
 runtime_login boolean;
BEGIN
 IF NEW.settings->'timetable' IS DISTINCT FROM OLD.settings->'timetable' THEN
  platform_role:=pg_has_role(current_user,'app_platform','USAGE');
  runtime_login:=current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
   AND (platform_role OR pg_has_role(current_user,'app_api','USAGE'));
  IF runtime_login THEN
   IF platform_role THEN
    IF NOT app.is_platform_staff() THEN
     RAISE EXCEPTION 'TIMETABLE_ADMIN_REQUIRED' USING ERRCODE='42501';
    END IF;
   ELSIF app.school_role(NEW.id) IS DISTINCT FROM 'school_admin' THEN
    RAISE EXCEPTION 'TIMETABLE_ADMIN_REQUIRED' USING ERRCODE='42501';
   END IF;
  END IF;
  IF NOT app.valid_timetable_settings(NEW.settings->'timetable') THEN
   RAISE EXCEPTION 'TIMETABLE_TIMINGS_INVALID' USING ERRCODE='23514';
  END IF;
  IF runtime_login AND (NEW.settings->'timetable'->>'version')::int<>
   coalesce((OLD.settings->'timetable'->>'version')::int,0)+1 THEN
   RAISE EXCEPTION 'TIMETABLE_VERSION_CONFLICT' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
