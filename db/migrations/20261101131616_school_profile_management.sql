-- The school record remains the single source of identity and public profile.
ALTER TABLE schools ADD COLUMN profile jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(profile)='object' AND octet_length(profile::text)<=80000);
ALTER TABLE schools ADD COLUMN profile_version integer NOT NULL DEFAULT 0 CHECK(profile_version>=0);
GRANT UPDATE(profile,profile_version) ON schools TO app_api;

-- Restricted administrative section of the same school profile.
CREATE TABLE school_profile_private(
 school_id uuid PRIMARY KEY REFERENCES schools(id),
 details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object' AND octet_length(details::text)<=24000),
 principal_edit_authorized boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE school_profile_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_profile_private FORCE ROW LEVEL SECURITY;
REVOKE ALL ON school_profile_private FROM PUBLIC,anon,authenticated,app_device,app_worker;
GRANT SELECT,INSERT,UPDATE ON school_profile_private TO app_api,app_platform;
CREATE POLICY profile_admin_read ON school_profile_private FOR SELECT TO app_api USING(school_id=app.school_id() AND app.school_role(school_id) IN('school_admin','principal'));
CREATE POLICY profile_platform ON school_profile_private TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());

CREATE FUNCTION app.school_profile_editor(sid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$ BEGIN
 IF current_user='app_platform' THEN RETURN app.is_platform_staff();END IF;
 RETURN sid=app.school_id() AND (app.school_role(sid)='school_admin' OR
 (app.school_role(sid)='principal' AND EXISTS(SELECT FROM school_profile_private WHERE school_id=sid AND principal_edit_authorized)));
END $$;
REVOKE ALL ON FUNCTION app.school_profile_editor(uuid) FROM PUBLIC,anon,authenticated,app_worker,app_device;
GRANT EXECUTE ON FUNCTION app.school_profile_editor(uuid) TO app_api,app_platform;
CREATE POLICY profile_admin_insert ON school_profile_private FOR INSERT TO app_api WITH CHECK(app.school_profile_editor(school_id));
CREATE POLICY profile_admin_update ON school_profile_private FOR UPDATE TO app_api USING(app.school_profile_editor(school_id)) WITH CHECK(app.school_profile_editor(school_id));
CREATE FUNCTION app.guard_school_profile_private() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE k text;v jsonb;BEGIN
 IF TG_OP='UPDATE' AND NEW.school_id IS DISTINCT FROM OLD.school_id THEN RAISE EXCEPTION 'Profile school is immutable' USING ERRCODE='23514';END IF;
 IF current_user='app_api' THEN
  IF app.school_role(NEW.school_id) IS DISTINCT FROM 'school_admin' AND (TG_OP='INSERT' AND NEW.principal_edit_authorized OR TG_OP='UPDATE' AND NEW.principal_edit_authorized IS DISTINCT FROM OLD.principal_edit_authorized) THEN RAISE EXCEPTION 'Only School Admin can authorize profile editing' USING ERRCODE='42501';END IF;
 END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(NEW.details) LOOP
  IF k NOT IN('management_name','management_contact_name','management_email','management_phone','management_address','internal_emergency_contacts','internal_policies') OR jsonb_typeof(v)<>'string' THEN RAISE EXCEPTION 'Invalid administrative profile field' USING ERRCODE='23514';END IF;
 END LOOP;
 NEW.updated_at:=now();RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app.guard_school_profile_private() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER school_profile_private_guard BEFORE INSERT OR UPDATE ON school_profile_private FOR EACH ROW EXECUTE FUNCTION app.guard_school_profile_private();

CREATE FUNCTION app.guard_school_profile() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE k text;v jsonb;BEGIN
 IF TG_OP='UPDATE' AND (NEW.profile IS DISTINCT FROM OLD.profile OR NEW.name IS DISTINCT FROM OLD.name OR NEW.timezone IS DISTINCT FROM OLD.timezone OR NEW.profile_version IS DISTINCT FROM OLD.profile_version OR NEW.settings->'locale' IS DISTINCT FROM OLD.settings->'locale') THEN
  IF current_user IN('app_api','app_platform') AND NOT coalesce(app.school_profile_editor(NEW.id),false) THEN RAISE EXCEPTION 'School profile editing is not authorized' USING ERRCODE='42501';END IF;
  NEW.profile_version:=OLD.profile_version+1;
 ELSIF TG_OP='UPDATE' THEN NEW.profile_version:=OLD.profile_version;END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(NEW.profile) LOOP
  IF k NOT IN('tagline','motto','about','established_year','school_type','address_line1','address_line2','locality','city','district','state','postal_code','country','email','phone','alternate_phone','website','principal_name','principal_email','principal_phone','principal_qualification','board','affiliation_number','recognition_number','recognized_by','recognition_valid_until','udise_code','grades_offered','medium','academic_pattern','office_hours','visiting_hours','facilities','infrastructure','accessibility','transport_information','emergency_phone','emergency_instructions','policies') OR (k<>'facilities' AND jsonb_typeof(v)<>'string') OR (k='facilities' AND (jsonb_typeof(v)<>'array' OR jsonb_array_length(v)>40)) THEN RAISE EXCEPTION 'Invalid public school profile field' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app.guard_school_profile() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER school_profile_guard BEFORE INSERT OR UPDATE ON schools FOR EACH ROW EXECUTE FUNCTION app.guard_school_profile();

CREATE TABLE school_profile_assets(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),
 kind text NOT NULL CHECK(kind IN('LOGO','IMAGE','POLICY')),title text NOT NULL CHECK(length(title) BETWEEN 1 AND 150),
 storage_path text NOT NULL UNIQUE,content_type text NOT NULL CHECK(content_type IN('image/png','image/jpeg','image/webp','application/pdf')),
 size integer NOT NULL CHECK(size>0 AND size<=10485760),created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),retired_at timestamptz,
 CHECK(storage_path LIKE school_id::text||'/profile/%'),CHECK((kind='POLICY' AND content_type='application/pdf') OR(kind<>'POLICY' AND content_type<>'application/pdf' AND size<=5242880)));
