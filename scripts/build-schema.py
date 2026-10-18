"""Generate the reviewed initial SQL migration. Runtime never uses this generator."""
from pathlib import Path
root=Path(__file__).resolve().parents[1]
out=[]
def sql(x):out.append(x.strip()+'\n')
sql('''-- Vidyalayaa SAS v1.0. Run as migration owner, never as an application role.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_api') THEN CREATE ROLE app_api NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_device') THEN CREATE ROLE app_device NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_worker') THEN CREATE ROLE app_worker NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_platform') THEN CREATE ROLE app_platform NOLOGIN NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public,app TO app_api,app_device,app_worker,app_platform;
CREATE FUNCTION app.school_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.school_id',true),'')::uuid $$;
CREATE FUNCTION app.user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.school_id(),app.user_id() TO app_api,app_device,app_worker,app_platform;
CREATE TABLE organizations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE schools(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_code text NOT NULL UNIQUE,name text NOT NULL,timezone text NOT NULL DEFAULT 'Asia/Kolkata',status text NOT NULL DEFAULT 'ONBOARDING' CHECK(status IN ('ONBOARDING','ACTIVE','SUSPENDED','TERMINATED')),organization_id uuid REFERENCES organizations(id),settings jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,email citext NOT NULL UNIQUE,full_name text NOT NULL,phone text,status text NOT NULL DEFAULT 'INVITED' CHECK(status IN ('INVITED','ACTIVE','DISABLED')),last_login_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE platform_staff(user_id uuid PRIMARY KEY REFERENCES users(id),platform_role text NOT NULL CHECK(platform_role IN ('SUPER_ADMIN','SUPPORT','BILLING')),mfa_required boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL UNIQUE,name text NOT NULL,description text);
CREATE TABLE permissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL UNIQUE,description text);
CREATE TABLE role_permissions(role_id uuid REFERENCES roles(id),permission_id uuid REFERENCES permissions(id),PRIMARY KEY(role_id,permission_id));
CREATE TABLE subscription_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL UNIQUE CHECK(code IN ('BASIC','PROFESSIONAL','ENTERPRISE')),name text NOT NULL,features jsonb NOT NULL,limits jsonb NOT NULL,is_active boolean NOT NULL DEFAULT true);
CREATE TABLE firmware_releases(version text PRIMARY KEY,channel text NOT NULL,sha256 text NOT NULL,signature text NOT NULL,size bigint NOT NULL CHECK(size>0),min_version text,security_version integer NOT NULL CHECK(security_version>=0),hardware_model text NOT NULL,storage_path text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());''')
tables={}
def table(name,cols,extras='',timestamps=True):
 tables[name]=True
 sql(f"CREATE TABLE {name}(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),{cols},"+("created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()," if timestamps else "")+f"UNIQUE(school_id,id){(','+extras) if extras else ''});")
