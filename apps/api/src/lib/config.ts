import { z } from 'zod';
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  DEVICE_DATABASE_URL: z.string().min(1),
  PLATFORM_DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  WEB_ORIGINS: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  DB_SSL: z.enum(['true', 'false']).default('true'),
  DB_SSL_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).optional(),
  DB_CA_CERT: z.string().optional(),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  PROFILE_PHOTO_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024)
    .max(10 * 1024 * 1024)
    .optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  FIRMWARE_RELEASE_PUBLIC_KEY: z.string().max(10000).optional(),
  BILLING_WEBHOOK_SECRET: z.string().min(32).optional(),
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig() {
  const config = configSchema.parse(process.env);
  if (config.NODE_ENV === 'production' && config.DB_SSL !== 'true')
    throw new Error('Verified database TLS is mandatory in production.');
  return config;
}
