-- Private worker health. The Render worker deliberately exposes no public HTTP port.
CREATE TABLE worker_instances(id uuid PRIMARY KEY,started_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),last_success_at timestamptz,
 state text NOT NULL CHECK(state IN ('STARTING','RUNNING','DEGRADED','STOPPING')),last_error_code text);
ALTER TABLE worker_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY worker ON worker_instances TO app_worker USING(true) WITH CHECK(true);
CREATE POLICY platform ON worker_instances FOR SELECT TO app_platform USING(app.is_platform_staff());
REVOKE ALL ON worker_instances FROM PUBLIC,anon,authenticated,app_api,app_device;
GRANT SELECT,INSERT,UPDATE,DELETE ON worker_instances TO app_worker;
GRANT SELECT ON worker_instances TO app_platform;

CREATE TABLE push_delivery_targets(school_id uuid NOT NULL,delivery_id uuid NOT NULL,token_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENT','DEAD')),
 provider_message_id text,last_error text,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(school_id,delivery_id,token_id),
 FOREIGN KEY(school_id,delivery_id) REFERENCES notification_deliveries(school_id,id),
 FOREIGN KEY(school_id,token_id) REFERENCES push_tokens(school_id,id));
ALTER TABLE push_delivery_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_delivery_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON push_delivery_targets TO app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
REVOKE ALL ON push_delivery_targets FROM PUBLIC,anon,authenticated,app_api,app_device,app_platform;
GRANT SELECT,INSERT,UPDATE ON push_delivery_targets TO app_worker;

CREATE TABLE provider_buckets(channel text PRIMARY KEY CHECK(channel IN ('PUSH','EMAIL','SMS')),tokens numeric NOT NULL,updated_at timestamptz NOT NULL);
ALTER TABLE provider_buckets ENABLE ROW LEVEL SECURITY;ALTER TABLE provider_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON provider_buckets FROM PUBLIC,anon,authenticated,app_api,app_device,app_platform,app_worker;
CREATE FUNCTION app.take_provider_token(ch text,rate integer,capacity integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE bucket provider_buckets;available numeric;ts timestamptz:=clock_timestamp(); BEGIN
 IF ch NOT IN ('PUSH','EMAIL','SMS') OR rate<1 OR rate>10000 OR capacity<1 OR capacity>10000 THEN RAISE EXCEPTION 'Invalid bucket';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('provider:'||ch,0));
 INSERT INTO provider_buckets VALUES(ch,capacity,ts) ON CONFLICT DO NOTHING;
 SELECT * INTO bucket FROM provider_buckets WHERE channel=ch FOR UPDATE;
 available:=least(capacity,bucket.tokens+greatest(0,extract(epoch FROM ts-bucket.updated_at))*rate);
 IF available<1 THEN RETURN greatest(1,ceil((1-available)/rate)::integer);END IF;
 UPDATE provider_buckets SET tokens=available-1,updated_at=ts WHERE channel=ch;
 RETURN 0;
END $$;
REVOKE ALL ON FUNCTION app.take_provider_token(text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.take_provider_token(text,integer,integer) TO app_worker;

-- Platform metadata only. No student records or contact data leave this function.
CREATE FUNCTION app.platform_operations() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$ BEGIN
 IF NOT app.is_platform_staff() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object(
 'schools',(SELECT count(*) FROM schools WHERE status<>'TERMINATED'),
 'active_subscriptions',(SELECT count(*) FROM subscriptions WHERE status IN ('ACTIVE','TRIALING')),
 'students',(SELECT count(*) FROM students WHERE status='ACTIVE'),
 'devices',(SELECT count(*) FROM devices WHERE status='ACTIVE'),
 'offline_devices',(SELECT count(*) FROM devices WHERE status='ACTIVE' AND (last_seen_at IS NULL OR last_seen_at<now()-interval '3 minutes')),
 'pending_events',(SELECT coalesce(sum(pending_event_count),0) FROM devices WHERE status='ACTIVE'),
 'notification_backlog',(SELECT count(*) FROM notification_outbox WHERE status IN ('PENDING','PROCESSING')),
 'dead_notifications',(SELECT count(*) FROM notification_outbox WHERE status='DEAD'),
 'quarantined_events',(SELECT count(*) FROM attendance_events WHERE outcome IN ('QUARANTINED_TIMESTAMP','STORED_PENDING_RULES')),
 'sequence_gap_alerts_24h',(SELECT count(*) FROM device_logs WHERE code='SEQUENCE_GAP' AND received_at>now()-interval '24 hours'),
 'pending_reports',(SELECT count(*) FROM report_documents WHERE status IN ('PENDING','PROCESSING')),
 'failed_reports',(SELECT count(*) FROM report_documents WHERE status='FAILED'));
END $$;
REVOKE ALL ON FUNCTION app.platform_operations() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.platform_operations() TO app_platform;

-- Configuration snapshots are append-only and retain the authenticated editor.
CREATE FUNCTION app.record_device_configuration() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.config_version<>OLD.config_version AND app.user_id() IS NOT NULL THEN
   INSERT INTO device_configurations(school_id,device_id,version,config,created_by)
   VALUES(NEW.school_id,NEW.id,NEW.config_version,
     NEW.config||jsonb_build_object('name',NEW.name,'location_id',NEW.location_id,'status',NEW.status),app.user_id());
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.record_device_configuration() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER device_configuration_history AFTER UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION app.record_device_configuration();
REVOKE INSERT,UPDATE,DELETE ON device_configurations FROM app_api;
