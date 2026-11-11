const fields: Record<string, string[]> = {
  schools: ['school_code', 'name', 'status', 'timezone', 'organization_id', 'reason'],
  devices: [
    'device_code',
    'name',
    'status',
    'firmware_version',
    'location_id',
    'config_version',
    'reason',
    'hardware_model',
    'hardware_verified_at',
    'hardware_verification_ref',
  ],
  subscriptions: [
    'plan_id',
    'status',
    'current_period_end',
    'grace_ends_at',
    'export_until',
    'limit_overrides',
    'billing_ref',
    'billing_mode',
    'reason',
  ],
  subscription_plans: ['code', 'name', 'features', 'limits', 'is_active', 'reason'],
  support_access_grants: [
    'scope',
    'reason',
    'ticket_ref',
    'expires_at',
    'approved_by',
    'revoked_at',
  ],
  platform_staff: ['user_id', 'platform_role'],
  school_deletion: [
    'school_id',
    'initiated_by',
    'initiated_at',
    'approved_by',
    'approved_at',
    'executed_by',
    'executed_at',
    'irreversible_at',
  ],
  authentication: ['error_code', 'method', 'path'],
  firmware_releases: ['version', 'sha256', 'hardware_model', 'enabled', 'pipeline_ref'],
  device_ota_assignments: [
    'device_id',
    'version',
    'enabled',
    'approved_by',
    'reason',
    'acceptance_ref',
  ],
};
// Database RLS determines which events are visible; this allowlist determines
// which metadata from their historical snapshots may leave the platform API.
export function platformAuditSnapshot(entity: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => fields[entity]?.includes(key))
      .map(([key, item]) => {
        if (['features', 'limits', 'limit_overrides'].includes(key))
          return [
            key,
            item && typeof item === 'object' && !Array.isArray(item)
              ? Object.fromEntries(
                  Object.entries(item).filter(
                    ([, v]) =>
                      typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)),
                  ),
                )
              : null,
          ];
        if (key === 'scope')
          return [
            key,
            Array.isArray(item)
              ? item.filter((v) => ['students', 'attendance', 'marks', 'fees'].includes(v))
              : [],
          ];
        return [
          key,
          item === null || ['string', 'number', 'boolean'].includes(typeof item) ? item : null,
        ];
      }),
  );
}
