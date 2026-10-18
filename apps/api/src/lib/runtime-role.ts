import type pg from 'pg';
/** Refuse owner/service connections even if a deploy accidentally supplies one. */
export async function assertRuntimeRole(
  pool: pg.Pool,
  expected: 'app_api' | 'app_device' | 'app_worker' | 'app_platform',
) {
  const result = await pool.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    allowed: boolean;
    owns_tables: boolean;
  }>(
    "SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,pg_has_role(current_user,$1,'MEMBER') AS allowed,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relowner=r.oid) AS owns_tables FROM pg_roles r WHERE r.rolname=current_user",
    [expected],
  );
  const role = result.rows[0];
  if (
    !role ||
    !role.allowed ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreaterole ||
    role.owns_tables
  )
    throw new Error(
      'Unsafe runtime database role. Use its dedicated non-owner, non-BYPASSRLS login.',
    );
}
