-- Runtime logins inherit app_api but do not have current_user='app_api'.
-- Only the private checked queue function's owner may insert CUSTOM work.
-- Its SECURITY DEFINER context is distinct from every application login.
CREATE OR REPLACE FUNCTION app.guard_custom_notification() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.kind='CUSTOM' AND current_user<>pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='app.queue_custom_notification(text,text,uuid[],text,text)'::regprocedure)) THEN
   RAISE EXCEPTION 'Use authorized notification queue' USING ERRCODE='42501';
  END IF;
 ELSE
  IF (OLD.kind='CUSTOM' OR NEW.kind='CUSTOM') AND ROW(NEW.kind,NEW.payload,NEW.school_id,NEW.created_by,NEW.dedupe_key) IS DISTINCT FROM ROW(OLD.kind,OLD.payload,OLD.school_id,OLD.created_by,OLD.dedupe_key) THEN
   RAISE EXCEPTION 'NOTIFICATION_HISTORY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.cancelled_at,NEW.cancelled_by) IS DISTINCT FROM ROW(OLD.cancelled_at,OLD.cancelled_by) THEN
   IF NOT app.notification_admin() THEN RAISE EXCEPTION 'Cancellation denied' USING ERRCODE='42501';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_custom_notification() FROM PUBLIC,anon,authenticated,app_api,app_device,app_platform,app_worker;
