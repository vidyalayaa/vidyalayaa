-- Keep the existing assignments as the only homework/material source of truth.
ALTER TABLE assignments ADD COLUMN assigned_on date, ADD COLUMN instructions text, ADD COLUMN reference_url text, ADD COLUMN diary_version integer NOT NULL DEFAULT 1;
UPDATE assignments a SET assigned_on=(a.created_at AT TIME ZONE s.timezone)::date FROM schools s WHERE s.id=a.school_id;
ALTER TABLE assignments ALTER COLUMN assigned_on SET NOT NULL, ALTER COLUMN assigned_on SET DEFAULT CURRENT_DATE;
ALTER TABLE assignments ADD CONSTRAINT homework_reference_url CHECK(reference_url IS NULL OR reference_url ~ '^https://[^[:space:]]+$');
CREATE INDEX assignments_diary ON assignments(school_id,assigned_on,class_id,subject_id) WHERE retired_at IS NULL;
CREATE FUNCTION app.guard_homework_diary() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='UPDATE' THEN NEW.diary_version=OLD.diary_version+1; END IF;
 IF TG_OP='INSERT' AND NEW.kind='HOMEWORK' AND NEW.subject_id IS NULL AND current_user='app_api' THEN RAISE EXCEPTION 'SUBJECT_REQUIRED' USING ERRCODE='23514'; END IF;
 IF NEW.due_at IS NOT NULL AND (TG_OP='INSERT' OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.assigned_on IS DISTINCT FROM OLD.assigned_on) AND (NEW.due_at AT TIME ZONE (SELECT timezone FROM schools WHERE id=NEW.school_id))::date<NEW.assigned_on THEN RAISE EXCEPTION 'Deadline precedes assigned date' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_homework_diary() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER homework_diary_guard BEFORE INSERT OR UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION app.guard_homework_diary();