def ref(col,target,required=True):return f'{col} uuid'+(' NOT NULL' if required else '')+f',FOREIGN KEY(school_id,{col}) REFERENCES {target}(school_id,id)'
table('school_memberships',"user_id uuid NOT NULL REFERENCES users(id),role_id uuid NOT NULL REFERENCES roles(id),status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('INVITED','ACTIVE','SUSPENDED','REMOVED')),invited_by uuid REFERENCES users(id)",'UNIQUE(school_id,user_id)')
table('support_access_grants',"staff_user_id uuid NOT NULL REFERENCES platform_staff(user_id),reason text NOT NULL,ticket_ref text NOT NULL,scope jsonb NOT NULL,approved_by uuid REFERENCES users(id),starts_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,CHECK(expires_at>starts_at AND expires_at<=starts_at+interval '24 hours')")
table('academic_sessions',"name text NOT NULL,starts_on date NOT NULL,ends_on date NOT NULL CHECK(ends_on>starts_on),is_current boolean NOT NULL DEFAULT false",'UNIQUE(school_id,name)')
table('teachers',"user_id uuid REFERENCES users(id),staff_code text NOT NULL,full_name text NOT NULL,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE'))",'UNIQUE(school_id,staff_code),UNIQUE(school_id,user_id)')
table('classes',ref('academic_session_id','academic_sessions')+",grade text NOT NULL,section text NOT NULL,"+ref('class_teacher_id','teachers',False),'UNIQUE(school_id,academic_session_id,grade,section),UNIQUE(school_id,id,academic_session_id)')
table('subjects',"code text NOT NULL,name text NOT NULL",'UNIQUE(school_id,code)')
table('students',"student_code text NOT NULL,user_id uuid REFERENCES users(id),first_name text NOT NULL,last_name text,date_of_birth date,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','TRANSFERRED','GRADUATED','WITHDRAWN'))",'UNIQUE(school_id,student_code),UNIQUE(school_id,user_id)')
table('enrollments',ref('student_id','students')+','+ref('class_id','classes')+','+ref('academic_session_id','academic_sessions')+",roll_number text,starts_on date NOT NULL,ends_on date,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ENDED')),CHECK(ends_on IS NULL OR ends_on>=starts_on),FOREIGN KEY(school_id,class_id,academic_session_id) REFERENCES classes(school_id,id,academic_session_id)")
table('parents',"user_id uuid REFERENCES users(id),full_name text NOT NULL,email citext,phone text,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE'))",'UNIQUE(school_id,user_id)')
table('student_parents',ref('student_id','students')+','+ref('parent_id','parents')+",relationship text NOT NULL CHECK(relationship IN ('MOTHER','FATHER','GUARDIAN','OTHER')),is_primary_contact boolean NOT NULL DEFAULT false,can_receive_alerts boolean NOT NULL DEFAULT true,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED'))",'UNIQUE(school_id,student_id,parent_id)')
table('teacher_class_assignments',ref('teacher_id','teachers')+','+ref('class_id','classes')+','+ref('subject_id','subjects',False)+',starts_on date NOT NULL,ends_on date,CHECK(ends_on IS NULL OR ends_on>=starts_on)','UNIQUE NULLS NOT DISTINCT(school_id,teacher_id,class_id,subject_id)')
table('exams',ref('class_id','classes')+",name text NOT NULL,exam_type text NOT NULL CHECK(exam_type IN ('UNIT','MIDTERM','FINAL','PRACTICAL')),starts_on date,max_score numeric(6,2) NOT NULL CHECK(max_score>0),status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','OPEN','LOCKED','PUBLISHED'))")
table('marks',ref('exam_id','exams')+','+ref('student_id','students')+','+ref('subject_id','subjects')+',score numeric(6,2) NOT NULL CHECK(score>=0),remarks text,entered_by uuid NOT NULL REFERENCES users(id)','UNIQUE(school_id,exam_id,student_id,subject_id)')
table('assignments',ref('class_id','classes')+','+ref('subject_id','subjects',False)+",kind text NOT NULL CHECK(kind IN ('HOMEWORK','MATERIAL')),title text NOT NULL,body text,due_at timestamptz,storage_path text,created_by uuid NOT NULL REFERENCES users(id)")
table('timetable_entries',ref('class_id','classes')+','+ref('subject_id','subjects')+','+ref('teacher_id','teachers')+',weekday smallint NOT NULL CHECK(weekday BETWEEN 1 AND 7),starts_at time NOT NULL,ends_at time NOT NULL CHECK(ends_at>starts_at),room text')
table('school_holidays',"on_date date NOT NULL,kind text NOT NULL CHECK(kind IN ('HOLIDAY','WEEKEND_OVERRIDE','EXAM_DAY','SHORT_DAY')),"+ref('class_id','classes',False)+',label text','UNIQUE NULLS NOT DISTINCT(school_id,on_date,kind,class_id)')
table('nfc_cards',"card_uid text NOT NULL CHECK(card_uid ~ '^[0-9A-F]{8,32}$'),"+ref('student_id','students')+",status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','BLOCKED','LOST','RETIRED')),issued_at timestamptz NOT NULL DEFAULT now(),blocked_at timestamptz,blocked_reason text,issued_by uuid NOT NULL REFERENCES users(id)")
table('device_locations',"name text NOT NULL,location_type text NOT NULL CHECK(location_type IN ('ENTRY','EXIT','BIDIRECTIONAL','CLASSROOM')),"+ref('class_id','classes',False)+',campus_label text,is_active boolean NOT NULL DEFAULT true',"UNIQUE(school_id,name),CHECK(location_type<>'CLASSROOM' OR class_id IS NOT NULL)")
table('devices',"device_code text NOT NULL UNIQUE,name text NOT NULL,hardware_serial text UNIQUE,"+ref('location_id','device_locations',False)+",status text NOT NULL DEFAULT 'PROVISIONED' CHECK(status IN ('PROVISIONED','ACTIVE','DISABLED','REVOKED')),claim_code_hash bytea,firmware_version text,config_version integer NOT NULL DEFAULT 1 CHECK(config_version>0),last_seen_at timestamptz,last_sync_at timestamptz,pending_event_count integer NOT NULL DEFAULT 0 CHECK(pending_event_count>=0),reader_status text NOT NULL DEFAULT 'UNKNOWN' CHECK(reader_status IN ('OK','DEGRADED','FAIL','UNKNOWN')),rtc_status text NOT NULL DEFAULT 'UNKNOWN' CHECK(rtc_status IN ('OK','DRIFT','LOST_POWER','UNKNOWN')),wifi_rssi_dbm smallint,storage_used_pct smallint CHECK(storage_used_pct BETWEEN 0 AND 100),revoked_at timestamptz,revoked_reason text,last_purged_sequence bigint NOT NULL DEFAULT 0,config jsonb NOT NULL DEFAULT '{}' ")
table('device_credentials',ref('device_id','devices')+",secret_hash bytea NOT NULL UNIQUE,status text NOT NULL CHECK(status IN ('ACTIVE','ROTATING_OUT','REVOKED')),expires_at timestamptz,last_used_at timestamptz")
table('device_configurations',ref('device_id','devices',False)+',version integer NOT NULL,config jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id)','UNIQUE NULLS NOT DISTINCT(school_id,device_id,version)')
table('device_heartbeats',ref('device_id','devices')+",received_at timestamptz NOT NULL DEFAULT now(),device_time timestamptz NOT NULL,skew_ms bigint NOT NULL,boot_id uuid NOT NULL,uptime_ms bigint NOT NULL,firmware_version text NOT NULL,pending_events integer NOT NULL,storage_used_pct smallint NOT NULL CHECK(storage_used_pct BETWEEN 0 AND 100),wifi_rssi_dbm smallint,reader_status text NOT NULL,rtc_status text NOT NULL,boot_reference_time timestamptz NOT NULL")
table('device_logs',ref('device_id','devices')+",device_ts timestamptz,received_at timestamptz NOT NULL DEFAULT now(),level text NOT NULL CHECK(level IN ('INFO','WARN','ERROR')),code text NOT NULL,detail jsonb")
table('device_ota_status',ref('device_id','devices')+",target_version text NOT NULL REFERENCES firmware_releases(version),state text NOT NULL CHECK(state IN ('OFFERED','DOWNLOADING','VERIFYING','INSTALLED','FAILED','ROLLED_BACK')),detail jsonb NOT NULL DEFAULT '{}'",'UNIQUE(school_id,device_id,target_version)')
table('attendance_rule_versions',ref('class_id','classes',False)+",day_type text NOT NULL CHECK(day_type IN ('REGULAR','EXAM','SHORT_DAY')),version_no integer NOT NULL,effective_from date NOT NULL,effective_to date,rules jsonb NOT NULL CHECK(rules ?& ARRAY['arrival','departure','weekly_off','absent_cutoff']),created_by uuid NOT NULL REFERENCES users(id),CHECK(effective_to IS NULL OR effective_to>effective_from)","EXCLUDE USING gist(school_id WITH =,(coalesce(class_id,'00000000-0000-0000-0000-000000000000'::uuid)) WITH =,day_type WITH =,daterange(effective_from,effective_to,'[)') WITH &&)")
table('attendance_events',ref('device_id','devices')+',device_event_id uuid NOT NULL,sequence_number bigint NOT NULL CHECK(sequence_number>0),boot_id uuid NOT NULL,card_uid text NOT NULL,'+ref('nfc_card_id','nfc_cards',False)+','+ref('student_id','students',False)+','+ref('location_id','device_locations',False)+",location_type text NOT NULL CHECK(location_type IN ('ENTRY','EXIT','BIDIRECTIONAL','CLASSROOM')),event_ts timestamptz NOT NULL,effective_ts timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),time_source text NOT NULL CHECK(time_source IN ('RTC_SYNCED','RTC_UNSYNCED','NTP','MONOTONIC','UNKNOWN')),timestamp_trust text NOT NULL CHECK(timestamp_trust IN ('TRUSTED','RECONSTRUCTED','SUSPECT')),uptime_ms bigint,firmware_version text NOT NULL,status text NOT NULL DEFAULT 'PROCESSING' CHECK(status IN ('PROCESSING','RECORDED','REJECTED')),outcome text,applied_to_daily boolean NOT NULL DEFAULT false,result jsonb,processed_at timestamptz",'UNIQUE(device_id,device_event_id),UNIQUE(device_id,sequence_number)')
table('daily_attendance',ref('student_id','students')+',attendance_date date NOT NULL,'+ref('class_id','classes')+','+ref('academic_session_id','academic_sessions')+",attendance_status text NOT NULL DEFAULT 'PENDING' CHECK(attendance_status IN ('PENDING','PRESENT','LATE','HALF_DAY','ABSENT','EXCUSED')),movement_status text NOT NULL DEFAULT 'NOT_ARRIVED' CHECK(movement_status IN ('NOT_ARRIVED','ARRIVED','LEFT')),arrival_classification text CHECK(arrival_classification IN ('ON_TIME','LATE','AFTER_CUTOFF')),departure_classification text CHECK(departure_classification IN ('NORMAL','HALF_DAY','EARLY')),"+ref('first_arrival_event_id','attendance_events',False)+',first_arrival_at timestamptz,'+ref('last_departure_event_id','attendance_events',False)+',last_departure_at timestamptz,'+ref('rule_version_id','attendance_rule_versions',False)+",needs_review boolean NOT NULL DEFAULT false,source text NOT NULL DEFAULT 'NFC' CHECK(source IN ('NFC','MANUAL','SYSTEM')),version integer NOT NULL DEFAULT 0,manual_override boolean NOT NULL DEFAULT false,provisional boolean NOT NULL DEFAULT false,last_applied_event_ts timestamptz,departure_count integer NOT NULL DEFAULT 0",'UNIQUE(school_id,student_id,attendance_date)')
table('attendance_corrections',ref('daily_attendance_id','daily_attendance')+",requested_status text NOT NULL CHECK(requested_status IN ('PENDING','PRESENT','LATE','HALF_DAY','ABSENT','EXCUSED')),reason text NOT NULL,status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','APPROVED','REJECTED','APPLIED','CANCELLED')),requested_by uuid NOT NULL REFERENCES users(id),approved_by uuid REFERENCES users(id),decided_at timestamptz,applied_at timestamptz,requested_at timestamptz NOT NULL DEFAULT now(),CHECK(approved_by IS NULL OR approved_by<>requested_by)")
table('notification_outbox',"kind text NOT NULL,"+ref('student_id','students',False)+',dedupe_key text NOT NULL,payload jsonb NOT NULL,'+ref('source_event_id','attendance_events',False)+",status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','DEAD')),attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),locked_until timestamptz,lease_token uuid,completed_at timestamptz,last_error text",'UNIQUE(school_id,dedupe_key)')
table('notification_deliveries',ref('outbox_id','notification_outbox')+','+ref('parent_id','parents',False)+",channel text NOT NULL CHECK(channel IN ('PUSH','EMAIL','SMS')),address_hash text,status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENT','FAILED','SUPPRESSED','EXPIRED_STALE','DEAD')),attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz,provider_message_id text,last_error text,sent_at timestamptz",'UNIQUE NULLS NOT DISTINCT(school_id,outbox_id,parent_id,channel)')
table('notification_attempts',ref('delivery_id','notification_deliveries')+',attempt integer NOT NULL,status text NOT NULL,provider_message_id text,error_code text,attempted_at timestamptz NOT NULL DEFAULT now()','UNIQUE(school_id,delivery_id,attempt)')
table('notification_preferences',ref('parent_id','parents')+",kind text NOT NULL,channel text NOT NULL CHECK(channel IN ('PUSH','EMAIL','SMS')),enabled boolean NOT NULL,quiet_start time,quiet_end time",'UNIQUE(school_id,parent_id,kind,channel)')
table('push_tokens',"user_id uuid NOT NULL REFERENCES users(id),token_hash text NOT NULL UNIQUE,token_encrypted text NOT NULL,platform text NOT NULL CHECK(platform IN ('WEB','ANDROID','IOS')),last_seen_at timestamptz NOT NULL DEFAULT now(),is_active boolean NOT NULL DEFAULT true")
table('announcements',"audience text NOT NULL CHECK(audience IN ('SCHOOL','CLASS','PARENTS','STAFF')),"+ref('class_id','classes',False)+",title text NOT NULL,body text NOT NULL,published_at timestamptz,created_by uuid NOT NULL REFERENCES users(id),CHECK(audience<>'CLASS' OR class_id IS NOT NULL)")
table('fee_records',ref('student_id','students')+','+ref('academic_session_id','academic_sessions')+",fee_type text NOT NULL,amount_due numeric(12,2) NOT NULL CHECK(amount_due>=0),amount_paid numeric(12,2) NOT NULL DEFAULT 0 CHECK(amount_paid>=0 AND amount_paid<=amount_due),currency char(3) NOT NULL DEFAULT 'INR',due_on date NOT NULL,status text NOT NULL CHECK(status IN ('UNPAID','PARTIAL','PAID','WAIVED')),CHECK((status='PAID' AND amount_paid=amount_due) OR (status='PARTIAL' AND amount_paid>0 AND amount_paid<amount_due) OR (status='UNPAID' AND amount_paid=0) OR status='WAIVED')")
table('subscriptions',"plan_id uuid NOT NULL REFERENCES subscription_plans(id),status text NOT NULL CHECK(status IN ('TRIALING','ACTIVE','PAST_DUE','SUSPENDED_READONLY','SUSPENDED','CANCELLED','EXPIRED')),current_period_end timestamptz NOT NULL,grace_ends_at timestamptz,limit_overrides jsonb,billing_ref text")
table('subscription_events',ref('subscription_id','subscriptions')+',previous_status text,new_status text NOT NULL,reason text NOT NULL,actor_id uuid REFERENCES users(id)')
table('api_idempotency_keys',"user_id uuid NOT NULL REFERENCES users(id),key text NOT NULL,request_hash text NOT NULL,response jsonb,expires_at timestamptz NOT NULL",'UNIQUE(school_id,user_id,key)')
table('report_documents',"kind text NOT NULL CHECK(kind IN ('ATTENDANCE','ACADEMIC','FEES')),"+ref('student_id','students',False)+','+ref('class_id','classes',False)+",storage_path text,status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),requested_by uuid NOT NULL REFERENCES users(id),parameters jsonb NOT NULL,locked_until timestamptz,lease_token uuid,error_code text")
table('job_runs',"job_name text NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,status text NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED')),detail jsonb")
sql('''CREATE TABLE audit_logs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,school_id uuid REFERENCES schools(id),occurred_at timestamptz NOT NULL DEFAULT now(),actor_type text NOT NULL CHECK(actor_type IN ('USER','DEVICE','SYSTEM','SUPPORT')),actor_id uuid,support_grant_id uuid REFERENCES support_access_grants(id),action text NOT NULL,entity_type text NOT NULL,entity_id uuid,before jsonb,after jsonb,request_id text,ip inet,user_agent text);
CREATE TABLE billing_webhook_events(id text PRIMARY KEY,request_hash text NOT NULL,received_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX membership_login ON school_memberships(user_id,status);
CREATE UNIQUE INDEX one_current_session ON academic_sessions(school_id) WHERE is_current;
CREATE UNIQUE INDEX active_enrollment ON enrollments(school_id,student_id,academic_session_id) WHERE status='ACTIVE';
CREATE UNIQUE INDEX one_active_card ON nfc_cards(school_id,student_id) WHERE status='ACTIVE';
CREATE UNIQUE INDEX card_uid_lookup ON nfc_cards(school_id,card_uid) WHERE status<>'RETIRED';
CREATE UNIQUE INDEX one_current_subscription ON subscriptions(school_id) WHERE status NOT IN ('CANCELLED','EXPIRED');
CREATE INDEX roster_lookup ON enrollments(school_id,class_id,status);
CREATE INDEX student_search ON students(school_id,last_name,first_name);
CREATE INDEX parent_scope ON student_parents(school_id,parent_id,status);
CREATE INDEX parent_fanout ON student_parents(school_id,student_id,status);
CREATE INDEX teacher_scope ON teacher_class_assignments(school_id,teacher_id,starts_on,ends_on);
CREATE INDEX event_replay ON attendance_events(school_id,student_id,effective_ts,device_id,sequence_number);
CREATE INDEX day_roster ON daily_attendance(school_id,attendance_date,class_id);
CREATE INDEX rule_lookup ON attendance_rule_versions(school_id,day_type,effective_from DESC);
CREATE INDEX offline_watchdog ON devices(last_seen_at) WHERE status='ACTIVE';
CREATE INDEX device_boot_reference ON device_heartbeats(school_id,device_id,boot_id,received_at DESC);
CREATE INDEX device_log_history ON device_logs(school_id,device_id,received_at DESC);
CREATE INDEX outbox_claim ON notification_outbox(next_attempt_at) WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX delivery_history ON notification_deliveries(school_id,parent_id,created_at DESC);
CREATE INDEX correction_queue ON attendance_corrections(school_id,status,requested_at);
CREATE INDEX marks_report ON marks(school_id,student_id,exam_id);
CREATE INDEX notices_feed ON announcements(school_id,published_at DESC);
CREATE INDEX fee_collection ON fee_records(school_id,status,due_on);
CREATE INDEX audit_school ON audit_logs(school_id,occurred_at DESC);
CREATE INDEX report_claim ON report_documents(status,created_at);
CREATE FUNCTION app.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
CREATE FUNCTION app.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b jsonb; a jsonb; sid uuid; eid uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN b=to_jsonb(OLD)-ARRAY['card_uid','secret_hash','claim_code_hash','token_encrypted']; END IF;
 IF TG_OP<>'DELETE' THEN a=to_jsonb(NEW)-ARRAY['card_uid','secret_hash','claim_code_hash','token_encrypted']; END IF;
 sid=coalesce((a->>'school_id')::uuid,(b->>'school_id')::uuid); eid=coalesce((a->>'id')::uuid,(b->>'id')::uuid);
 INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,before,after,request_id)
 VALUES(sid,coalesce(nullif(current_setting('app.actor_type',true),''),'SYSTEM'),app.user_id(),lower(TG_TABLE_NAME||'.'||TG_OP),TG_TABLE_NAME,eid,b,a,nullif(current_setting('app.request_id',true),''));
 RETURN coalesce(NEW,OLD);
END $$;
CREATE FUNCTION app.guard_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['updated_at','student_id','nfc_card_id','effective_ts','timestamp_trust','status','outcome','applied_to_daily','result','processed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','student_id','nfc_card_id','effective_ts','timestamp_trust','status','outcome','applied_to_daily','result','processed_at']) THEN RAISE EXCEPTION 'Raw event fields are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_event BEFORE UPDATE ON attendance_events FOR EACH ROW EXECUTE FUNCTION app.guard_event();
CREATE FUNCTION app.guard_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['effective_to','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['effective_to','updated_at']) THEN RAISE EXCEPTION 'Rule versions are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_rules BEFORE UPDATE ON attendance_rule_versions FOR EACH ROW EXECUTE FUNCTION app.guard_rule();
CREATE FUNCTION app.auth_context(uid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',u.id,'full_name',u.full_name,'email',u.email,'platform_role',(SELECT platform_role FROM platform_staff WHERE user_id=u.id),'memberships',coalesce((SELECT jsonb_agg(jsonb_build_object('school_id',m.school_id,'school_name',s.name,'timezone',s.timezone,'role',r.code,'permissions',coalesce((SELECT jsonb_agg(p.code) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id),'[]'::jsonb))) FROM school_memberships m JOIN roles r ON r.id=m.role_id JOIN schools s ON s.id=m.school_id WHERE m.user_id=u.id AND m.status='ACTIVE' AND s.status<>'TERMINATED'),'[]'::jsonb)) FROM users u WHERE u.id=uid AND u.status='ACTIVE'
$$;
CREATE FUNCTION app.device_auth(code text) RETURNS TABLE(id uuid,school_id uuid,status text,secret_hash bytea,expires_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT d.id,d.school_id,d.status,c.secret_hash,c.expires_at FROM devices d JOIN device_credentials c ON c.device_id=d.id AND c.school_id=d.school_id WHERE d.device_code=code AND c.status IN ('ACTIVE','ROTATING_OUT') AND (c.expires_at IS NULL OR c.expires_at>now())
$$;
CREATE FUNCTION app.is_platform_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT EXISTS(SELECT FROM platform_staff WHERE user_id=app.user_id() AND platform_role='SUPER_ADMIN') $$;
CREATE FUNCTION app.worker_schools() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT id FROM schools WHERE status<>'TERMINATED' $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.school_id(),app.user_id() TO app_api,app_device,app_worker,app_platform;
GRANT EXECUTE ON FUNCTION app.auth_context(uuid) TO app_api;
GRANT EXECUTE ON FUNCTION app.device_auth(text) TO app_device;
GRANT EXECUTE ON FUNCTION app.is_platform_staff() TO app_platform,app_api;
GRANT EXECUTE ON FUNCTION app.worker_schools() TO app_worker;''')
for name in tables:
 sql(f'''ALTER TABLE {name} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {name} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON {name} TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX {name}_tenant ON {name}(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON {name} FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();''')
