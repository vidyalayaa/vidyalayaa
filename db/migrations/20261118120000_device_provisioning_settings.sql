CREATE TABLE app.device_provisioning_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  api_origin text NOT NULL CHECK (length(api_origin) BETWEEN 9 AND 200),
  root_ca text NOT NULL CHECK (octet_length(root_ca) BETWEEN 1 AND 4096)
);

ALTER TABLE app.device_provisioning_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.device_provisioning_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.device_provisioning_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON app.device_provisioning_settings TO app_platform;
GRANT SELECT ON app.device_provisioning_settings TO app_api;
CREATE POLICY provisioning_platform ON app.device_provisioning_settings TO app_platform
  USING (app.is_platform_staff()) WITH CHECK (app.is_platform_staff());
CREATE POLICY provisioning_school_read ON app.device_provisioning_settings FOR SELECT TO app_api
  USING (app.school_id() IS NOT NULL);
