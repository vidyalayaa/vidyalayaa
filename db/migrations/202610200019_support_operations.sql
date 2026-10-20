CREATE TABLE support_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),requested_by uuid NOT NULL REFERENCES users(id),
 subject text NOT NULL,category text NOT NULL CHECK(category IN ('ACCOUNT','BILLING','DEVICE','OTHER')),description text NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_PROGRESS','RESOLVED')),response text,responded_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));
ALTER TABLE support_requests ENABLE ROW LEVEL SECURITY;ALTER TABLE support_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON support_requests TO app_api USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE POLICY platform ON support_requests TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());
GRANT SELECT,INSERT ON support_requests TO app_api;GRANT SELECT,UPDATE ON support_requests TO app_platform;
CREATE TRIGGER touch BEFORE UPDATE ON support_requests FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON support_requests FOR EACH ROW EXECUTE FUNCTION app.audit_change();
CREATE INDEX support_queue ON support_requests(status,created_at);
CREATE TABLE platform_notices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),kind text NOT NULL CHECK(kind IN ('SUBSCRIPTION_UPDATE','DEVICE_ALERT')),
 source_ref text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,kind,source_ref));
ALTER TABLE platform_notices ENABLE ROW LEVEL SECURITY;ALTER TABLE platform_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY worker ON platform_notices TO app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE POLICY platform ON platform_notices FOR SELECT TO app_platform USING(app.is_platform_staff());
GRANT SELECT,INSERT ON platform_notices TO app_worker;GRANT SELECT ON platform_notices TO app_platform;
-- Ticket text must not contain student records; support grants still require separate school approval.

CREATE POLICY worker_export ON support_requests FOR SELECT TO app_worker USING(school_id=app.school_id());
GRANT SELECT ON support_requests TO app_worker;
