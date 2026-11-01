-- Add a preparation/confirmation ledger without moving or duplicating history.
ALTER TABLE academic_sessions ADD COLUMN closed_at timestamptz;
CREATE TABLE academic_promotions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),
 source_session_id uuid NOT NULL,target_session_id uuid NOT NULL,
 FOREIGN KEY(school_id,source_session_id) REFERENCES academic_sessions(school_id,id),
 FOREIGN KEY(school_id,target_session_id) REFERENCES academic_sessions(school_id,id),
 status text NOT NULL DEFAULT 'PREPARED' CHECK(status IN ('PREPARED','COMPLETED')),
 class_copies jsonb NOT NULL DEFAULT '[]',plan jsonb,result jsonb,
 created_by uuid NOT NULL REFERENCES users(id),completed_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 CHECK(source_session_id<>target_session_id),UNIQUE(school_id,id),UNIQUE(school_id,target_session_id));
CREATE UNIQUE INDEX promotion_source_once ON academic_promotions(school_id,source_session_id) WHERE status='COMPLETED';
ALTER TABLE academic_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_promotions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON academic_promotions FROM PUBLIC,anon,authenticated,app_api,app_worker,app_device,app_platform;
GRANT SELECT,INSERT,UPDATE ON academic_promotions TO app_api;
CREATE POLICY school_admin_only ON academic_promotions TO app_api
 USING(school_id=app.school_id() AND app.school_role(school_id)='school_admin')
 WITH CHECK(school_id=app.school_id() AND app.school_role(school_id)='school_admin');
CREATE FUNCTION app.guard_promotion_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.status='COMPLETED') THEN RAISE EXCEPTION 'Completed promotions are immutable' USING ERRCODE='23514';END IF;
 IF NEW.school_id IS DISTINCT FROM app.school_id() OR app.school_role(NEW.school_id) IS DISTINCT FROM 'school_admin' THEN RAISE EXCEPTION 'School Admin required' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND ROW(OLD.school_id,OLD.source_session_id,OLD.target_session_id,OLD.class_copies,OLD.created_by) IS DISTINCT FROM ROW(NEW.school_id,NEW.source_session_id,NEW.target_session_id,NEW.class_copies,NEW.created_by) THEN RAISE EXCEPTION 'Promotion scope is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app.guard_promotion_record() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER promotion_guard BEFORE INSERT OR UPDATE OR DELETE ON academic_promotions FOR EACH ROW EXECUTE FUNCTION app.guard_promotion_record();

