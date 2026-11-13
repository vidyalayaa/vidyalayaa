CREATE TABLE academic_study_progress (
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  plan_id text NOT NULL CHECK (plan_id ~ '^[0-9a-f]{64}$'),
  task smallint NOT NULL CHECK (task BETWEEN 0 AND 20),
  PRIMARY KEY (school_id, student_id, plan_id, task),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE CASCADE
);
ALTER TABLE academic_study_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_study_progress FORCE ROW LEVEL SECURITY;
REVOKE ALL ON academic_study_progress FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON academic_study_progress TO app_api;
CREATE POLICY study_progress_read ON academic_study_progress FOR SELECT TO app_api
 USING (school_id=app.school_id() AND (
   app.school_role(school_id) IN ('school_admin','principal')
   OR app.parent_student_access(school_id,student_id)
   OR (app.school_role(school_id)='student' AND EXISTS (
     SELECT FROM students s WHERE (s.school_id,s.id)=(academic_study_progress.school_id,student_id)
       AND s.user_id=app.user_id() AND s.status='ACTIVE'
   ))
 ));
CREATE POLICY study_progress_add ON academic_study_progress FOR INSERT TO app_api
 WITH CHECK (school_id=app.school_id() AND app.school_role(school_id)='student' AND EXISTS (
   SELECT FROM students s WHERE (s.school_id,s.id)=(academic_study_progress.school_id,student_id)
     AND s.user_id=app.user_id() AND s.status='ACTIVE'
 ));
CREATE POLICY study_progress_remove ON academic_study_progress FOR DELETE TO app_api
 USING (school_id=app.school_id() AND app.school_role(school_id)='student' AND EXISTS (
   SELECT FROM students s WHERE (s.school_id,s.id)=(academic_study_progress.school_id,student_id)
     AND s.user_id=app.user_id() AND s.status='ACTIVE'
 ));

