-- Vidyalayaa SAS v1.0. Run as migration owner, never as an application role.
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
CREATE TABLE firmware_releases(version text PRIMARY KEY,channel text NOT NULL,sha256 text NOT NULL,signature text NOT NULL,size bigint NOT NULL CHECK(size>0),min_version text,security_version integer NOT NULL CHECK(security_version>=0),hardware_model text NOT NULL,storage_path text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE school_memberships(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),user_id uuid NOT NULL REFERENCES users(id),role_id uuid NOT NULL REFERENCES roles(id),status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('INVITED','ACTIVE','SUSPENDED','REMOVED')),invited_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,user_id));

CREATE TABLE support_access_grants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),staff_user_id uuid NOT NULL REFERENCES platform_staff(user_id),reason text NOT NULL,ticket_ref text NOT NULL,scope jsonb NOT NULL,approved_by uuid REFERENCES users(id),starts_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,CHECK(expires_at>starts_at AND expires_at<=starts_at+interval '24 hours'),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE academic_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),name text NOT NULL,starts_on date NOT NULL,ends_on date NOT NULL CHECK(ends_on>starts_on),is_current boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,name));

CREATE TABLE teachers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),user_id uuid REFERENCES users(id),staff_code text NOT NULL,full_name text NOT NULL,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,staff_code),UNIQUE(school_id,user_id));

CREATE TABLE classes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),academic_session_id uuid NOT NULL,FOREIGN KEY(school_id,academic_session_id) REFERENCES academic_sessions(school_id,id),grade text NOT NULL,section text NOT NULL,class_teacher_id uuid,FOREIGN KEY(school_id,class_teacher_id) REFERENCES teachers(school_id,id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,academic_session_id,grade,section),UNIQUE(school_id,id,academic_session_id));

CREATE TABLE subjects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),code text NOT NULL,name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,code));

CREATE TABLE students(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),student_code text NOT NULL,user_id uuid REFERENCES users(id),first_name text NOT NULL,last_name text,date_of_birth date,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','TRANSFERRED','GRADUATED','WITHDRAWN')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,student_code),UNIQUE(school_id,user_id));

CREATE TABLE enrollments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),student_id uuid NOT NULL,FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),class_id uuid NOT NULL,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),academic_session_id uuid NOT NULL,FOREIGN KEY(school_id,academic_session_id) REFERENCES academic_sessions(school_id,id),roll_number text,starts_on date NOT NULL,ends_on date,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ENDED')),CHECK(ends_on IS NULL OR ends_on>=starts_on),FOREIGN KEY(school_id,class_id,academic_session_id) REFERENCES classes(school_id,id,academic_session_id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE parents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),user_id uuid REFERENCES users(id),full_name text NOT NULL,email citext,phone text,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,user_id));

CREATE TABLE student_parents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),student_id uuid NOT NULL,FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),parent_id uuid NOT NULL,FOREIGN KEY(school_id,parent_id) REFERENCES parents(school_id,id),relationship text NOT NULL CHECK(relationship IN ('MOTHER','FATHER','GUARDIAN','OTHER')),is_primary_contact boolean NOT NULL DEFAULT false,can_receive_alerts boolean NOT NULL DEFAULT true,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,student_id,parent_id));

CREATE TABLE teacher_class_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),teacher_id uuid NOT NULL,FOREIGN KEY(school_id,teacher_id) REFERENCES teachers(school_id,id),class_id uuid NOT NULL,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),subject_id uuid,FOREIGN KEY(school_id,subject_id) REFERENCES subjects(school_id,id),starts_on date NOT NULL,ends_on date,CHECK(ends_on IS NULL OR ends_on>=starts_on),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE NULLS NOT DISTINCT(school_id,teacher_id,class_id,subject_id));

CREATE TABLE exams(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),class_id uuid NOT NULL,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),name text NOT NULL,exam_type text NOT NULL CHECK(exam_type IN ('UNIT','MIDTERM','FINAL','PRACTICAL')),starts_on date,max_score numeric(6,2) NOT NULL CHECK(max_score>0),status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','OPEN','LOCKED','PUBLISHED')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE marks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),exam_id uuid NOT NULL,FOREIGN KEY(school_id,exam_id) REFERENCES exams(school_id,id),student_id uuid NOT NULL,FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),subject_id uuid NOT NULL,FOREIGN KEY(school_id,subject_id) REFERENCES subjects(school_id,id),score numeric(6,2) NOT NULL CHECK(score>=0),remarks text,entered_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,exam_id,student_id,subject_id));

