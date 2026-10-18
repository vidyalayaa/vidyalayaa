-- Explicit, non-production fixtures. No passwords, real children or device credentials.
BEGIN;
INSERT INTO schools(id,school_code,name,status) VALUES('10000000-0000-4000-8000-000000000001','DEV_A','Development School A','ACTIVE'),('10000000-0000-4000-8000-000000000002','DEV_B','Development School B','ACTIVE') ON CONFLICT(school_code) DO NOTHING;
INSERT INTO subscriptions(school_id,plan_id,status,current_period_end) SELECT s.id,p.id,'TRIALING',now()+interval '30 days' FROM schools s CROSS JOIN subscription_plans p WHERE s.school_code IN ('DEV_A','DEV_B') AND p.code='PROFESSIONAL' AND NOT EXISTS(SELECT FROM subscriptions x WHERE x.school_id=s.id);
INSERT INTO academic_sessions(school_id,name,starts_on,ends_on,is_current) SELECT id,'2026-27','2026-04-01','2027-03-31',true FROM schools WHERE school_code IN ('DEV_A','DEV_B') ON CONFLICT(school_id,name) DO NOTHING;
INSERT INTO classes(school_id,academic_session_id,grade,section) SELECT school_id,id,'8','A' FROM academic_sessions WHERE school_id IN ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002') ON CONFLICT DO NOTHING;
INSERT INTO subjects(school_id,code,name) SELECT id,'MAT','Mathematics' FROM schools WHERE school_code IN ('DEV_A','DEV_B') ON CONFLICT DO NOTHING;
COMMIT;
