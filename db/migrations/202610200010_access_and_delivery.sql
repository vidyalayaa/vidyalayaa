-- Existing generated files have no proven authorization provenance and must be regenerated.
ALTER TABLE schools ADD COLUMN access_version bigint NOT NULL DEFAULT 1;
ALTER TABLE report_documents ADD COLUMN authorization_version bigint;
ALTER TABLE report_documents ADD COLUMN authorization_role text;
ALTER TABLE report_documents ADD COLUMN authorization_scope text;
-- Revision invalidates writes; a live scope fingerprint also detects dated assignment expiry.
CREATE FUNCTION app.report_scope_fingerprint(target_user uuid) RETURNS text LANGUAGE sql STABLE
SET search_path=pg_catalog,public AS $$
 SELECT md5(jsonb_build_object('version',s.access_version,'role',r.code,'member',m.id,'user_status',u.status,
  'teacher',coalesce((SELECT jsonb_agg(jsonb_build_array(ta.id,ta.class_id,ta.subject_id) ORDER BY ta.id)
   FROM teacher_class_assignments ta JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id
   JOIN classes c ON c.school_id=ta.school_id AND c.id=ta.class_id
   JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
   WHERE ta.school_id=s.id AND te.user_id=target_user AND te.status='ACTIVE' AND ac.is_current
    AND ta.starts_on<=(now() AT TIME ZONE s.timezone)::date AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE s.timezone)::date)),'[]'::jsonb))::text)
 FROM schools s JOIN school_memberships m ON m.school_id=s.id AND m.user_id=target_user
 JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id
 WHERE s.id=app.school_id() AND m.status='ACTIVE' AND u.status='ACTIVE';
