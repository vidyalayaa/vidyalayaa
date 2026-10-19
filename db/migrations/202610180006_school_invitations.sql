-- Website onboarding. Platform access remains metadata-only and first-admin-only.
ALTER TABLE schools ADD COLUMN administrator_onboarded_at timestamptz;
UPDATE schools s SET administrator_onboarded_at=(
  SELECT min(m.created_at) FROM school_memberships m JOIN roles r ON r.id=m.role_id
  WHERE m.school_id=s.id AND r.code='school_admin' AND m.status<>'INVITED'
);
CREATE TABLE school_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  email citext NOT NULL,
  full_name text NOT NULL CHECK(length(full_name) BETWEEN 1 AND 200),
  role_code text NOT NULL REFERENCES roles(code),
  user_id uuid REFERENCES users(id),
  invited_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK(status IN ('SENDING','SENT','READY','ACCEPTED','REVOKED','FAILED')),
  attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  send_started_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,email), UNIQUE(school_id,id)
);
CREATE INDEX invitation_recipient ON school_invitations(user_id,status,expires_at);
ALTER TABLE school_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_invitations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON school_invitations FROM PUBLIC,anon,authenticated;
CREATE TRIGGER touch BEFORE UPDATE ON school_invitations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON school_invitations FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE FUNCTION app.can_invite_member(sid uuid,code text,target text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT FROM schools WHERE id=sid AND status<>'TERMINATED') AND (
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
CREATE POLICY managed_invitations ON school_invitations FOR SELECT TO app_api
USING(school_id=app.school_id() AND app.can_invite_member(school_id,role_code,email::text));
GRANT SELECT ON school_invitations TO app_api;

CREATE FUNCTION app.platform_bootstrap_status(sid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE pending school_invitations; BEGIN
 IF NOT app.is_platform_staff() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT FROM schools WHERE id=sid AND administrator_onboarded_at IS NOT NULL)
 OR EXISTS(SELECT FROM school_memberships m JOIN roles r ON r.id=m.role_id
   WHERE m.school_id=sid AND r.code='school_admin' AND m.status IN ('ACTIVE','SUSPENDED'))
 THEN RETURN jsonb_build_object('state','assigned'); END IF;
 SELECT * INTO pending FROM school_invitations WHERE school_id=sid AND role_code='school_admin'
   AND status IN ('SENDING','SENT','READY','FAILED') ORDER BY created_at DESC LIMIT 1;
 RETURN jsonb_build_object('state',CASE WHEN pending.id IS NULL THEN 'missing' ELSE 'invited' END,
   'invitation_id',pending.id,'email',pending.email,'full_name',pending.full_name,'status',pending.status);
END $$;

CREATE FUNCTION app.begin_school_invitation(sid uuid,target text,person text,code text,resend boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item school_invitations; candidate uuid; confirmed boolean; claim uuid:=gen_random_uuid(); BEGIN
 target:=lower(trim(target));
 PERFORM pg_advisory_xact_lock(hashtextextended(sid::text||':memberships',0));
 IF NOT app.can_invite_member(sid,code,target) THEN RAISE EXCEPTION 'ONBOARDING_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
 IF code NOT IN ('school_admin','principal','teacher','parent','student') OR length(target)>254
 OR target !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' OR length(person) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'INVALID_INVITATION' USING ERRCODE='22023'; END IF;
 SELECT a.id,a.email_confirmed_at IS NOT NULL INTO candidate,confirmed FROM auth.users a
   JOIN users u ON u.id=a.id AND u.status='ACTIVE' WHERE lower(a.email)=target;
 IF EXISTS(SELECT FROM school_memberships WHERE school_id=sid AND user_id=candidate AND status IN ('ACTIVE','SUSPENDED'))
 THEN RAISE EXCEPTION 'MEMBERSHIP_EXISTS' USING ERRCODE='23505'; END IF;
 SELECT * INTO item FROM school_invitations WHERE school_id=sid AND email=target::citext FOR UPDATE;
 IF item.status='SENDING' AND item.send_started_at>now()-interval '2 minutes'
 THEN RAISE EXCEPTION 'INVITATION_IN_PROGRESS' USING ERRCODE='55P03'; END IF;
 IF NOT resend AND item.status IN ('SENT','READY') AND item.expires_at>now() THEN
   RETURN jsonb_build_object('id',item.id,'action','none','status',item.status);
 END IF;
 INSERT INTO school_invitations(school_id,email,full_name,role_code,user_id,invited_by,status,attempt_id)
 VALUES(sid,target,person,code,candidate,app.user_id(),'SENDING',claim)
 ON CONFLICT(school_id,email) DO UPDATE SET full_name=EXCLUDED.full_name,role_code=EXCLUDED.role_code,
   user_id=EXCLUDED.user_id,invited_by=EXCLUDED.invited_by,status='SENDING',attempt_id=claim,
   send_started_at=now(),expires_at=now()+interval '7 days',accepted_at=NULL
 RETURNING * INTO item;
 RETURN jsonb_build_object('id',item.id,'attempt_id',claim,'user_id',candidate,
   'action',CASE WHEN confirmed THEN 'link' ELSE 'send' END,'status','SENDING');
END $$;

CREATE FUNCTION app.finish_school_invitation(iid uuid,claim uuid,identity uuid,mailed boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item school_invitations; BEGIN
 SELECT * INTO item FROM school_invitations WHERE id=iid;
 IF item.id IS NULL OR item.attempt_id<>claim OR item.status<>'SENDING'
 THEN RAISE EXCEPTION 'INVITATION_CHANGED' USING ERRCODE='40001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(item.school_id::text||':memberships',0));
 SELECT * INTO item FROM school_invitations WHERE id=iid FOR UPDATE;
 IF item.attempt_id<>claim OR item.status<>'SENDING' THEN RAISE EXCEPTION 'INVITATION_CHANGED' USING ERRCODE='40001'; END IF;
 IF NOT app.can_invite_member(item.school_id,item.role_code,item.email::text)
 THEN RAISE EXCEPTION 'ONBOARDING_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM auth.users a JOIN users u ON u.id=a.id
   WHERE a.id=identity AND lower(a.email)=lower(item.email::text) AND u.status='ACTIVE')
 THEN RAISE EXCEPTION 'IDENTITY_MISMATCH' USING ERRCODE='42501'; END IF;
 INSERT INTO school_memberships(school_id,user_id,role_id,status,invited_by)
 SELECT item.school_id,identity,id,'INVITED',item.invited_by FROM roles WHERE code=item.role_code
 ON CONFLICT(school_id,user_id) DO UPDATE SET role_id=EXCLUDED.role_id,status='INVITED',invited_by=EXCLUDED.invited_by
 WHERE school_memberships.status IN ('INVITED','REMOVED');
 IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_EXISTS' USING ERRCODE='23505'; END IF;
 UPDATE school_invitations SET user_id=identity,status=CASE WHEN mailed THEN 'SENT' ELSE 'READY' END,
   sent_at=CASE WHEN mailed THEN now() ELSE NULL END WHERE id=iid RETURNING * INTO item;
 RETURN jsonb_build_object('id',item.id,'status',item.status,'email',item.email,'email_sent',mailed);
END $$;

CREATE FUNCTION app.fail_school_invitation(iid uuid,claim uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE school_invitations SET status='FAILED' WHERE id=iid AND attempt_id=claim AND status='SENDING'
   AND invited_by=app.user_id();
END $$;

CREATE FUNCTION app.pending_school_invitations() RETURNS TABLE(
 id uuid,school_id uuid,school_name text,role_code text,expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT i.id,i.school_id,s.name,i.role_code,i.expires_at FROM school_invitations i JOIN schools s ON s.id=i.school_id
 JOIN auth.users a ON a.id=i.user_id JOIN users u ON u.id=a.id
 WHERE i.user_id=app.user_id() AND a.email_confirmed_at IS NOT NULL AND u.status='ACTIVE'
   AND lower(a.email)=lower(i.email::text) AND i.status IN ('SENT','READY') AND i.expires_at>now()
   AND s.status<>'TERMINATED' ORDER BY i.created_at
$$;
CREATE FUNCTION app.respond_school_invitation(iid uuid,accept boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item school_invitations; BEGIN
 SELECT * INTO item FROM school_invitations WHERE id=iid;
 IF item.id IS NULL OR NOT EXISTS(SELECT FROM app.pending_school_invitations() p WHERE p.id=iid)
 THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(item.school_id::text||':memberships',0));
 SELECT * INTO item FROM school_invitations WHERE id=iid FOR UPDATE;
 IF NOT EXISTS(SELECT FROM app.pending_school_invitations() p WHERE p.id=iid)
 THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 UPDATE school_memberships SET status=CASE WHEN accept THEN 'ACTIVE' ELSE 'REMOVED' END
 WHERE school_id=item.school_id AND user_id=app.user_id() AND status='INVITED';
 IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_CHANGED' USING ERRCODE='40001'; END IF;
 UPDATE school_invitations SET status=CASE WHEN accept THEN 'ACCEPTED' ELSE 'REVOKED' END,
 accepted_at=CASE WHEN accept THEN now() ELSE NULL END WHERE id=iid;
 IF accept AND item.role_code='school_admin' THEN
   UPDATE schools SET administrator_onboarded_at=coalesce(administrator_onboarded_at,now()) WHERE id=item.school_id;
 END IF;
 RETURN jsonb_build_object('school_id',item.school_id,'accepted',accept,'role',item.role_code);
END $$;
CREATE FUNCTION app.cancel_school_invitation(iid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item school_invitations; BEGIN
 SELECT * INTO item FROM school_invitations WHERE id=iid;
 IF item.id IS NULL OR NOT app.can_invite_member(item.school_id,item.role_code,item.email::text)
 THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(item.school_id::text||':memberships',0));
 SELECT * INTO item FROM school_invitations WHERE id=iid FOR UPDATE;
 IF item.status='ACCEPTED' THEN RAISE EXCEPTION 'MEMBERSHIP_EXISTS' USING ERRCODE='23505'; END IF;
 UPDATE school_invitations SET status='REVOKED',attempt_id=gen_random_uuid() WHERE id=iid;
 UPDATE school_memberships SET status='REMOVED' WHERE school_id=item.school_id AND user_id=item.user_id AND status='INVITED';
END $$;

REVOKE ALL ON FUNCTION app.can_invite_member(uuid,text,text),app.platform_bootstrap_status(uuid),
 app.begin_school_invitation(uuid,text,text,text,boolean),app.finish_school_invitation(uuid,uuid,uuid,boolean),
 app.fail_school_invitation(uuid,uuid),app.pending_school_invitations(),app.respond_school_invitation(uuid,boolean),
 app.cancel_school_invitation(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.can_invite_member(uuid,text,text),
 app.begin_school_invitation(uuid,text,text,text,boolean),app.finish_school_invitation(uuid,uuid,uuid,boolean),
 app.fail_school_invitation(uuid,uuid),app.cancel_school_invitation(uuid) TO app_api,app_platform;
GRANT EXECUTE ON FUNCTION app.platform_bootstrap_status(uuid) TO app_platform;
GRANT EXECUTE ON FUNCTION app.pending_school_invitations(),app.respond_school_invitation(uuid,boolean) TO app_api;

CREATE FUNCTION app.protect_last_school_admin() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.status='ACTIVE' AND EXISTS(SELECT FROM roles WHERE id=OLD.role_id AND code='school_admin')
 AND (TG_OP='DELETE' OR NEW.status<>'ACTIVE' OR NEW.role_id<>OLD.role_id) THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(OLD.school_id::text||':memberships',0));
   IF NOT EXISTS(SELECT FROM school_memberships m JOIN roles r ON r.id=m.role_id
     WHERE m.school_id=OLD.school_id AND m.id<>OLD.id AND m.status='ACTIVE' AND r.code='school_admin')
   THEN RAISE EXCEPTION 'LAST_SCHOOL_ADMIN' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION app.protect_last_school_admin() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER protect_last_admin BEFORE UPDATE OR DELETE ON school_memberships
FOR EACH ROW EXECUTE FUNCTION app.protect_last_school_admin();
