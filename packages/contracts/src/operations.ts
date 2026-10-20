import { z } from 'zod';
const id = z.string().uuid(),
  reason = z.string().trim().min(5).max(2000);
export const securityPolicySchema = z
  .object({
    require_privileged_mfa: z.boolean(),
    student_login_enabled: z.boolean(),
    step_up_sensitive: z.boolean(),
    device_offline_minutes: z.number().int().min(1).max(60),
    policy_ref: z.string().trim().min(5).max(200),
  })
  .strict();
export const exportRequestSchema = z.object({ format: z.enum(['JSON', 'CSV']), reason }).strict();
export const reconciliationRequestSchema = z.object({ reason }).strict();
export const retirementSchema = z.object({ reason }).strict();
export const notificationPrivacySchema = z
  .object({ no_names_on_lock_screen: z.boolean() })
  .strict();
export const campusAssociationSchema = z
  .object({ organization_id: id.nullable(), reason })
  .strict();
export const supportRequestSchema = z
  .object({
    subject: z.string().trim().min(5).max(200),
    category: z.enum(['ACCOUNT', 'BILLING', 'DEVICE', 'OTHER']),
    description: z.string().trim().min(10).max(2000),
  })
  .strict();
export const supportResponseSchema = z
  .object({
    status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']),
    response: z.string().trim().min(5).max(2000),
  })
  .strict();
export const exportFileSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  url: z.string(),
  expires_at: z.string().optional(),
});
export const deviceProtocol = {
  version: 1,
  maxBatchEvents: 100,
  maxFirmwareVersionLength: 80,
  maxDeviceCodeLength: 64,
} as const;
export const firmwareVersionSchema = z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/);
export const firmwareManifestSchema = z
  .object({
    version: firmwareVersionSchema,
    channel: z.enum(['PILOT', 'STABLE']),
    hardware_model: z.literal('ESP32_ECO3_4MB'),
    security_version: z.number().int().min(1).max(32),
    signature: z.string().regex(/^[A-Za-z0-9+/]{512}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    pipeline_ref: z.string().min(10).max(200),
  })
  .strict();
export const firmwareApprovalSchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().min(10).max(1000),
    acceptance_ref: z.string().min(10).max(200),
  })
  .strict();
export const hardwareVerificationSchema = z
  .object({
    hardware_model: z.literal('ESP32_ECO3_4MB'),
    chip_revision: z.number().int().min(300),
    flash_bytes: z.literal(4194304),
    verification_ref: z.string().min(10).max(200),
  })
  .strict();
export const firmwareAssignmentSchema = firmwareApprovalSchema.extend({
  version: firmwareVersionSchema,
});