$$;
REVOKE ALL ON FUNCTION app.report_scope_fingerprint(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.report_scope_fingerprint(uuid) TO app_api,app_worker;
GRANT SELECT ON academic_sessions,teachers,teacher_class_assignments TO app_worker;

CREATE FUNCTION app.bump_school_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE sid uuid;
BEGIN
 sid=CASE WHEN TG_OP='DELETE' THEN OLD.school_id ELSE NEW.school_id END;
 UPDATE schools SET access_version=access_version+1 WHERE id=sid;
 RETURN coalesce(NEW,OLD);
END $$;
REVOKE ALL ON FUNCTION app.bump_school_access() FROM PUBLIC,anon,authenticated;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['school_memberships','students','parents','teachers','student_parents',
  'teacher_class_assignments','enrollments','academic_sessions','exams'] LOOP
  EXECUTE format('CREATE TRIGGER access_revision AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.bump_school_access()',t);
 END LOOP;
END $$;
CREATE FUNCTION app.bump_user_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status THEN
  UPDATE schools SET access_version=access_version+1 WHERE id IN(SELECT school_id FROM school_memberships WHERE user_id=NEW.id);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.bump_user_access() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER access_revision AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION app.bump_user_access();

ALTER TABLE announcements ADD COLUMN publication_version integer NOT NULL DEFAULT 1;
CREATE FUNCTION app.version_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 NEW.publication_version=OLD.publication_version+1; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.version_publication() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER publication_version BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION app.version_publication();

-- A device endpoint may be subscribed to several schools by the same owner.
ALTER TABLE push_tokens DROP CONSTRAINT push_tokens_token_hash_key;
ALTER TABLE push_tokens ADD CONSTRAINT push_token_subscription UNIQUE(school_id,user_id,token_hash);
CREATE TABLE app.push_endpoint_owners(token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES public.users(id));
INSERT INTO app.push_endpoint_owners SELECT DISTINCT ON(token_hash) token_hash,user_id FROM push_tokens ORDER BY token_hash,last_seen_at DESC;
ALTER TABLE app.push_endpoint_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_endpoint_owners FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.push_endpoint_owners FROM PUBLIC,anon,authenticated,app_api,app_device,app_worker,app_platform;
CREATE FUNCTION app.register_push_endpoint(h text,encrypted text,device_platform text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE uid uuid:=app.user_id();sid uuid:=app.school_id();result uuid;
BEGIN
 IF h !~ '^[a-f0-9]{64}$' OR length(encrypted)>12000 OR device_platform NOT IN ('WEB','ANDROID','IOS') OR
 NOT EXISTS(SELECT FROM school_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id
 WHERE m.school_id=sid AND m.user_id=uid AND m.status='ACTIVE' AND u.status='ACTIVE' AND r.code='parent') THEN
  RAISE EXCEPTION 'Push registration denied' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('push:'||h,0));
 INSERT INTO app.push_endpoint_owners VALUES(h,uid) ON CONFLICT(token_hash) DO UPDATE SET user_id=EXCLUDED.user_id;
 UPDATE push_tokens SET is_active=false WHERE token_hash=h AND user_id<>uid;
 INSERT INTO push_tokens(school_id,user_id,token_hash,token_encrypted,platform) VALUES(sid,uid,h,encrypted,device_platform)
 ON CONFLICT(school_id,user_id,token_hash) DO UPDATE SET is_active=true,last_seen_at=now(),token_encrypted=EXCLUDED.token_encrypted
 RETURNING id INTO result;
 RETURN result;
END $$;
CREATE FUNCTION app.unregister_push_endpoint(h text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$ BEGIN
 UPDATE push_tokens SET is_active=false WHERE token_hash=h AND user_id=app.user_id();
END $$;
REVOKE ALL ON FUNCTION app.register_push_endpoint(text,text,text),app.unregister_push_endpoint(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.register_push_endpoint(text,text,text),app.unregister_push_endpoint(text) TO app_api;
REVOKE INSERT,UPDATE ON push_tokens FROM app_api;

-- Explicit recipient identity also makes staff delivery dedupe non-null and inspectable.
ALTER TABLE notification_deliveries ADD COLUMN recipient_user_id uuid REFERENCES users(id);
DO $$ DECLARE constraint_name text;BEGIN
 SELECT conname INTO constraint_name FROM pg_constraint WHERE conrelid='notification_deliveries'::regclass AND contype='u' AND pg_get_constraintdef(oid) LIKE '%outbox_id, parent_id, channel%';
 IF constraint_name IS NOT NULL THEN EXECUTE format('ALTER TABLE notification_deliveries DROP CONSTRAINT %I',constraint_name);END IF;
END $$;
CREATE UNIQUE INDEX delivery_parent_recipient ON notification_deliveries(school_id,outbox_id,parent_id,channel) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX delivery_staff_recipient ON notification_deliveries(school_id,outbox_id,recipient_user_id,channel) WHERE parent_id IS NULL;

-- PROVISIONED -> ACTIVE is a claim operation, never an ordinary metadata update.
CREATE FUNCTION app.guard_device_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='PROVISIONED' AND NEW.status='ACTIVE' AND
    (NEW.claim_code_hash IS NOT NULL OR current_setting('app.claim_verified',true) IS DISTINCT FROM 'true') THEN
  RAISE EXCEPTION 'CLAIM_REQUIRED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_device_claim() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER verified_claim BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION app.guard_device_claim();

-- Credential changes are security events. Never retain credential hashes in audit payloads.
CREATE FUNCTION app.audit_device_credential() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$ BEGIN
 INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after,request_id)
 VALUES(NEW.school_id,coalesce(nullif(current_setting('app.actor_type',true),''),'SYSTEM'),app.user_id(),
 'device.credential.'||lower(NEW.status),'devices',NEW.device_id,
 jsonb_build_object('status',NEW.status,'expires_at',NEW.expires_at,
  'reason',nullif(current_setting('app.change_reason',true),'')),nullif(current_setting('app.request_id',true),''));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.audit_device_credential() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER credential_audit AFTER INSERT OR UPDATE ON device_credentials FOR EACH ROW EXECUTE FUNCTION app.audit_device_credential();
