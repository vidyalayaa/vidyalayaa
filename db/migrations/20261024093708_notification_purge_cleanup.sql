-- Integrate only the new notification configuration with the existing approved purge.
-- The existing guarded purge function runs this trigger under its owner context.
CREATE FUNCTION app.cleanup_school_notification_settings() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF OLD.status='PURGING' AND NEW.status='PURGED' THEN
  DELETE FROM school_notification_settings WHERE school_id=NEW.school_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_settings_purge AFTER UPDATE OF status ON school_offboarding
 FOR EACH ROW EXECUTE FUNCTION app.cleanup_school_notification_settings();
REVOKE ALL ON FUNCTION app.cleanup_school_notification_settings() FROM PUBLIC,anon,authenticated,app_api,app_device,app_platform,app_worker;