CREATE TABLE assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),class_id uuid NOT NULL,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),subject_id uuid,FOREIGN KEY(school_id,subject_id) REFERENCES subjects(school_id,id),kind text NOT NULL CHECK(kind IN ('HOMEWORK','MATERIAL')),title text NOT NULL,body text,due_at timestamptz,storage_path text,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE timetable_entries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),class_id uuid NOT NULL,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),subject_id uuid NOT NULL,FOREIGN KEY(school_id,subject_id) REFERENCES subjects(school_id,id),teacher_id uuid NOT NULL,FOREIGN KEY(school_id,teacher_id) REFERENCES teachers(school_id,id),weekday smallint NOT NULL CHECK(weekday BETWEEN 1 AND 7),starts_at time NOT NULL,ends_at time NOT NULL CHECK(ends_at>starts_at),room text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE school_holidays(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),on_date date NOT NULL,kind text NOT NULL CHECK(kind IN ('HOLIDAY','WEEKEND_OVERRIDE','EXAM_DAY','SHORT_DAY')),class_id uuid,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),label text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE NULLS NOT DISTINCT(school_id,on_date,kind,class_id));

CREATE TABLE nfc_cards(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),card_uid text NOT NULL CHECK(card_uid ~ '^[0-9A-F]{8,32}$'),student_id uuid NOT NULL,FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','BLOCKED','LOST','RETIRED')),issued_at timestamptz NOT NULL DEFAULT now(),blocked_at timestamptz,blocked_reason text,issued_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE device_locations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),name text NOT NULL,location_type text NOT NULL CHECK(location_type IN ('ENTRY','EXIT','BIDIRECTIONAL','CLASSROOM')),class_id uuid,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),campus_label text,is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,name),CHECK(location_type<>'CLASSROOM' OR class_id IS NOT NULL));

CREATE TABLE devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),device_code text NOT NULL UNIQUE,name text NOT NULL,hardware_serial text UNIQUE,location_id uuid,FOREIGN KEY(school_id,location_id) REFERENCES device_locations(school_id,id),status text NOT NULL DEFAULT 'PROVISIONED' CHECK(status IN ('PROVISIONED','ACTIVE','DISABLED','REVOKED')),claim_code_hash bytea,firmware_version text,config_version integer NOT NULL DEFAULT 1 CHECK(config_version>0),last_seen_at timestamptz,last_sync_at timestamptz,pending_event_count integer NOT NULL DEFAULT 0 CHECK(pending_event_count>=0),reader_status text NOT NULL DEFAULT 'UNKNOWN' CHECK(reader_status IN ('OK','DEGRADED','FAIL','UNKNOWN')),rtc_status text NOT NULL DEFAULT 'UNKNOWN' CHECK(rtc_status IN ('OK','DRIFT','LOST_POWER','UNKNOWN')),wifi_rssi_dbm smallint,storage_used_pct smallint CHECK(storage_used_pct BETWEEN 0 AND 100),revoked_at timestamptz,revoked_reason text,last_purged_sequence bigint NOT NULL DEFAULT 0,config jsonb NOT NULL DEFAULT '{}' ,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE device_credentials(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),device_id uuid NOT NULL,FOREIGN KEY(school_id,device_id) REFERENCES devices(school_id,id),secret_hash bytea NOT NULL UNIQUE,status text NOT NULL CHECK(status IN ('ACTIVE','ROTATING_OUT','REVOKED')),expires_at timestamptz,last_used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE device_configurations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),device_id uuid,FOREIGN KEY(school_id,device_id) REFERENCES devices(school_id,id),version integer NOT NULL,config jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE NULLS NOT DISTINCT(school_id,device_id,version));

