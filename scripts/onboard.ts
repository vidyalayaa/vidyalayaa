import 'dotenv/config';
import pg from 'pg';
import { z } from 'zod';
// Link an already verified Supabase identity. Never chooses an identity by untrusted email.
const [command, user, school, role] = process.argv.slice(2),
  uid = z.string().uuid().parse(user);
const db = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  ssl:
    process.env.DB_SSL === 'false'
      ? false
      : {
          rejectUnauthorized:
          process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
            ? false
            : process.env.DB_SSL_REJECT_UNAUTHORIZED !== undefined
              ? process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'
              : Boolean(process.env.DB_CA_CERT),
          ...(process.env.DB_CA_CERT ? { ca: process.env.DB_CA_CERT.replace(/\\n/g, '\n') } : {}),
        },
});
await db.connect();
try {
  await db.query('BEGIN');
  if (!(await db.query('SELECT id FROM users WHERE id=$1', [uid])).rowCount)
    throw new Error('Create the Supabase identity first and verify its UUID.');
  if (command === 'platform') {
    await db.query(
      "INSERT INTO platform_staff(user_id,platform_role,mfa_required) VALUES($1,'SUPER_ADMIN',true) ON CONFLICT(user_id) DO NOTHING",
      [uid],
    );
  } else if (command === 'member') {
    z.string().uuid().parse(school);
    z.enum(['school_admin', 'principal', 'teacher', 'parent', 'student']).parse(role);
    await db.query(
      "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code=$3 ON CONFLICT(school_id,user_id) DO UPDATE SET role_id=EXCLUDED.role_id,status='ACTIVE'",
      [school, uid, role],
    );
  } else
    throw new Error(
      'Usage: npx tsx scripts/onboard.ts platform USER_UUID | member USER_UUID SCHOOL_UUID ROLE',
    );
  await db.query('COMMIT');
  console.info('Identity linked. Enroll and verify MFA before platform access.');
} catch (e) {
  await db.query('ROLLBACK');
  throw e;
} finally {
  await db.end();
}
