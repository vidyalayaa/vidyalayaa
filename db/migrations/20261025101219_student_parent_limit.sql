-- Preserve existing family records. Limit new/reactivated/moved ACTIVE links.
-- Existing students above the limit can have links revoked without losing history.
CREATE FUNCTION app.enforce_student_parent_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'ACTIVE' AND OLD.school_id = NEW.school_id AND OLD.student_id = NEW.student_id
    THEN RETURN NEW; END IF;
  END IF;

  -- A real row update serializes competing attachments. At repeatable-read or
  -- serializable isolation, stale competing writers get a serialization error
  -- instead of checking an old snapshot and admitting a third parent.
  -- The existing touch trigger records the family change on student.updated_at.
  UPDATE public.students SET updated_at = updated_at
  WHERE school_id = NEW.school_id AND id = NEW.student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'STUDENT_NOT_FOUND';
  END IF;
  IF (SELECT count(*) FROM public.student_parents sp
      WHERE sp.school_id = NEW.school_id AND sp.student_id = NEW.student_id
        AND sp.status = 'ACTIVE' AND sp.id IS DISTINCT FROM NEW.id) >= 2
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'STUDENT_PARENT_LIMIT', CONSTRAINT = 'student_parent_limit';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.enforce_student_parent_limit() FROM PUBLIC;
CREATE TRIGGER student_parent_limit
BEFORE INSERT OR UPDATE OF school_id, student_id, status ON public.student_parents
FOR EACH ROW EXECUTE FUNCTION app.enforce_student_parent_limit();