CREATE TABLE device_heartbeats(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),device_id uuid NOT NULL,FOREIGN KEY(school_id,device_id) REFERENCES devices(school_id,id),received_at timestamptz NOT NULL DEFAULT now(),device_time timestamptz NOT NULL,skew_ms bigint NOT NULL,boot_id uuid NOT NULL,uptime_ms bigint NOT NULL,firmware_version text NOT NULL,pending_events integer NOT NULL,storage_used_pct smallint NOT NULL CHECK(storage_used_pct BETWEEN 0 AND 100),wifi_rssi_dbm smallint,reader_status text NOT NULL,rtc_status text NOT NULL,boot_reference_time timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE device_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),device_id uuid NOT NULL,FOREIGN KEY(school_id,device_id) REFERENCES devices(school_id,id),device_ts timestamptz,received_at timestamptz NOT NULL DEFAULT now(),level text NOT NULL CHECK(level IN ('INFO','WARN','ERROR')),code text NOT NULL,detail jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE device_ota_status(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),device_id uuid NOT NULL,FOREIGN KEY(school_id,device_id) REFERENCES devices(school_id,id),target_version text NOT NULL REFERENCES firmware_releases(version),state text NOT NULL CHECK(state IN ('OFFERED','DOWNLOADING','VERIFYING','INSTALLED','FAILED','ROLLED_BACK')),detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,device_id,target_version));

CREATE TABLE attendance_rule_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),class_id uuid,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),day_type text NOT NULL CHECK(day_type IN ('REGULAR','EXAM','SHORT_DAY')),version_no integer NOT NULL,effective_from date NOT NULL,effective_to date,rules jsonb NOT NULL CHECK(rules ?& ARRAY['arrival','departure','weekly_off','absent_cutoff']),created_by uuid NOT NULL REFERENCES users(id),CHECK(effective_to IS NULL OR effective_to>effective_from),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),EXCLUDE USING gist(school_id WITH =,(coalesce(class_id,'00000000-0000-0000-0000-000000000000'::uuid)) WITH =,day_type WITH =,daterange(effective_from,effective_to,'[)') WITH &&));

CREATE TABLE attendance_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),device_id uuid NOT NULL,FOREIGN KEY(school_id,device_id) REFERENCES devices(school_id,id),device_event_id uuid NOT NULL,sequence_number bigint NOT NULL CHECK(sequence_number>0),boot_id uuid NOT NULL,card_uid text NOT NULL,nfc_card_id uuid,FOREIGN KEY(school_id,nfc_card_id) REFERENCES nfc_cards(school_id,id),student_id uuid,FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),location_id uuid,FOREIGN KEY(school_id,location_id) REFERENCES device_locations(school_id,id),location_type text NOT NULL CHECK(location_type IN ('ENTRY','EXIT','BIDIRECTIONAL','CLASSROOM')),event_ts timestamptz NOT NULL,effective_ts timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),time_source text NOT NULL CHECK(time_source IN ('RTC_SYNCED','RTC_UNSYNCED','NTP','MONOTONIC','UNKNOWN')),timestamp_trust text NOT NULL CHECK(timestamp_trust IN ('TRUSTED','RECONSTRUCTED','SUSPECT')),uptime_ms bigint,firmware_version text NOT NULL,status text NOT NULL DEFAULT 'PROCESSING' CHECK(status IN ('PROCESSING','RECORDED','REJECTED')),outcome text,applied_to_daily boolean NOT NULL DEFAULT false,result jsonb,processed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(device_id,device_event_id),UNIQUE(device_id,sequence_number));

CREATE TABLE daily_attendance(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),student_id uuid NOT NULL,FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),attendance_date date NOT NULL,class_id uuid NOT NULL,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),academic_session_id uuid NOT NULL,FOREIGN KEY(school_id,academic_session_id) REFERENCES academic_sessions(school_id,id),attendance_status text NOT NULL DEFAULT 'PENDING' CHECK(attendance_status IN ('PENDING','PRESENT','LATE','HALF_DAY','ABSENT','EXCUSED')),movement_status text NOT NULL DEFAULT 'NOT_ARRIVED' CHECK(movement_status IN ('NOT_ARRIVED','ARRIVED','LEFT')),arrival_classification text CHECK(arrival_classification IN ('ON_TIME','LATE','AFTER_CUTOFF')),departure_classification text CHECK(departure_classification IN ('NORMAL','HALF_DAY','EARLY')),first_arrival_event_id uuid,FOREIGN KEY(school_id,first_arrival_event_id) REFERENCES attendance_events(school_id,id),first_arrival_at timestamptz,last_departure_event_id uuid,FOREIGN KEY(school_id,last_departure_event_id) REFERENCES attendance_events(school_id,id),last_departure_at timestamptz,rule_version_id uuid,FOREIGN KEY(school_id,rule_version_id) REFERENCES attendance_rule_versions(school_id,id),needs_review boolean NOT NULL DEFAULT false,source text NOT NULL DEFAULT 'NFC' CHECK(source IN ('NFC','MANUAL','SYSTEM')),version integer NOT NULL DEFAULT 0,manual_override boolean NOT NULL DEFAULT false,provisional boolean NOT NULL DEFAULT false,last_applied_event_ts timestamptz,departure_count integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,student_id,attendance_date));

