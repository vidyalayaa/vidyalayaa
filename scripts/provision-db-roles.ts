import 'dotenv/config';
import pg from 'pg';
const names = {
  api: 'app_api',
  device: 'app_device',
  worker: 'app_worker',
  platform: 'app_platform',
} as const;
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
  for (const [kind, role] of Object.entries(names)) {
    const password = process.env[`DB_${kind.toUpperCase()}_PASSWORD`];
    if (!password || password.length < 32)
      throw new Error(
        `Set DB_${kind.toUpperCase()}_PASSWORD to a unique secret of at least 32 characters.`,
      );
    const login = `vidyalayaa_${kind}`,
      quoted = "'" + password.replaceAll("'", "''") + "'";
    const exists = await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [login]);
    await db.query(
      `${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${login} LOGIN INHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${quoted}`,
    );
    await db.query(`GRANT ${role} TO ${login}`);
    console.info(`Provisioned ${login}; no credential printed.`);
  }
} finally {
  await db.end();
}
