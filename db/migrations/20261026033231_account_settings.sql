-- Auth owns credentials and verification. Only expose the caller's credential
-- presence, never hashes, identities belonging to other users, or auth tables.
CREATE FUNCTION app.account_credentials() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE uid uuid := app.user_id(); result jsonb;
BEGIN
 IF uid IS NULL OR NOT EXISTS(SELECT FROM users WHERE id=uid AND status='ACTIVE')
 THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('email',a.email,
   'has_password',coalesce((to_jsonb(a)->>'encrypted_password')<>'',false),
   'pending_email',nullif(to_jsonb(a)->>'email_change',''),
   'email_confirmed',a.email_confirmed_at IS NOT NULL)
 INTO result FROM auth.users a WHERE a.id=uid;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.account_credentials() FROM PUBLIC,anon,authenticated,app_api,app_platform,app_worker,app_device;
GRANT EXECUTE ON FUNCTION app.account_credentials() TO app_api;

-- GoTrue keeps email_change separate until confirmation has completed. Mirror
-- only its verified canonical email; preserve IDs, memberships and school data.
CREATE FUNCTION app.sync_verified_account_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.email_confirmed_at IS NOT NULL AND NEW.email IS NOT NULL THEN
   UPDATE users SET email=NEW.email,updated_at=now() WHERE id=NEW.id
   AND email::text IS DISTINCT FROM NEW.email;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.sync_verified_account_email() FROM PUBLIC,anon,authenticated,app_api,app_platform,app_worker,app_device;
CREATE TRIGGER auth_verified_email_changed AFTER UPDATE OF email,email_confirmed_at ON auth.users
FOR EACH ROW EXECUTE FUNCTION app.sync_verified_account_email();

-- Repair previously verified canonical email changes without changing ownership.
UPDATE users u SET email=a.email,updated_at=now() FROM auth.users a
WHERE u.id=a.id AND a.email_confirmed_at IS NOT NULL AND a.email IS NOT NULL
AND u.email::text IS DISTINCT FROM a.email;
