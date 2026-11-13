-- A closing school cannot issue a new invitation through any invitation entry point.
CREATE OR REPLACE FUNCTION app.can_invite_member(sid uuid,code text,target text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT FROM schools WHERE id=sid AND status<>'TERMINATED')
 AND NOT EXISTS(SELECT FROM school_offboarding o WHERE o.school_id=sid AND o.permanent
   AND o.status IN ('CLOSED','PURGE_REQUESTED','PURGING'))
 AND (
   (sid=app.school_id() AND EXISTS(
      SELECT FROM school_memberships m JOIN role_permissions rp ON rp.role_id=m.role_id
      JOIN permissions p ON p.id=rp.permission_id JOIN users u ON u.id=m.user_id
      WHERE m.school_id=sid AND m.user_id=app.user_id() AND m.status='ACTIVE'
        AND u.status='ACTIVE' AND p.code='users.manage'))
   OR (app.is_platform_staff() AND code='school_admin'
      AND EXISTS(SELECT FROM schools WHERE id=sid AND administrator_onboarded_at IS NULL)
      AND NOT EXISTS(SELECT FROM school_memberships m JOIN roles r ON r.id=m.role_id
        JOIN users u ON u.id=m.user_id WHERE m.school_id=sid AND r.code='school_admin'
        AND (m.status IN ('ACTIVE','SUSPENDED') OR (m.status='INVITED' AND lower(u.email::text)<>lower(target))))
      AND NOT EXISTS(SELECT FROM school_invitations i WHERE i.school_id=sid
        AND i.role_code='school_admin' AND i.status IN ('SENDING','SENT','READY')
        AND i.email<>target::citext AND i.expires_at>now()))
 )
$$;

-- Push registration is global per endpoint. Remove only owner records for
-- endpoints left without any school subscription by this erasure.
CREATE FUNCTION app.erase_school_push_endpoint_owners() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE h text;
BEGIN
 IF NOT app.in_school_erasure(app.school_id()) THEN RETURN NULL; END IF;
 FOR h IN SELECT DISTINCT token_hash FROM erased_push_tokens ORDER BY token_hash LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('push:'||h,0));
  DELETE FROM app.push_endpoint_owners o WHERE o.token_hash=h
    AND NOT EXISTS(SELECT FROM public.push_tokens p WHERE p.token_hash=h);
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.erase_school_push_endpoint_owners()
 FROM PUBLIC,anon,authenticated,app_api,app_platform,app_worker,app_device;
CREATE TRIGGER erase_school_push_endpoint_owners AFTER DELETE ON public.push_tokens
 REFERENCING OLD TABLE AS erased_push_tokens FOR EACH STATEMENT
 EXECUTE FUNCTION app.erase_school_push_endpoint_owners();

