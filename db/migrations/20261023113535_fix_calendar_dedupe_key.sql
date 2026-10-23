-- Fix: replace pgcrypto digest() with built-in md5() in the calendar normalize trigger.
-- On some Supabase instances pgcrypto lives in the 'extensions' schema but the session
-- search_path used by the trigger does not expose it, causing error 42883 (undefined_function)
-- on every INSERT/UPDATE to school_holidays.
-- md5() is a pg_catalog built-in and requires no extension.
CREATE OR REPLACE FUNCTION app.normalize_calendar_event() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$
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
  -- Use built-in md5() instead of pgcrypto digest() to avoid extension schema resolution issues.
  NEW.dedupe_key:=md5(jsonb_build_array(NEW.on_date,coalesce(NEW.ends_on,NEW.on_date),NEW.kind,
    regexp_replace(lower(btrim(coalesce(NEW.label,''))),'[[:space:]]+',' ','g'),NEW.target_class_ids)::text);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.normalize_calendar_event() FROM PUBLIC,anon,authenticated;
