ALTER TABLE devices ADD COLUMN hardware_model text;
ALTER TABLE devices ADD COLUMN verified_chip_revision integer;
ALTER TABLE devices ADD COLUMN verified_flash_bytes integer;
ALTER TABLE devices ADD COLUMN hardware_verified_by uuid REFERENCES users(id);
ALTER TABLE devices ADD COLUMN hardware_verified_at timestamptz;
ALTER TABLE devices ADD COLUMN hardware_verification_ref text;
ALTER TABLE firmware_releases ADD COLUMN signing_key_fingerprint text;
ALTER TABLE firmware_releases ADD COLUMN enabled boolean NOT NULL DEFAULT false;
ALTER TABLE firmware_releases ADD COLUMN pipeline_ref text;
ALTER TABLE firmware_releases ADD COLUMN published_by uuid REFERENCES users(id);
CREATE TABLE device_ota_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),device_id uuid NOT NULL,
 FOREIGN KEY(school_id,device_id) REFERENCES devices(school_id,id),version text NOT NULL REFERENCES firmware_releases(version),enabled boolean NOT NULL DEFAULT true,
 approved_by uuid NOT NULL REFERENCES users(id),reason text NOT NULL,acceptance_ref text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));
CREATE UNIQUE INDEX one_device_ota_offer ON device_ota_assignments(device_id) WHERE enabled;
ALTER TABLE device_ota_assignments ENABLE ROW LEVEL SECURITY;ALTER TABLE device_ota_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY device ON device_ota_assignments FOR SELECT TO app_device,app_worker USING(school_id=app.school_id());
CREATE POLICY platform ON device_ota_assignments TO app_platform USING(app.is_platform_staff()) WITH CHECK(app.is_platform_staff());
GRANT SELECT ON device_ota_assignments TO app_device,app_worker;GRANT SELECT,INSERT,UPDATE ON device_ota_assignments TO app_platform;
CREATE TRIGGER touch BEFORE UPDATE ON device_ota_assignments FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON device_ota_assignments FOR EACH ROW EXECUTE FUNCTION app.audit_change();
-- firmware_releases has a text primary key; its audit record uses the version in metadata.
CREATE FUNCTION app.audit_firmware_release() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,after) VALUES('USER',app.user_id(),'firmware.release_changed','firmware_releases',jsonb_build_object('version',NEW.version,'sha256',NEW.sha256,'hardware_model',NEW.hardware_model,'enabled',NEW.enabled,'pipeline_ref',NEW.pipeline_ref));RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.audit_firmware_release() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON firmware_releases FOR EACH ROW EXECUTE FUNCTION app.audit_firmware_release();

CREATE POLICY platform_firmware_audit ON audit_logs FOR SELECT TO app_platform USING(app.is_platform_staff() AND entity_type IN ('firmware_releases','device_ota_assignments'));
