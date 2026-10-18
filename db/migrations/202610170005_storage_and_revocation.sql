UPDATE storage.buckets SET file_size_limit=10485760,allowed_mime_types=ARRAY['application/pdf','image/png','image/jpeg'] WHERE id='school-documents';
CREATE OR REPLACE FUNCTION app.device_auth(code text) RETURNS TABLE(id uuid,school_id uuid,status text,secret_hash bytea,expires_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT d.id,d.school_id,d.status,c.secret_hash,c.expires_at FROM devices d JOIN device_credentials c ON c.device_id=d.id AND c.school_id=d.school_id WHERE d.device_code=code AND ((c.status IN ('ACTIVE','ROTATING_OUT') AND (c.expires_at IS NULL OR c.expires_at>now())) OR d.status='REVOKED')
$$;
REVOKE ALL ON FUNCTION app.device_auth(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.device_auth(text) TO app_device;