CREATE UNIQUE INDEX one_school_profile_logo ON school_profile_assets(school_id) WHERE kind='LOGO' AND retired_at IS NULL;
CREATE INDEX school_profile_assets_school ON school_profile_assets(school_id,created_at) WHERE retired_at IS NULL;
ALTER TABLE school_profile_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_profile_assets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON school_profile_assets FROM PUBLIC,anon,authenticated,app_worker,app_device;
GRANT SELECT,INSERT,UPDATE ON school_profile_assets TO app_api,app_platform;
CREATE POLICY profile_assets_read ON school_profile_assets FOR SELECT TO app_api USING(school_id=app.school_id() AND app.school_role(school_id) IS NOT NULL);
CREATE POLICY profile_assets_insert ON school_profile_assets FOR INSERT TO app_api WITH CHECK(app.school_profile_editor(school_id));
CREATE POLICY profile_assets_update ON school_profile_assets FOR UPDATE TO app_api USING(app.school_profile_editor(school_id)) WITH CHECK(app.school_profile_editor(school_id));
CREATE POLICY profile_assets_platform ON school_profile_assets TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());
CREATE FUNCTION app.guard_school_profile_asset() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='UPDATE' AND ROW(OLD.school_id,OLD.id,OLD.storage_path,OLD.kind,OLD.content_type,OLD.size,OLD.created_by) IS DISTINCT FROM ROW(NEW.school_id,NEW.id,NEW.storage_path,NEW.kind,NEW.content_type,NEW.size,NEW.created_by) THEN RAISE EXCEPTION 'Profile asset identity is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app.guard_school_profile_asset() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER school_profile_asset_guard BEFORE UPDATE ON school_profile_assets FOR EACH ROW EXECUTE FUNCTION app.guard_school_profile_asset();

-- The existing School Admin export worker includes the same profile and files.
-- It receives read access only in a school-scoped running export context.
GRANT SELECT ON school_profile_private,school_profile_assets TO app_worker;
CREATE POLICY profile_private_export ON school_profile_private FOR SELECT TO app_worker USING(school_id=app.school_id() AND current_setting('app.actor_type',true)='SYSTEM' AND EXISTS(SELECT FROM school_exports e WHERE e.school_id=school_profile_private.school_id AND e.status='PROCESSING'));
CREATE POLICY profile_assets_export ON school_profile_assets FOR SELECT TO app_worker USING(school_id=app.school_id() AND current_setting('app.actor_type',true)='SYSTEM' AND EXISTS(SELECT FROM school_exports e WHERE e.school_id=school_profile_assets.school_id AND e.status='PROCESSING'));

-- Retain the existing private bucket and extend its allowed images only.
UPDATE storage.buckets SET allowed_mime_types=CASE WHEN allowed_mime_types IS NULL THEN NULL ELSE ARRAY(SELECT DISTINCT x FROM unnest(allowed_mime_types||ARRAY['image/webp']) x) END WHERE id='school-documents';

-- Super Admin may manage a school's published timing configuration as part of
-- its complete profile. Teacher/Principal timetable editing stays unchanged.
GRANT EXECUTE ON FUNCTION app.valid_timetable_settings(jsonb) TO app_platform;
CREATE OR REPLACE FUNCTION app.guard_timetable_settings() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.settings->'timetable' IS DISTINCT FROM OLD.settings->'timetable' THEN
  IF current_user='app_platform' THEN
   IF NOT app.is_platform_staff() THEN RAISE EXCEPTION 'TIMETABLE_ADMIN_REQUIRED' USING ERRCODE='42501';END IF;
  ELSIF current_user='app_api' THEN
   IF app.school_role(NEW.id) IS DISTINCT FROM 'school_admin' THEN RAISE EXCEPTION 'TIMETABLE_ADMIN_REQUIRED' USING ERRCODE='42501';END IF;
  END IF;
  IF NOT app.valid_timetable_settings(NEW.settings->'timetable') THEN RAISE EXCEPTION 'TIMETABLE_TIMINGS_INVALID' USING ERRCODE='23514';END IF;
  IF current_user IN('app_api','app_platform') AND (NEW.settings->'timetable'->>'version')::int<>coalesce((OLD.settings->'timetable'->>'version')::int,0)+1 THEN RAISE EXCEPTION 'TIMETABLE_VERSION_CONFLICT' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
