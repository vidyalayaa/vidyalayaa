-- Defense in depth beyond the application service layer.
REVOKE INSERT,UPDATE ON subscriptions,subscription_events,notification_deliveries,notification_attempts,job_runs FROM app_api;
REVOKE UPDATE ON notification_attempts FROM app_worker;
GRANT SELECT ON roles,permissions,role_permissions TO app_worker;
GRANT SELECT ON users TO app_worker;
CREATE POLICY worker_user_contact ON users FOR SELECT TO app_worker USING(EXISTS(SELECT 1 FROM school_memberships m WHERE m.user_id=users.id AND m.school_id=app.school_id() AND m.status='ACTIVE'));
CREATE FUNCTION app.admin_contacts() RETURNS TABLE(user_id uuid,email text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT u.id,u.email::text FROM users u JOIN school_memberships m ON m.user_id=u.id JOIN roles r ON r.id=m.role_id WHERE m.school_id=app.school_id() AND m.status='ACTIVE' AND u.status='ACTIVE' AND r.code='school_admin'
$$;
REVOKE ALL ON FUNCTION app.admin_contacts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_contacts() TO app_worker;
-- Prevent parallel timetable creates from double-booking even outside the API.
ALTER TABLE timetable_entries ADD CONSTRAINT teacher_no_overlap EXCLUDE USING gist(school_id WITH =,teacher_id WITH =,weekday WITH =,int8range((extract(epoch FROM starts_at)*1000)::bigint,(extract(epoch FROM ends_at)*1000)::bigint,'[)') WITH &&);
ALTER TABLE timetable_entries ADD CONSTRAINT class_no_overlap EXCLUDE USING gist(school_id WITH =,class_id WITH =,weekday WITH =,int8range((extract(epoch FROM starts_at)*1000)::bigint,(extract(epoch FROM ends_at)*1000)::bigint,'[)') WITH &&);
-- Scope to the actor's own token; a guessed token hash cannot be reassigned.
CREATE FUNCTION app.guard_token_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.user_id<>NEW.user_id OR OLD.school_id<>NEW.school_id THEN RAISE EXCEPTION 'Token owner is immutable'; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_token_owner() FROM PUBLIC;
CREATE TRIGGER token_owner BEFORE UPDATE ON push_tokens FOR EACH ROW EXECUTE FUNCTION app.guard_token_owner();
-- Billing-provider-neutral signed event adapter; may mutate subscription metadata only.
CREATE FUNCTION app.apply_billing_event(event_id text,event_hash text,target_school uuid,new_state text,period_end timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE claimed text; old subscriptions; BEGIN
 IF new_state NOT IN ('ACTIVE','PAST_DUE','CANCELLED') OR period_end IS NULL THEN RAISE EXCEPTION 'Invalid billing event'; END IF;
 INSERT INTO billing_webhook_events(id,request_hash) VALUES(event_id,event_hash) ON CONFLICT DO NOTHING RETURNING id INTO claimed;
 IF claimed IS NULL THEN
  IF NOT EXISTS(SELECT FROM billing_webhook_events WHERE id=event_id AND request_hash=event_hash) THEN RAISE EXCEPTION 'Webhook id conflict'; END IF; RETURN false;
 END IF;
 SELECT * INTO old FROM subscriptions WHERE school_id=target_school ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
 IF old.id IS NULL THEN RAISE EXCEPTION 'Unknown subscription'; END IF;
 UPDATE subscriptions SET status=new_state,current_period_end=period_end,grace_ends_at=CASE WHEN new_state='PAST_DUE' THEN period_end+interval '15 days' ELSE NULL END WHERE id=old.id;
 INSERT INTO subscription_events(school_id,subscription_id,previous_status,new_status,reason) VALUES(target_school,old.id,old.status,new_state,'Signed billing adapter event');
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.apply_billing_event(text,text,uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_billing_event(text,text,uuid,text,timestamptz) TO app_platform;
