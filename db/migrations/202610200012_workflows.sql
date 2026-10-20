CREATE TABLE attendance_reconciliation_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),event_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES users(id),reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 2000),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','NEEDS_INFORMATION','FAILED')),
 result_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(school_id,event_id) REFERENCES attendance_events(school_id,id),UNIQUE(school_id,id));
ALTER TABLE attendance_reconciliation_requests ENABLE ROW LEVEL SECURITY;ALTER TABLE attendance_reconciliation_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON attendance_reconciliation_requests TO app_api,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
GRANT SELECT,INSERT ON attendance_reconciliation_requests TO app_api;
GRANT SELECT,UPDATE ON attendance_reconciliation_requests TO app_worker;
CREATE UNIQUE INDEX one_pending_event_review ON attendance_reconciliation_requests(school_id,event_id) WHERE status IN ('PENDING','PROCESSING');
CREATE TRIGGER touch BEFORE UPDATE ON attendance_reconciliation_requests FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['academic_sessions','classes','subjects','exams','assignments','timetable_entries','school_holidays','announcements','teacher_class_assignments'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN retired_at timestamptz',t);
 END LOOP;
END $$;
CREATE TRIGGER access_revision AFTER UPDATE ON classes FOR EACH ROW EXECUTE FUNCTION app.bump_school_access();
ALTER TABLE timetable_entries DROP CONSTRAINT teacher_no_overlap;
ALTER TABLE timetable_entries DROP CONSTRAINT class_no_overlap;
ALTER TABLE timetable_entries ADD CONSTRAINT teacher_no_overlap EXCLUDE USING gist(school_id WITH =,teacher_id WITH =,weekday WITH =,int8range((extract(epoch FROM starts_at)*1000)::bigint,(extract(epoch FROM ends_at)*1000)::bigint,'[)') WITH &&) WHERE(retired_at IS NULL);
ALTER TABLE timetable_entries ADD CONSTRAINT class_no_overlap EXCLUDE USING gist(school_id WITH =,class_id WITH =,weekday WITH =,int8range((extract(epoch FROM starts_at)*1000)::bigint,(extract(epoch FROM ends_at)*1000)::bigint,'[)') WITH &&) WHERE(retired_at IS NULL);

ALTER TABLE device_heartbeats ADD COLUMN last_ntp_sync timestamptz;
ALTER TABLE device_heartbeats ADD COLUMN reset_reason text;
ALTER TABLE device_heartbeats ADD COLUMN config_version integer;
ALTER TABLE device_heartbeats ADD COLUMN oldest_pending_sequence bigint;
ALTER TABLE device_heartbeats ADD COLUMN last_sequence bigint;
ALTER TABLE device_heartbeats ADD COLUMN applied_config_version integer;