CREATE TABLE attendance_corrections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),daily_attendance_id uuid NOT NULL,FOREIGN KEY(school_id,daily_attendance_id) REFERENCES daily_attendance(school_id,id),requested_status text NOT NULL CHECK(requested_status IN ('PENDING','PRESENT','LATE','HALF_DAY','ABSENT','EXCUSED')),reason text NOT NULL,status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','APPROVED','REJECTED','APPLIED','CANCELLED')),requested_by uuid NOT NULL REFERENCES users(id),approved_by uuid REFERENCES users(id),decided_at timestamptz,applied_at timestamptz,requested_at timestamptz NOT NULL DEFAULT now(),CHECK(approved_by IS NULL OR approved_by<>requested_by),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE notification_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),kind text NOT NULL,student_id uuid,FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),dedupe_key text NOT NULL,payload jsonb NOT NULL,source_event_id uuid,FOREIGN KEY(school_id,source_event_id) REFERENCES attendance_events(school_id,id),status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','DEAD')),attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),locked_until timestamptz,lease_token uuid,completed_at timestamptz,last_error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,dedupe_key));

CREATE TABLE notification_deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),outbox_id uuid NOT NULL,FOREIGN KEY(school_id,outbox_id) REFERENCES notification_outbox(school_id,id),parent_id uuid,FOREIGN KEY(school_id,parent_id) REFERENCES parents(school_id,id),channel text NOT NULL CHECK(channel IN ('PUSH','EMAIL','SMS')),address_hash text,status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENT','FAILED','SUPPRESSED','EXPIRED_STALE','DEAD')),attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz,provider_message_id text,last_error text,sent_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE NULLS NOT DISTINCT(school_id,outbox_id,parent_id,channel));

CREATE TABLE notification_attempts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),delivery_id uuid NOT NULL,FOREIGN KEY(school_id,delivery_id) REFERENCES notification_deliveries(school_id,id),attempt integer NOT NULL,status text NOT NULL,provider_message_id text,error_code text,attempted_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,delivery_id,attempt));

CREATE TABLE notification_preferences(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),parent_id uuid NOT NULL,FOREIGN KEY(school_id,parent_id) REFERENCES parents(school_id,id),kind text NOT NULL,channel text NOT NULL CHECK(channel IN ('PUSH','EMAIL','SMS')),enabled boolean NOT NULL,quiet_start time,quiet_end time,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,parent_id,kind,channel));

CREATE TABLE push_tokens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),user_id uuid NOT NULL REFERENCES users(id),token_hash text NOT NULL UNIQUE,token_encrypted text NOT NULL,platform text NOT NULL CHECK(platform IN ('WEB','ANDROID','IOS')),last_seen_at timestamptz NOT NULL DEFAULT now(),is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE announcements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),audience text NOT NULL CHECK(audience IN ('SCHOOL','CLASS','PARENTS','STAFF')),class_id uuid,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),title text NOT NULL,body text NOT NULL,published_at timestamptz,created_by uuid NOT NULL REFERENCES users(id),CHECK(audience<>'CLASS' OR class_id IS NOT NULL),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE fee_records(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),student_id uuid NOT NULL,FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),academic_session_id uuid NOT NULL,FOREIGN KEY(school_id,academic_session_id) REFERENCES academic_sessions(school_id,id),fee_type text NOT NULL,amount_due numeric(12,2) NOT NULL CHECK(amount_due>=0),amount_paid numeric(12,2) NOT NULL DEFAULT 0 CHECK(amount_paid>=0 AND amount_paid<=amount_due),currency char(3) NOT NULL DEFAULT 'INR',due_on date NOT NULL,status text NOT NULL CHECK(status IN ('UNPAID','PARTIAL','PAID','WAIVED')),CHECK((status='PAID' AND amount_paid=amount_due) OR (status='PARTIAL' AND amount_paid>0 AND amount_paid<amount_due) OR (status='UNPAID' AND amount_paid=0) OR status='WAIVED'),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),plan_id uuid NOT NULL REFERENCES subscription_plans(id),status text NOT NULL CHECK(status IN ('TRIALING','ACTIVE','PAST_DUE','SUSPENDED_READONLY','SUSPENDED','CANCELLED','EXPIRED')),current_period_end timestamptz NOT NULL,grace_ends_at timestamptz,limit_overrides jsonb,billing_ref text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE subscription_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),subscription_id uuid NOT NULL,FOREIGN KEY(school_id,subscription_id) REFERENCES subscriptions(school_id,id),previous_status text,new_status text NOT NULL,reason text NOT NULL,actor_id uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE api_idempotency_keys(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),user_id uuid NOT NULL REFERENCES users(id),key text NOT NULL,request_hash text NOT NULL,response jsonb,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,user_id,key));