for name in ['school_memberships','student_parents','nfc_cards','devices','subscriptions','attendance_corrections','marks','fee_records','support_access_grants','attendance_rule_versions']:
 sql(f'CREATE TRIGGER audit AFTER INSERT OR UPDATE ON {name} FOR EACH ROW EXECUTE FUNCTION app.audit_change();')
sql('''ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_tenant ON audit_logs TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE POLICY audit_platform ON audit_logs TO app_platform USING(school_id IS NULL AND app.is_platform_staff()) WITH CHECK(school_id IS NULL AND app.is_platform_staff());
ALTER TABLE schools ENABLE ROW LEVEL SECURITY; ALTER TABLE schools FORCE ROW LEVEL SECURITY;
CREATE POLICY school_tenant ON schools TO app_api,app_device,app_worker USING(id=app.school_id()) WITH CHECK(id=app.school_id());
CREATE POLICY school_platform ON schools TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());
ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_self ON users TO app_api USING(id=app.user_id() OR EXISTS(SELECT FROM school_memberships m WHERE m.user_id=users.id AND m.school_id=app.school_id()));
GRANT SELECT ON users,roles,permissions,role_permissions,subscription_plans,schools TO app_api;
GRANT UPDATE(name,timezone,settings) ON schools TO app_api;
GRANT SELECT ON schools,subscription_plans TO app_device,app_worker;
GRANT SELECT,INSERT ON audit_logs TO app_api,app_device,app_worker,app_platform;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO app_api,app_device,app_worker,app_platform;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO app_api;
REVOKE ALL ON platform_staff,device_credentials,billing_webhook_events,firmware_releases,organizations FROM app_api;
REVOKE INSERT,UPDATE ON users,roles,permissions,role_permissions,subscription_plans,schools FROM app_api;
GRANT UPDATE(name,timezone,settings) ON schools TO app_api;
REVOKE UPDATE ON audit_logs FROM app_api;
GRANT SELECT,INSERT,UPDATE ON devices,device_heartbeats,device_logs,device_ota_status,attendance_events,daily_attendance,notification_outbox TO app_device;
GRANT SELECT ON device_locations,nfc_cards,students,enrollments,classes,attendance_rule_versions,school_holidays,attendance_corrections,device_configurations TO app_device;
GRANT SELECT ON firmware_releases TO app_device;
GRANT SELECT,INSERT,UPDATE ON daily_attendance,notification_outbox,notification_deliveries,notification_attempts,push_tokens,report_documents,job_runs,subscriptions,subscription_events,device_logs TO app_worker;
GRANT SELECT ON devices,device_locations,students,enrollments,classes,subjects,exams,marks,fee_records,parents,student_parents,notification_preferences,attendance_rule_versions,school_holidays,assignments,announcements,school_memberships,roles TO app_worker;
GRANT DELETE ON device_heartbeats,device_logs TO app_worker;
GRANT SELECT,INSERT,UPDATE ON schools,organizations,subscription_plans,subscriptions,subscription_events,devices,device_credentials,support_access_grants,firmware_releases,billing_webhook_events TO app_platform;
''')
for name in ['organizations','subscription_plans','firmware_releases','billing_webhook_events','roles','permissions','role_permissions','platform_staff']:
 sql(f'ALTER TABLE {name} ENABLE ROW LEVEL SECURITY; ALTER TABLE {name} FORCE ROW LEVEL SECURITY;')
 if name in ['subscription_plans','firmware_releases','roles','permissions','role_permissions']:
  sql(f'CREATE POLICY reference_read ON {name} FOR SELECT TO app_api,app_device,app_worker USING(true);')
 if name in ['organizations','subscription_plans','firmware_releases','billing_webhook_events']:
  sql(f'CREATE POLICY platform ON {name} TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());')
for name in ['subscriptions','subscription_events','devices','device_credentials','support_access_grants']:
 sql(f'CREATE POLICY platform ON {name} TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());')
sql('''-- No browser PostgREST privileges on application records, including via PUBLIC.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon,authenticated,PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon,authenticated,PUBLIC;
CREATE FUNCTION app.on_auth_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 INSERT INTO users(id,email,full_name,status) VALUES(NEW.id,NEW.email,coalesce(NEW.raw_user_meta_data->>'full_name',split_part(NEW.email,'@',1)),'ACTIVE') ON CONFLICT(id) DO NOTHING; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.on_auth_user() FROM PUBLIC;
CREATE TRIGGER auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION app.on_auth_user();
INSERT INTO storage.buckets(id,name,public) VALUES('school-documents','school-documents',false),('firmware','firmware',false) ON CONFLICT(id) DO NOTHING;
-- No anon/authenticated storage.objects policy is created. Only server-authorized signed operations.
''')
(root/'db/migrations').mkdir(parents=True,exist_ok=True)
(root/'db/migrations/202610170001_initial.sql').write_text('\n'.join(out),encoding='utf-8')
print(f'Generated {len(tables)} school-owned tables')
