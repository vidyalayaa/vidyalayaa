GRANT SELECT,INSERT,UPDATE ON attendance_events TO app_worker;
GRANT SELECT ON nfc_cards,device_heartbeats,device_configurations,attendance_corrections TO app_worker;
CREATE INDEX reconciliation_queue ON attendance_events(school_id,created_at) WHERE outcome IN ('STORED_PENDING_RULES','QUARANTINED_TIMESTAMP');
-- Restrict direct token writes to the authenticated actor, in addition to tenant RLS.
DROP POLICY tenant ON push_tokens;
CREATE POLICY token_user ON push_tokens TO app_api USING(school_id=app.school_id() AND user_id=app.user_id()) WITH CHECK(school_id=app.school_id() AND user_id=app.user_id());
CREATE POLICY token_worker ON push_tokens TO app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
