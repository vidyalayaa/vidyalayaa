-- Consent is enforced in PostgreSQL, including status detours through SUSPENDED/REMOVED.
CREATE FUNCTION app.guard_invitation_activation() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.status='ACTIVE' AND EXISTS(SELECT FROM school_invitations i
   WHERE i.school_id=NEW.school_id AND i.user_id=NEW.user_id AND i.status<>'ACCEPTED')
 THEN RAISE EXCEPTION 'INVITATION_PENDING' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.cancel_school_invitation(iid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item school_invitations; BEGIN
 SELECT * INTO item FROM school_invitations WHERE id=iid;
 IF item.id IS NULL THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(item.school_id::text||':memberships',0));
 SELECT * INTO item FROM school_invitations WHERE id=iid FOR UPDATE;
 IF NOT app.can_invite_member(item.school_id,item.role_code,item.email::text)
 THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF item.status='ACCEPTED' THEN RAISE EXCEPTION 'MEMBERSHIP_EXISTS' USING ERRCODE='23505'; END IF;
 UPDATE school_invitations SET status='REVOKED',attempt_id=gen_random_uuid() WHERE id=iid;
 UPDATE school_memberships SET status='REMOVED' WHERE school_id=item.school_id AND user_id=item.user_id AND status='INVITED';
END $$;
REVOKE ALL ON FUNCTION app.guard_invitation_activation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER invitation_activation BEFORE INSERT OR UPDATE ON school_memberships
FOR EACH ROW EXECUTE FUNCTION app.guard_invitation_activation();

CREATE OR REPLACE FUNCTION app.respond_school_invitation(iid uuid,accept boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item school_invitations; BEGIN
 SELECT * INTO item FROM school_invitations WHERE id=iid;
 IF item.id IS NULL OR NOT EXISTS(SELECT FROM app.pending_school_invitations() p WHERE p.id=iid)
 THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(item.school_id::text||':memberships',0));
 SELECT * INTO item FROM school_invitations WHERE id=iid FOR UPDATE;
 IF NOT EXISTS(SELECT FROM app.pending_school_invitations() p WHERE p.id=iid)
 THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 UPDATE school_invitations SET status=CASE WHEN accept THEN 'ACCEPTED' ELSE 'REVOKED' END,
 accepted_at=CASE WHEN accept THEN now() ELSE NULL END WHERE id=iid;
 UPDATE school_memberships SET status=CASE WHEN accept THEN 'ACTIVE' ELSE 'REMOVED' END
 WHERE school_id=item.school_id AND user_id=app.user_id() AND status='INVITED';
 IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_CHANGED' USING ERRCODE='40001'; END IF;
 IF accept AND item.role_code='school_admin' THEN
   UPDATE schools SET administrator_onboarded_at=coalesce(administrator_onboarded_at,now()) WHERE id=item.school_id;
 END IF;
 RETURN jsonb_build_object('school_id',item.school_id,'accepted',accept,'role',item.role_code);
END $$;
