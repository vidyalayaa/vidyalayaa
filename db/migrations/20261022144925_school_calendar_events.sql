-- Extend the existing calendar source; keep every legacy holiday ID and date.
ALTER TABLE public.school_holidays
  ADD COLUMN ends_on date,
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN target_class_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN dedupe_key text,
  ADD CONSTRAINT calendar_dates CHECK(ends_on IS NULL OR ends_on>=on_date),
  ADD CONSTRAINT calendar_description CHECK(length(description)<=10000),
  ADD CONSTRAINT calendar_version CHECK(version>0),
  ADD CONSTRAINT calendar_target_limit CHECK(cardinality(target_class_ids)<=1000);
ALTER TABLE public.school_holidays DROP CONSTRAINT school_holidays_kind_check;
ALTER TABLE public.school_holidays ADD CONSTRAINT school_holidays_kind_check
  CHECK(kind IN ('HOLIDAY','WEEKEND_OVERRIDE','EXAM_DAY','SHORT_DAY','SCHOOL_EVENT','ACTIVITY','ANNOUNCEMENT','OTHER'));

-- Canonical, sorted section IDs support several classes without copied events.
-- class_id remains compatible with legacy single-section callers.
CREATE FUNCTION app.normalize_calendar_event() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,extensions AS $$
DECLARE previous uuid[] := '{}'; n integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    previous:=OLD.target_class_ids;
    IF OLD.class_id IS NOT NULL THEN previous:=array_append(previous,OLD.class_id);END IF;
    IF NEW.class_id IS DISTINCT FROM OLD.class_id AND NEW.target_class_ids IS NOT DISTINCT FROM OLD.target_class_ids THEN
      NEW.target_class_ids:=CASE WHEN NEW.class_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[NEW.class_id] END;
    END IF;
    NEW.version:=CASE WHEN OLD.dedupe_key IS NULL THEN OLD.version ELSE OLD.version+1 END;
  ELSIF NEW.class_id IS NOT NULL AND cardinality(NEW.target_class_ids)=0 THEN
    NEW.target_class_ids:=ARRAY[NEW.class_id];
  END IF;
  IF NEW.target_class_ids IS NULL OR array_position(NEW.target_class_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'CALENDAR_TARGET_INVALID' USING ERRCODE='23514';
  END IF;
  NEW.target_class_ids:=ARRAY(SELECT DISTINCT x FROM unnest(NEW.target_class_ids) x ORDER BY x);
  PERFORM id FROM classes WHERE school_id=NEW.school_id AND id=ANY(NEW.target_class_ids) FOR KEY SHARE;
  SELECT count(*) INTO n FROM classes WHERE school_id=NEW.school_id AND id=ANY(NEW.target_class_ids)
    AND (retired_at IS NULL OR id=ANY(previous));
  IF n<>cardinality(NEW.target_class_ids) THEN
    RAISE EXCEPTION 'CALENDAR_TARGET_INVALID' USING ERRCODE='23503';
  END IF;
  NEW.class_id:=CASE WHEN cardinality(NEW.target_class_ids)=1 THEN NEW.target_class_ids[1] ELSE NULL END;
  NEW.dedupe_key:=encode(digest(jsonb_build_array(NEW.on_date,coalesce(NEW.ends_on,NEW.on_date),NEW.kind,
    regexp_replace(lower(btrim(coalesce(NEW.label,''))),'[[:space:]]+',' ','g'),NEW.target_class_ids)::text,'sha256'),'hex');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.normalize_calendar_event() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER calendar_normalize BEFORE INSERT OR UPDATE ON public.school_holidays
  FOR EACH ROW EXECUTE FUNCTION app.normalize_calendar_event();
-- Only new metadata is initialized. Avoid touching legacy updated_at values.
ALTER TABLE public.school_holidays DISABLE TRIGGER touch;
UPDATE public.school_holidays SET target_class_ids=CASE WHEN class_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[class_id] END;
ALTER TABLE public.school_holidays ENABLE TRIGGER touch;
ALTER TABLE public.school_holidays ALTER COLUMN dedupe_key SET NOT NULL;
ALTER TABLE public.school_holidays DROP CONSTRAINT school_holidays_school_id_on_date_kind_class_id_key;
CREATE UNIQUE INDEX calendar_no_duplicate ON public.school_holidays(school_id,dedupe_key) WHERE retired_at IS NULL;
CREATE INDEX calendar_dates_lookup ON public.school_holidays(school_id,on_date,coalesce(ends_on,on_date)) WHERE retired_at IS NULL;
CREATE INDEX calendar_target_lookup ON public.school_holidays USING gin(target_class_ids) WHERE retired_at IS NULL;

-- Integrity-only trigger, equivalent to a foreign-key delete guard for UUID arrays.
-- This private, non-callable trigger reads no rows back to the caller.
CREATE FUNCTION app.calendar_class_reference_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS(SELECT FROM school_holidays WHERE school_id=OLD.school_id AND target_class_ids@>ARRAY[OLD.id]) THEN
    RAISE EXCEPTION 'CLASS_HAS_CALENDAR_EVENTS' USING ERRCODE='23503';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.calendar_class_reference_guard() FROM PUBLIC,anon,authenticated,app_api,app_device,app_worker,app_platform;
CREATE TRIGGER calendar_class_reference BEFORE DELETE ON public.classes FOR EACH ROW EXECUTE FUNCTION app.calendar_class_reference_guard();

CREATE FUNCTION app.calendar_class_visible(sid uuid,cid uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND CASE app.school_role(sid)
 WHEN 'school_admin' THEN true WHEN 'principal' THEN true
 WHEN 'teacher' THEN app.teacher_assigned(sid,cid)
 WHEN 'student' THEN EXISTS(
   SELECT FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id
   JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id JOIN schools sc ON sc.id=e.school_id
   WHERE e.school_id=sid AND e.class_id=cid AND s.user_id=app.user_id() AND s.status='ACTIVE' AND e.status='ACTIVE'
   AND c.retired_at IS NULL AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date
   AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date))
 WHEN 'parent' THEN EXISTS(
   SELECT FROM parents p JOIN student_parents sp ON sp.school_id=p.school_id AND sp.parent_id=p.id
   JOIN students s ON s.school_id=sp.school_id AND s.id=sp.student_id
   JOIN enrollments e ON e.school_id=s.school_id AND e.student_id=s.id
   JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id JOIN schools sc ON sc.id=e.school_id
   WHERE p.school_id=sid AND p.user_id=app.user_id() AND p.status='ACTIVE' AND sp.status='ACTIVE' AND s.status='ACTIVE'
   AND e.class_id=cid AND e.status='ACTIVE' AND c.retired_at IS NULL
   AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date))
 ELSE false END
