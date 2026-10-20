ALTER TABLE subscriptions ADD COLUMN export_until timestamptz;
COMMENT ON COLUMN subscriptions.export_until IS 'Explicit contractual export deadline for terminal subscription states. NULL never grants unlimited terminal access.';