CREATE TABLE report_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),kind text NOT NULL CHECK(kind IN ('ATTENDANCE','ACADEMIC','FEES')),student_id uuid,FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),class_id uuid,FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),storage_path text,status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),requested_by uuid NOT NULL REFERENCES users(id),parameters jsonb NOT NULL,locked_until timestamptz,lease_token uuid,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE job_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),job_name text NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,status text NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED')),detail jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));

CREATE TABLE audit_logs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,school_id uuid REFERENCES schools(id),occurred_at timestamptz NOT NULL DEFAULT now(),actor_type text NOT NULL CHECK(actor_type IN ('USER','DEVICE','SYSTEM','SUPPORT')),actor_id uuid,support_grant_id uuid REFERENCES support_access_grants(id),action text NOT NULL,entity_type text NOT NULL,entity_id uuid,before jsonb,after jsonb,request_id text,ip inet,user_agent text);
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
GRANT EXECUTE ON FUNCTION app.worker_schools() TO app_worker;

ALTER TABLE school_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON school_memberships TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX school_memberships_tenant ON school_memberships(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON school_memberships FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE support_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON support_access_grants TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX support_access_grants_tenant ON support_access_grants(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON support_access_grants FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE academic_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON academic_sessions TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX academic_sessions_tenant ON academic_sessions(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON academic_sessions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE teachers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON teachers TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX teachers_tenant ON teachers(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON teachers FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON classes TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX classes_tenant ON classes(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON classes FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE subjects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON subjects TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX subjects_tenant ON subjects(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON subjects FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE students FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON students TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX students_tenant ON students(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON enrollments TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX enrollments_tenant ON enrollments(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON enrollments FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE parents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON parents TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX parents_tenant ON parents(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON parents FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE student_parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_parents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON student_parents TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX student_parents_tenant ON student_parents(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON student_parents FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE teacher_class_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_class_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON teacher_class_assignments TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX teacher_class_assignments_tenant ON teacher_class_assignments(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON teacher_class_assignments FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON exams TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX exams_tenant ON exams(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE marks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON marks TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX marks_tenant ON marks(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON marks FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON assignments TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX assignments_tenant ON assignments(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE timetable_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetable_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON timetable_entries TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX timetable_entries_tenant ON timetable_entries(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON timetable_entries FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE school_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_holidays FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON school_holidays TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX school_holidays_tenant ON school_holidays(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON school_holidays FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE nfc_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfc_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON nfc_cards TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX nfc_cards_tenant ON nfc_cards(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON nfc_cards FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE device_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON device_locations TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX device_locations_tenant ON device_locations(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON device_locations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON devices TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX devices_tenant ON devices(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE device_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON device_credentials TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX device_credentials_tenant ON device_credentials(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON device_credentials FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE device_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_configurations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON device_configurations TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX device_configurations_tenant ON device_configurations(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON device_configurations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE device_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON device_heartbeats TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX device_heartbeats_tenant ON device_heartbeats(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON device_heartbeats FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE device_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON device_logs TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX device_logs_tenant ON device_logs(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON device_logs FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE device_ota_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_ota_status FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON device_ota_status TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX device_ota_status_tenant ON device_ota_status(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON device_ota_status FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE attendance_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_rule_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON attendance_rule_versions TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX attendance_rule_versions_tenant ON attendance_rule_versions(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON attendance_rule_versions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE attendance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON attendance_events TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX attendance_events_tenant ON attendance_events(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON attendance_events FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE daily_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_attendance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON daily_attendance TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX daily_attendance_tenant ON daily_attendance(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON daily_attendance FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE attendance_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON attendance_corrections TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX attendance_corrections_tenant ON attendance_corrections(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON attendance_corrections FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON notification_outbox TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX notification_outbox_tenant ON notification_outbox(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON notification_outbox FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON notification_deliveries TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX notification_deliveries_tenant ON notification_deliveries(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE notification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON notification_attempts TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX notification_attempts_tenant ON notification_attempts(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON notification_attempts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON notification_preferences TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX notification_preferences_tenant ON notification_preferences(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON push_tokens TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX push_tokens_tenant ON push_tokens(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON push_tokens FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON announcements TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX announcements_tenant ON announcements(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE fee_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON fee_records TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX fee_records_tenant ON fee_records(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON fee_records FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON subscriptions TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX subscriptions_tenant ON subscriptions(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON subscription_events TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX subscription_events_tenant ON subscription_events(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON subscription_events FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE api_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON api_idempotency_keys TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX api_idempotency_keys_tenant ON api_idempotency_keys(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON api_idempotency_keys FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE report_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON report_documents TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX report_documents_tenant ON report_documents(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON report_documents FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON job_runs TO app_api,app_device,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE INDEX job_runs_tenant ON job_runs(school_id);
CREATE TRIGGER touch BEFORE UPDATE ON job_runs FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON school_memberships FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON student_parents FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON nfc_cards FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON attendance_corrections FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON marks FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON fee_records FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON support_access_grants FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON attendance_rule_versions FOR EACH ROW EXECUTE FUNCTION app.audit_change();

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
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

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY; ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY platform ON organizations TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());

ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY; ALTER TABLE subscription_plans FORCE ROW LEVEL SECURITY;

CREATE POLICY reference_read ON subscription_plans FOR SELECT TO app_api,app_device,app_worker USING(true);

CREATE POLICY platform ON subscription_plans TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());

ALTER TABLE firmware_releases ENABLE ROW LEVEL SECURITY; ALTER TABLE firmware_releases FORCE ROW LEVEL SECURITY;

CREATE POLICY reference_read ON firmware_releases FOR SELECT TO app_api,app_device,app_worker USING(true);

CREATE POLICY platform ON firmware_releases TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());

ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY; ALTER TABLE billing_webhook_events FORCE ROW LEVEL SECURITY;

CREATE POLICY platform ON billing_webhook_events TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY; ALTER TABLE roles FORCE ROW LEVEL SECURITY;

CREATE POLICY reference_read ON roles FOR SELECT TO app_api,app_device,app_worker USING(true);

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY; ALTER TABLE permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY reference_read ON permissions FOR SELECT TO app_api,app_device,app_worker USING(true);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY; ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY reference_read ON role_permissions FOR SELECT TO app_api,app_device,app_worker USING(true);

ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY; ALTER TABLE platform_staff FORCE ROW LEVEL SECURITY;

CREATE POLICY platform ON subscriptions TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());

CREATE POLICY platform ON subscription_events TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());

CREATE POLICY platform ON devices TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());

CREATE POLICY platform ON device_credentials TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());

CREATE POLICY platform ON support_access_grants TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());

-- No browser PostgREST privileges on application records, including via PUBLIC.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon,authenticated,PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon,authenticated,PUBLIC;
CREATE FUNCTION app.on_auth_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 INSERT INTO users(id,email,full_name,status) VALUES(NEW.id,NEW.email,coalesce(NEW.raw_user_meta_data->>'full_name',split_part(NEW.email,'@',1)),'ACTIVE') ON CONFLICT(id) DO NOTHING; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.on_auth_user() FROM PUBLIC;
CREATE TRIGGER auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION app.on_auth_user();
INSERT INTO storage.buckets(id,name,public) VALUES('school-documents','school-documents',false),('firmware','firmware',false) ON CONFLICT(id) DO NOTHING;
-- No anon/authenticated storage.objects policy is created. Only server-authorized signed operations.