$$;
CREATE FUNCTION app.calendar_event_visible(sid uuid,targets uuid[]) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND app.school_role(sid) IN ('school_admin','principal','teacher','parent','student')
 AND (cardinality(targets)=0 OR EXISTS(SELECT FROM unnest(targets) cid WHERE app.calendar_class_visible(sid,cid)))
$$;
REVOKE ALL ON FUNCTION app.calendar_class_visible(uuid,uuid),app.calendar_event_visible(uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.calendar_class_visible(uuid,uuid),app.calendar_event_visible(uuid,uuid[]) TO app_api;
CREATE POLICY calendar_read ON public.school_holidays AS RESTRICTIVE FOR SELECT TO app_api
 USING(app.calendar_event_visible(school_id,target_class_ids) AND (retired_at IS NULL OR app.school_role(school_id)='school_admin'));
CREATE POLICY calendar_insert ON public.school_holidays AS RESTRICTIVE FOR INSERT TO app_api
 WITH CHECK(app.school_role(school_id)='school_admin');
CREATE POLICY calendar_update ON public.school_holidays AS RESTRICTIVE FOR UPDATE TO app_api
 USING(app.school_role(school_id)='school_admin') WITH CHECK(app.school_role(school_id)='school_admin');
CREATE POLICY calendar_delete ON public.school_holidays AS RESTRICTIVE FOR DELETE TO app_api
 USING(app.school_role(school_id)='school_admin');

INSERT INTO permissions(code) VALUES('calendar.read'),('calendar.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT r.id,p.id FROM roles r,permissions p
 WHERE (p.code='calendar.read' AND r.code IN ('school_admin','principal','teacher','parent','student'))
 OR (p.code='calendar.write' AND r.code='school_admin') ON CONFLICT DO NOTHING;
COMMENT ON TABLE public.school_holidays IS 'School calendar, including legacy attendance holidays and multi-day, multi-section informational events.';