-- Timetables belong to a class in an academic year. Keep old schedules while
-- permitting the same teacher's schedule to be copied into the next year.
ALTER TABLE timetable_entries ADD COLUMN academic_session_id uuid;
UPDATE timetable_entries t SET academic_session_id=c.academic_session_id FROM classes c WHERE c.school_id=t.school_id AND c.id=t.class_id;
ALTER TABLE timetable_entries ALTER COLUMN academic_session_id SET NOT NULL;
ALTER TABLE timetable_entries ADD FOREIGN KEY(school_id,class_id,academic_session_id) REFERENCES classes(school_id,id,academic_session_id);
CREATE FUNCTION app.set_timetable_year() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 SELECT academic_session_id INTO NEW.academic_session_id FROM classes WHERE school_id=NEW.school_id AND id=NEW.class_id;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app.set_timetable_year() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER academic_timetable_year BEFORE INSERT OR UPDATE ON timetable_entries FOR EACH ROW EXECUTE FUNCTION app.set_timetable_year();
ALTER TABLE timetable_entries DROP CONSTRAINT teacher_no_overlap;
ALTER TABLE timetable_entries ADD CONSTRAINT teacher_no_overlap EXCLUDE USING gist(school_id WITH =,academic_session_id WITH =,teacher_id WITH =,weekday WITH =,int8range((extract(epoch FROM starts_at)*1000)::bigint,(extract(epoch FROM ends_at)*1000)::bigint,'[)') WITH &&) WHERE(retired_at IS NULL);
CREATE OR REPLACE FUNCTION app.timetable_assignment_valid(sid uuid,cid uuid,sub uuid,teacher uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND EXISTS(SELECT FROM teacher_class_assignments ta JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id
 JOIN subjects s ON s.school_id=ta.school_id AND s.id=ta.subject_id JOIN classes c ON c.school_id=ta.school_id AND c.id=ta.class_id
 JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id JOIN schools sc ON sc.id=ta.school_id
 WHERE ta.school_id=sid AND ta.class_id=cid AND ta.subject_id=sub AND ta.teacher_id=teacher AND ta.retired_at IS NULL
 AND te.status='ACTIVE' AND te.staff_role='teacher' AND s.retired_at IS NULL AND c.retired_at IS NULL AND ac.retired_at IS NULL
 AND ta.starts_on<=greatest((now() AT TIME ZONE sc.timezone)::date,ac.starts_on)
 AND (ta.ends_on IS NULL OR ta.ends_on>=greatest((now() AT TIME ZONE sc.timezone)::date,ac.starts_on)))
$$;

-- Every academic write locks its parent year. Activation locks the year first,
-- so concurrent enrollment/configuration writes cannot slip past the preview.
-- Financial collections remain available for outstanding historical balances.
-- The narrow definer helper lets worker writes check/lock the year without
-- granting those roles general academic-session UPDATE rights for row locks.
CREATE FUNCTION app.lock_academic_year(sid uuid,yid uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE closed boolean;BEGIN
 IF sid IS DISTINCT FROM app.school_id() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';END IF;
 SELECT closed_at IS NOT NULL INTO closed FROM academic_sessions WHERE school_id=sid AND id=yid FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Academic year not found' USING ERRCODE='23503';END IF;
 RETURN closed;END $$;
REVOKE ALL ON FUNCTION app.lock_academic_year(uuid,uuid) FROM PUBLIC,anon,authenticated,app_platform;
GRANT EXECUTE ON FUNCTION app.lock_academic_year(uuid,uuid) TO app_api,app_worker,app_device;
CREATE FUNCTION app.guard_closed_academic_year() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; sid uuid; year_id uuid; is_closed boolean; BEGIN
 IF current_user NOT IN ('app_api','app_worker','app_device') THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(to_jsonb(NEW)) WHEN 'DELETE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END) LOOP
  sid:=(item->>'school_id')::uuid;
  IF TG_TABLE_NAME='academic_sessions' THEN
   IF TG_OP<>'INSERT' AND OLD.closed_at IS NOT NULL AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'ACADEMIC_YEAR_CLOSED' USING ERRCODE='23514';END IF;
   IF TG_OP='UPDATE' AND NEW.closed_at IS DISTINCT FROM OLD.closed_at AND app.school_role(sid) IS DISTINCT FROM 'school_admin' THEN RAISE EXCEPTION 'School Admin required' USING ERRCODE='42501';END IF;
   CONTINUE;
  ELSIF item ? 'academic_session_id' THEN year_id:=(item->>'academic_session_id')::uuid;
  ELSIF TG_TABLE_NAME='marks' THEN SELECT c.academic_session_id INTO year_id FROM exams ex JOIN classes c ON c.school_id=ex.school_id AND c.id=ex.class_id WHERE ex.school_id=sid AND ex.id=(item->>'exam_id')::uuid;
  ELSE SELECT academic_session_id INTO year_id FROM classes WHERE school_id=sid AND id=(item->>'class_id')::uuid;END IF;
  IF year_id IS NOT NULL THEN
   is_closed:=app.lock_academic_year(sid,year_id);
   IF is_closed THEN RAISE EXCEPTION 'ACADEMIC_YEAR_CLOSED' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.guard_closed_academic_year() FROM PUBLIC,anon,authenticated;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['academic_sessions','classes','enrollments','teacher_class_assignments','exams','marks','assignments','timetable_entries','daily_attendance','fee_structures'] LOOP
 EXECUTE format('CREATE TRIGGER academic_year_lock BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.guard_closed_academic_year()',t);
 END LOOP;
END $$;
