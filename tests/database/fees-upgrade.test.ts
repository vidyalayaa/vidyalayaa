import { providerSessionSchema } from '../helpers/provider-sessions.js';
import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFileSync, readdirSync } from 'node:fs';
import { fixture } from '../helpers/database.js';
it('preserves old assessments and actual receipt numbers while labeling unreconciled historical balances', async () => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } }),
    migration = '20261023083655_fee_management.sql';
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    await db.exec(providerSessionSchema);
    const migrations = readdirSync('db/migrations').sort();
    for (const file of migrations.filter((x) => x < migration))
      await db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    const f = await fixture(db),
      id = crypto.randomUUID();
    await db.query(
      "INSERT INTO fee_records(id,school_id,student_id,academic_session_id,fee_type,amount_due,amount_paid,status,due_on) VALUES($1,$2,$3,$4,'Historical tuition',100,75,'PARTIAL','2026-01-31')",
      [id, f.schoolA, f.student, f.session],
    );
    await db.query(
      "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES($1,'USER',$2,'fee.payment_received','fee_records',$3,$4)",
      [
        f.schoolA,
        f.admin,
        id,
        {
          receipt: {
            receipt_no: 'REC-ORIGINAL-001',
            amount_paid_now: 50,
            payment_method: 'CASH',
            date: '2026-01-31',
          },
          amount_paid: 50,
          status: 'PARTIAL',
        },
      ],
    );
    // A historical manual overwrite must be reconciled before importing receipts.
    await db.query('UPDATE fee_records SET amount_paid=25 WHERE id=$1', [id]);
    await db.exec('BEGIN');
    await expect(db.exec(readFileSync('db/migrations/' + migration, 'utf8'))).rejects.toThrow(
      'LEGACY_FEE_RECONCILIATION_REQUIRED',
    );
    await db.exec('ROLLBACK');
    await db.query('UPDATE fee_records SET amount_paid=75 WHERE id=$1', [id]);
    const before = (
      await db.query(
        'SELECT id,school_id,student_id,academic_session_id,fee_type,amount_due,amount_paid,status,due_on,created_at,updated_at FROM fee_records ORDER BY id',
      )
    ).rows;
    await db.exec(readFileSync('db/migrations/' + migration, 'utf8'));
    for (const file of migrations.filter((x) => x > migration))
      await db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    expect(
      (
        await db.query(
          'SELECT id,school_id,student_id,academic_session_id,fee_type,amount_due,amount_paid,status,due_on,created_at,updated_at FROM fee_records ORDER BY id',
        )
      ).rows,
    ).toEqual(before);
    const payments = (
      await db.query<{
        receipt_no: string;
        amount: string;
        kind: string;
        receipt_snapshot: {
          legacy: boolean;
          payment_date: string | null;
          amount: string;
          balance_after: string;
        };
      }>('SELECT receipt_no,amount,kind,receipt_snapshot FROM fee_payments ORDER BY amount DESC')
    ).rows;
    expect(
      payments.map((p) => ({ receipt: p.receipt_no, amount: p.amount, kind: p.kind })),
    ).toEqual([
      { receipt: 'REC-ORIGINAL-001', amount: '50.00', kind: 'PAYMENT' },
      { receipt: 'OPENING-' + id, amount: '25.00', kind: 'OPENING' },
    ]);
    expect(payments.every((p) => p.receipt_snapshot.legacy)).toBe(true);
    expect(payments[0].receipt_snapshot.payment_date).toBe('2026-01-31');
    expect(payments[1].receipt_snapshot.payment_date).toBeNull();
    expect(typeof payments[1].receipt_snapshot.amount).toBe('string');
    expect(
      (
        await db.query(
          'SELECT sum(amount)::text AS paid FROM fee_payment_allocations WHERE fee_id=$1',
          [id],
        )
      ).rows[0],
    ).toEqual({ paid: '75.00' });
    expect(
      (
        await db.query(
          "SELECT has_table_privilege('authenticated','fee_payments','SELECT') AS browser,has_table_privilege('app_api','fee_payments','UPDATE') AS mutable,has_function_privilege('anon','app.fee_writer(uuid)','EXECUTE') AS helper",
        )
      ).rows[0],
    ).toEqual({ browser: false, mutable: false, helper: false });
  } finally {
    await db.close();
  }
});