-- Academic reads are separate from the exam/mark entry policies. This projection
-- allows subject teachers to read their slice of published official exams.
CREATE FUNCTION app.published_academic_marks(sid uuid, learner uuid DEFAULT NULL)
RETURNS TABLE(exam_id uuid,student_id uuid,subject_id uuid,subject text,score double precision,maximum double precision,remarks text,
 class_id uuid,grade text,section text,session_id uuid,session_name text,exam text,exam_type text,kind text,exam_date date,starts_on date,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT ex.id,m.student_id,m.subject_id,sub.name,m.score::float8,ex.max_score::float8,m.remarks,
 c.id,c.grade,c.section,ac.id,ac.name,ex.name,ex.exam_type,ex.assessment_kind,
 coalesce(ex.starts_on,(ex.created_at AT TIME ZONE sc.timezone)::date),ex.starts_on,ex.created_at
 FROM marks m JOIN exams ex ON (ex.school_id,ex.id)=(m.school_id,m.exam_id)
 JOIN subjects sub ON (sub.school_id,sub.id)=(m.school_id,m.subject_id)
 JOIN students s ON (s.school_id,s.id)=(m.school_id,m.student_id)
 JOIN classes c ON (c.school_id,c.id)=(ex.school_id,ex.class_id)
 JOIN academic_sessions ac ON (ac.school_id,ac.id)=(c.school_id,c.academic_session_id)
 JOIN schools sc ON sc.id=m.school_id
 WHERE sid=app.school_id() AND m.school_id=sid AND (learner IS NULL OR m.student_id=learner)
 AND ex.status='PUBLISHED' AND ex.retired_at IS NULL
 AND (ex.assessment_kind='OFFICIAL' OR ex.subject_id=m.subject_id)
 AND CASE app.school_role(sid)
   WHEN 'student' THEN s.user_id=app.user_id() AND s.status='ACTIVE'
   WHEN 'parent' THEN app.parent_student_access(sid,s.id)
   WHEN 'teacher' THEN app.teacher_student_access(sid,s.id)
     AND (app.is_class_teacher(sid,c.id) OR app.teacher_assigned(sid,c.id,m.subject_id))
   WHEN 'principal' THEN true
   WHEN 'school_admin' THEN true
   ELSE current_setting('app.actor_type',true)='SUPPORT' AND app.is_platform_staff() AND EXISTS (
     SELECT FROM support_access_grants g WHERE g.school_id=sid AND g.staff_user_id=app.user_id()
       AND g.approved_by IS NOT NULL AND g.starts_at<=now() AND g.expires_at>now()
       AND g.revoked_at IS NULL AND g.scope ? 'marks'
   )
 END
$$;
REVOKE ALL ON FUNCTION app.published_academic_marks(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.published_academic_marks(uuid,uuid) TO app_api;

-- Only exam-level counts, used to identify incomplete reports. The selected
-- examination must already be visible through a learner's authorized marks.
CREATE FUNCTION app.academic_expected_subjects(sid uuid, learner uuid, examination uuid)
RETURNS TABLE(subject_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT m.subject_id,s.name FROM marks m
 JOIN exams e ON (e.school_id,e.id)=(m.school_id,m.exam_id)
 JOIN subjects s ON (s.school_id,s.id)=(m.school_id,m.subject_id)
 WHERE learner IS NOT NULL AND m.school_id=sid AND m.exam_id=examination
 AND (e.assessment_kind='OFFICIAL' OR e.subject_id=m.subject_id) AND EXISTS (
   SELECT FROM app.published_academic_marks(sid,learner) a WHERE a.exam_id=examination
 ) AND (app.school_role(sid)<>'teacher'
   OR EXISTS (SELECT FROM exams ex WHERE (ex.school_id,ex.id)=(sid,examination)
     AND (app.is_class_teacher(sid,ex.class_id) OR app.teacher_assigned(sid,ex.class_id,m.subject_id))))
$$;
REVOKE ALL ON FUNCTION app.academic_expected_subjects(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.academic_expected_subjects(uuid,uuid,uuid) TO app_api;

CREATE TABLE academic_study_plans (
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  plan_id text NOT NULL CHECK (plan_id ~ '^[0-9a-f]{64}$'),
  advice jsonb NOT NULL,
  PRIMARY KEY (school_id, student_id, plan_id),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE CASCADE
);
ALTER TABLE academic_study_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_study_plans FORCE ROW LEVEL SECURITY;
REVOKE ALL ON academic_study_plans FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON academic_study_plans TO app_api;
CREATE POLICY study_plan_access ON academic_study_plans TO app_api
 USING (school_id=app.school_id() AND (
   app.school_role(school_id) IN ('school_admin','principal')
   OR app.parent_student_access(school_id,student_id)
   OR (app.school_role(school_id)='student' AND EXISTS (
     SELECT FROM students s WHERE (s.school_id,s.id)=(academic_study_plans.school_id,student_id)
       AND s.user_id=app.user_id() AND s.status='ACTIVE'
   ))
 ));
ALTER TABLE academic_study_progress ADD FOREIGN KEY (school_id,student_id,plan_id)
 REFERENCES academic_study_plans(school_id,student_id,plan_id) ON DELETE CASCADE;

-- Return the selected learner's rank and sufficiently large subject aggregates.
-- Peers' individual scores and identifiers are never returned to family accounts.
CREATE FUNCTION app.academic_benchmarks(sid uuid, learner uuid, examination uuid)
RETURNS TABLE(class_rank integer,class_tied boolean,school_rank integer,school_tied boolean,averages jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH target AS (
   SELECT e.*,c.academic_session_id,app.school_role(sid) AS role,
     (app.school_role(sid)<>'teacher' OR app.is_class_teacher(sid,e.class_id)) AS full_report,
     (sc.settings->'share_result_class_averages'='true'::jsonb
       OR app.school_role(sid) IN ('teacher','principal','school_admin')) AS may_compare
   FROM exams e JOIN classes c ON (c.school_id,c.id)=(e.school_id,e.class_id)
   JOIN schools sc ON sc.id=e.school_id
   WHERE learner IS NOT NULL AND e.school_id=sid AND e.id=examination AND EXISTS (
     SELECT FROM app.published_academic_marks(sid,learner) a WHERE a.exam_id=examination
   )
 ), peers AS (
   SELECT e.id,e.class_id,count(*) OVER (PARTITION BY e.class_id) AS copies
   FROM target t JOIN exams e ON e.school_id=t.school_id AND e.assessment_kind=t.assessment_kind
     AND e.exam_type=t.exam_type AND e.retired_at IS NULL
     AND lower(regexp_replace(trim(e.name),'[[:space:]]+',' ','g'))=lower(regexp_replace(trim(t.name),'[[:space:]]+',' ','g'))
   JOIN classes c ON (c.school_id,c.id)=(e.school_id,e.class_id) AND c.academic_session_id=t.academic_session_id
   LEFT JOIN subjects es ON (es.school_id,es.id)=(e.school_id,e.subject_id)
   LEFT JOIN subjects ts ON (ts.school_id,ts.id)=(t.school_id,t.subject_id)
   WHERE t.assessment_kind='OFFICIAL' OR lower(trim(es.name))=lower(trim(ts.name))
 ), ranked_exams AS (
   SELECT e.id,e.max_score,e.assessment_kind,e.subject_id FROM target t
   JOIN peers p ON p.id=t.id OR (p.copies=1 AND EXISTS (SELECT FROM peers own WHERE own.id=t.id AND own.copies=1))
   JOIN exams e ON (e.school_id,e.id)=(t.school_id,p.id)
   WHERE e.status='PUBLISHED' AND t.full_report
 ), scores AS (
   SELECT e.id,m.student_id,round(100*sum(m.score)/(count(*)*e.max_score),2) AS percentage
   FROM ranked_exams e JOIN marks m ON m.school_id=sid AND m.exam_id=e.id
   WHERE e.assessment_kind='OFFICIAL' OR e.subject_id=m.subject_id
   GROUP BY e.id,m.student_id,e.max_score,e.assessment_kind,e.subject_id
   HAVING count(*)=(SELECT count(DISTINCT other.subject_id) FROM marks other WHERE other.school_id=sid AND other.exam_id=e.id
     AND (e.assessment_kind='OFFICIAL' OR e.subject_id=other.subject_id))
 ), class_positions AS (
   SELECT s.*,rank() OVER (ORDER BY s.percentage DESC)::int AS position,
     count(*) OVER (PARTITION BY s.percentage)>1 AS tied FROM scores s WHERE s.id=examination
 ), eligible AS (
   SELECT s.*,count(*) OVER (PARTITION BY s.student_id) AS copies FROM scores s
 ), school_positions AS (
   SELECT s.*,rank() OVER (ORDER BY s.percentage DESC)::int AS position,
     count(*) OVER (PARTITION BY s.percentage)>1 AS tied FROM eligible s WHERE s.copies=1
 ), subject_averages AS (
   SELECT m.subject_id,round(avg(100*m.score/t.max_score),2) AS percentage
   FROM target t JOIN marks m ON (m.school_id,m.exam_id)=(t.school_id,t.id)
   WHERE t.may_compare AND (t.assessment_kind='OFFICIAL' OR t.subject_id=m.subject_id)
   AND (t.role<>'teacher' OR t.full_report OR app.teacher_assigned(sid,t.class_id,m.subject_id))
   GROUP BY m.subject_id HAVING count(*)>=5
     OR bool_or(t.role IN ('teacher','principal','school_admin'))
 )
 SELECT c.position,coalesce(c.tied,false),CASE WHEN t.role<>'teacher' THEN s.position END,coalesce(s.tied,false),
   coalesce((SELECT jsonb_object_agg(a.subject_id,a.percentage) FROM subject_averages a),'{}'::jsonb)
 FROM target t LEFT JOIN class_positions c ON c.student_id=learner
 LEFT JOIN school_positions s ON s.student_id=learner AND s.id=t.id
$$;
REVOKE ALL ON FUNCTION app.academic_benchmarks(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.academic_benchmarks(uuid,uuid,uuid) TO app_api;

-- Keep the existing fail-closed erasure manifest in sync with the new tables.
CREATE OR REPLACE FUNCTION app.school_erasure_relations() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE
 relations text[]:=ARRAY[
  'academic_study_progress','academic_study_plans',
  'academic_promotions','announcements','api_idempotency_keys','assignments',
  'attendance_corrections','attendance_reconciliation_requests','audit_logs','device_configurations',
  'device_credentials','device_heartbeats','device_logs','device_ota_assignments',
  'device_ota_status','enrollments','fee_payment_allocations','fee_payment_reversals',
  'fee_structure_sections','job_runs','marks','notification_attempts',
  'notification_preferences','notification_recipient_targets','platform_notices','push_delivery_targets',
  'report_documents','school_exports','school_holidays','school_invitations',
  'school_memberships','school_notification_settings','school_offboarding','school_person_details',
  'school_profile_assets','school_profile_private','school_usage_snapshots','student_parents',
  'subscription_events','support_requests','teacher_class_assignments','timetable_entries',
  'daily_attendance','exams','fee_payments','fee_records',
  'notification_deliveries','push_tokens','subscriptions','support_access_grants',
  'attendance_rule_versions','fee_structure_items','fee_transport_assignments','notification_outbox',
  'parents','subjects','attendance_events','fee_structures',
  'fee_transport_routes','devices','nfc_cards','device_locations',
  'students','classes','academic_sessions','teachers'
 ];
BEGIN
 IF EXISTS(SELECT FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE c.relnamespace IN ('public'::regnamespace,'app'::regnamespace)
  AND c.relkind IN ('r','p') AND a.attname='school_id' AND NOT a.attisdropped
  AND NOT ((c.relnamespace='public'::regnamespace AND c.relname::text=ANY(relations))
    OR (c.relnamespace='app'::regnamespace
      AND c.relname IN ('school_security_policy_versions','platform_daily_notifications','school_deletion_audit'))))
 THEN RAISE EXCEPTION 'SCHOOL_ERASURE_SCHEMA_CHANGED'; END IF;
 RETURN relations;
END $$;
