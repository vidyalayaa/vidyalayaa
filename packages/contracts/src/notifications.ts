import { z } from 'zod';
export const schoolNotificationKinds = [
  'STUDENT_ARRIVED',
  'STUDENT_DEPARTED',
  'STUDENT_ABSENT',
  'ATTENDANCE_CORRECTED',
  'FEE_REMINDER',
  'ANNOUNCEMENT',
  'DEVICE_ALERT',
  'SUBSCRIPTION_UPDATE',
  'CUSTOM',
] as const;
export const notificationRoles = [
  'school_admin',
  'principal',
  'teacher',
  'parent',
  'student',
  'finance_staff',
] as const;
export const customNotificationSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(1000),
    audience: z.enum(['ALL', 'ROLES', 'MEMBERS']),
    roles: z.array(z.enum(notificationRoles)).max(6).default([]),
    user_ids: z.array(z.string().uuid()).max(5000).default([]),
  })
  .strict()
  .superRefine((b, c) => {
    if (
      (b.audience === 'ROLES' && !b.roles.length) ||
      (b.audience === 'MEMBERS' && !b.user_ids.length)
    )
      c.addIssue({ code: 'custom', message: 'Select at least one recipient or role.' });
    if (new Set(b.user_ids).size !== b.user_ids.length || new Set(b.roles).size !== b.roles.length)
      c.addIssue({ code: 'custom', message: 'Recipients and roles must be unique.' });
  });
export const notificationSettingsSchema = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    channels: z.object({ PUSH: z.boolean(), EMAIL: z.boolean(), SMS: z.boolean() }).strict(),
    kinds: z
      .object(
        Object.fromEntries(schoolNotificationKinds.map((k) => [k, z.boolean()])) as Record<
          (typeof schoolNotificationKinds)[number],
          z.ZodBoolean
        >,
      )
      .strict(),
  })
  .strict();
export type CustomNotificationInput = z.infer<typeof customNotificationSchema>;
export type SchoolNotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const defaultNotificationSettings: SchoolNotificationSettings = {
  version: 0,
  enabled: true,
  channels: { PUSH: true, EMAIL: true, SMS: true },
  kinds: Object.fromEntries(
    schoolNotificationKinds.map((k) => [k, true]),
  ) as SchoolNotificationSettings['kinds'],
};
export interface NotificationMember {
  user_id: string;
  full_name: string;
  email: string;
  role: string;
  push_devices: number;
}
export interface NotificationPreview {
  user_ids: string[];
  recipients: number;
  push_ready: number;
  devices: number;
}
