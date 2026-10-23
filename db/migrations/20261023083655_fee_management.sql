-- Reuse fee_records as student installment assessments. Existing amounts and IDs
-- are retained; posted payments become an append-only, balanced ledger.
-- Refuse inconsistent historical totals rather than omit an original receipt.
DO $$ BEGIN
 IF EXISTS(SELECT FROM fee_records f WHERE f.amount_paid < (
   SELECT coalesce(sum(CASE WHEN jsonb_typeof(a.after->'receipt'->'amount_paid_now')='number'
     THEN (a.after->'receipt'->>'amount_paid_now')::numeric ELSE 0 END),0)
   FROM audit_logs a WHERE a.school_id=f.school_id AND a.entity_id=f.id
     AND a.action='fee.payment_received')) THEN
   RAISE EXCEPTION 'LEGACY_FEE_RECONCILIATION_REQUIRED' USING ERRCODE='23514';
 END IF;
END $$;
INSERT INTO roles(code,name) VALUES('finance_staff','Finance staff');
INSERT INTO role_permissions SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code='finance_staff' AND p.code IN ('fees.read','fees.write');
ALTER TABLE teachers DROP CONSTRAINT teachers_staff_role_check;
ALTER TABLE teachers ADD CONSTRAINT teachers_staff_role_check CHECK(staff_role IN ('teacher','principal','school_admin','finance_staff'));
ALTER TABLE school_invitations DROP CONSTRAINT invitation_record_role;
ALTER TABLE school_invitations ADD CONSTRAINT invitation_record_role CHECK(
 num_nonnulls(student_id,parent_id,teacher_id)<=1 AND (student_id IS NULL OR role_code='student')
 AND (parent_id IS NULL OR role_code='parent') AND (teacher_id IS NULL OR role_code IN ('teacher','principal','school_admin','finance_staff'))
 AND (NOT bootstrap_administrator OR (role_code='school_admin' AND num_nonnulls(student_id,parent_id,teacher_id)=0)));
-- Extend the existing record-bound invitation functions, preserving their checks,
-- private-schema privileges and exact record binding; no parallel auth system.
DO $$ DECLARE f regprocedure; def text; BEGIN
 FOREACH f IN ARRAY ARRAY['app.invitation_record(uuid,text,uuid,text)'::regprocedure,'app.begin_school_invitation(uuid,text,text,text,boolean,uuid)'::regprocedure,'app.begin_unbound_school_invitation(uuid,text,text,text,boolean)'::regprocedure] LOOP
  def:=pg_get_functiondef(f);
  def:=replace(def,'''teacher'',''principal'',''school_admin''','''teacher'',''principal'',''school_admin'',''finance_staff''');
  def:=replace(def,'''school_admin'',''principal'',''teacher'',''parent'',''student''','''school_admin'',''principal'',''teacher'',''parent'',''student'',''finance_staff''');
  EXECUTE def;
 END LOOP;
END $$;
CREATE FUNCTION app.fee_writer(sid uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND app.school_role(sid) IN ('school_admin','finance_staff')
$$;
CREATE FUNCTION app.fee_student_visible(sid uuid,student uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT sid=app.school_id() AND (app.school_role(sid) IN ('school_admin','finance_staff','principal') OR
 (app.school_role(sid)='student' AND EXISTS(SELECT FROM students s WHERE s.school_id=sid AND s.id=student AND s.user_id=app.user_id() AND s.status='ACTIVE')) OR
 (app.school_role(sid)='parent' AND EXISTS(SELECT FROM parents p JOIN student_parents sp ON sp.school_id=p.school_id AND sp.parent_id=p.id JOIN students s ON s.school_id=sp.school_id AND s.id=sp.student_id WHERE p.school_id=sid AND p.user_id=app.user_id() AND p.status='ACTIVE' AND sp.status='ACTIVE' AND s.status='ACTIVE' AND sp.student_id=student)) OR
 (current_setting('app.actor_type',true)='SUPPORT' AND app.is_platform_staff() AND EXISTS(SELECT FROM support_access_grants g JOIN users u ON u.id=g.staff_user_id WHERE g.school_id=sid AND g.staff_user_id=app.user_id() AND u.status='ACTIVE' AND g.approved_by IS NOT NULL AND g.starts_at<=now() AND g.expires_at>now() AND g.revoked_at IS NULL AND g.scope @> '["fees"]'::jsonb)))
$$;
REVOKE ALL ON FUNCTION app.fee_writer(uuid),app.fee_student_visible(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.fee_writer(uuid),app.fee_student_visible(uuid,uuid) TO app_api;
CREATE FUNCTION app.lock_fee_account(sid uuid,student uuid,year_id uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT app.fee_writer(sid) THEN RAISE EXCEPTION 'FEE_WRITE_DENIED' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(sid::text||':fee-account:'||student::text||':'||year_id::text,0));
END $$;
REVOKE ALL ON FUNCTION app.lock_fee_account(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.lock_fee_account(uuid,uuid,uuid) TO app_api;

CREATE TABLE fee_structures(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),academic_session_id uuid NOT NULL,grade text NOT NULL CHECK(length(grade) BETWEEN 1 AND 80),mode text NOT NULL CHECK(mode IN ('SAME','SECTION')),version integer NOT NULL CHECK(version>0),created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,academic_session_id,grade,version),FOREIGN KEY(school_id,academic_session_id) REFERENCES academic_sessions(school_id,id));
CREATE TABLE fee_structure_sections(school_id uuid NOT NULL,structure_id uuid NOT NULL,class_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),UNIQUE(school_id,id),PRIMARY KEY(school_id,structure_id,class_id),FOREIGN KEY(school_id,structure_id) REFERENCES fee_structures(school_id,id),FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id));
CREATE TABLE fee_structure_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL,structure_id uuid NOT NULL,class_id uuid,category text NOT NULL CHECK(category IN ('TUITION','ADMISSION','EXAMINATION','ANNUAL','OTHER')),label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 100),amount numeric(12,2) NOT NULL CHECK(amount>0),frequency text NOT NULL CHECK(frequency IN ('MONTHLY','QUARTERLY','HALF_YEARLY','ANNUAL','ONE_TIME')),first_due_on date NOT NULL,UNIQUE(school_id,id),FOREIGN KEY(school_id,structure_id) REFERENCES fee_structures(school_id,id),FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id));
CREATE UNIQUE INDEX fee_item_identity ON fee_structure_items(school_id,structure_id,coalesce(class_id,'00000000-0000-0000-0000-000000000000'),category,lower(label));
CREATE INDEX fee_item_structure ON fee_structure_items(school_id,structure_id);
CREATE INDEX fee_sections_class ON fee_structure_sections(school_id,class_id);
CREATE TABLE fee_transport_routes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 150),description text NOT NULL DEFAULT '',active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id));
CREATE UNIQUE INDEX fee_route_name ON fee_transport_routes(school_id,lower(name));
CREATE TABLE fee_transport_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL,student_id uuid NOT NULL,academic_session_id uuid NOT NULL,route_id uuid NOT NULL,amount numeric(12,2) NOT NULL CHECK(amount>0),frequency text NOT NULL CHECK(frequency IN ('MONTHLY','QUARTERLY','HALF_YEARLY','ANNUAL','ONE_TIME')),starts_on date NOT NULL,ends_on date NOT NULL CHECK(ends_on>=starts_on),first_due_on date NOT NULL CHECK(first_due_on BETWEEN starts_on AND ends_on),ended_on date,end_reason text,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),FOREIGN KEY(school_id,academic_session_id) REFERENCES academic_sessions(school_id,id),FOREIGN KEY(school_id,route_id) REFERENCES fee_transport_routes(school_id,id),CHECK((ended_on IS NULL AND end_reason IS NULL) OR (ended_on BETWEEN starts_on AND ends_on AND length(btrim(end_reason))>=5)));
ALTER TABLE fee_transport_assignments ADD CONSTRAINT transport_no_overlap EXCLUDE USING gist(school_id WITH =,student_id WITH =,academic_session_id WITH =,daterange(starts_on,coalesce(ended_on,ends_on),'[]') WITH &&);
CREATE INDEX fee_transport_student ON fee_transport_assignments(school_id,student_id,academic_session_id);
CREATE INDEX fee_transport_route ON fee_transport_assignments(school_id,route_id);
ALTER TABLE fee_records ADD COLUMN class_id uuid,ADD COLUMN structure_item_id uuid,ADD COLUMN transport_assignment_id uuid,ADD COLUMN category text NOT NULL DEFAULT 'OTHER' CHECK(category IN ('TUITION','ADMISSION','EXAMINATION','ANNUAL','OTHER','TRANSPORT')),ADD COLUMN installment_label text,ADD COLUMN assessment_key text,ADD COLUMN voided_at timestamptz,ADD COLUMN void_reason text,ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE fee_records ADD CONSTRAINT fee_class_school FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id),ADD CONSTRAINT fee_item_school FOREIGN KEY(school_id,structure_item_id) REFERENCES fee_structure_items(school_id,id),ADD CONSTRAINT fee_transport_school FOREIGN KEY(school_id,transport_assignment_id) REFERENCES fee_transport_assignments(school_id,id),ADD CONSTRAINT fee_void_reason CHECK((voided_at IS NULL AND void_reason IS NULL) OR (voided_at IS NOT NULL AND length(btrim(void_reason))>=5 AND amount_paid=0 AND status='WAIVED')),ADD CONSTRAINT fee_source CHECK(num_nonnulls(structure_item_id,transport_assignment_id)<=1 AND (transport_assignment_id IS NULL OR category='TRANSPORT'));
CREATE UNIQUE INDEX fee_assessment_identity ON fee_records(school_id,assessment_key) WHERE voided_at IS NULL;
CREATE INDEX fee_year_student ON fee_records(school_id,academic_session_id,student_id,due_on);
CREATE INDEX fee_class_category ON fee_records(school_id,class_id,category,due_on);
CREATE INDEX fee_item_ref ON fee_records(school_id,structure_item_id) WHERE structure_item_id IS NOT NULL;
CREATE INDEX fee_transport_ref ON fee_records(school_id,transport_assignment_id) WHERE transport_assignment_id IS NOT NULL;
CREATE TABLE fee_payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL,student_id uuid NOT NULL,academic_session_id uuid NOT NULL,receipt_no text NOT NULL DEFAULT ('REC-'||gen_random_uuid()) CHECK(length(receipt_no) BETWEEN 1 AND 100),payment_date date NOT NULL,amount numeric(12,2) NOT NULL CHECK(amount>0),currency char(3) NOT NULL,payment_method text NOT NULL CHECK(payment_method IN ('CASH','UPI','BANK_TRANSFER','CARD','CHEQUE','OTHER')),reference text NOT NULL DEFAULT '',note text NOT NULL DEFAULT '',recorded_by uuid REFERENCES users(id),kind text NOT NULL DEFAULT 'PAYMENT' CHECK(kind IN ('PAYMENT','OPENING')),receipt_snapshot jsonb NOT NULL,idempotency_key text,request_hash text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,recorded_by,idempotency_key),FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id),FOREIGN KEY(school_id,academic_session_id) REFERENCES academic_sessions(school_id,id));
CREATE UNIQUE INDEX fee_receipt_unique ON fee_payments(school_id,lower(receipt_no));
CREATE INDEX fee_payment_student ON fee_payments(school_id,student_id,academic_session_id,payment_date);
CREATE INDEX fee_payment_year ON fee_payments(school_id,academic_session_id,payment_date);
CREATE TABLE fee_payment_allocations(school_id uuid NOT NULL,payment_id uuid NOT NULL,fee_id uuid NOT NULL,amount numeric(12,2) NOT NULL CHECK(amount>0),id uuid NOT NULL DEFAULT gen_random_uuid(),UNIQUE(school_id,id),PRIMARY KEY(school_id,payment_id,fee_id),FOREIGN KEY(school_id,payment_id) REFERENCES fee_payments(school_id,id),FOREIGN KEY(school_id,fee_id) REFERENCES fee_records(school_id,id));
CREATE INDEX fee_allocation_assessment ON fee_payment_allocations(school_id,fee_id,payment_id);
CREATE TABLE fee_payment_reversals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL,payment_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 1000),recorded_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(school_id,id),UNIQUE(school_id,payment_id),FOREIGN KEY(school_id,payment_id) REFERENCES fee_payments(school_id,id));

-- Preserve actual pre-ledger receipts where the audit reconciles with the old
-- balance; any residual is explicitly labelled as an opening balance, not a
-- fabricated dated cash transaction. All old audit records remain untouched.
DO $$ DECLARE f fee_records;a record;remaining numeric;pid uuid;snapshot jsonb;label text;paid_date date; BEGIN
 FOR f IN SELECT * FROM fee_records WHERE amount_paid>0 LOOP
  remaining:=f.amount_paid;
  FOR a IN SELECT * FROM audit_logs WHERE school_id=f.school_id AND entity_id=f.id AND action='fee.payment_received' ORDER BY occurred_at,id LOOP
   IF jsonb_typeof(a.after->'receipt'->'amount_paid_now')='number' AND (a.after->'receipt'->>'amount_paid_now')::numeric>0 AND (a.after->'receipt'->>'amount_paid_now')::numeric<=remaining AND coalesce(a.after->'receipt'->>'receipt_no','')<>'' THEN
    paid_date:=CASE WHEN a.after->'receipt'->>'date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (a.after->'receipt'->>'date')::date WHEN a.after->'receipt'->>'date' ~ '^\d{4}-\d{2}-\d{2}T' THEN ((a.after->'receipt'->>'date')::timestamptz AT TIME ZONE (SELECT timezone FROM schools WHERE id=f.school_id))::date ELSE (a.occurred_at AT TIME ZONE (SELECT timezone FROM schools WHERE id=f.school_id))::date END;
    snapshot:=jsonb_build_object('legacy',true,'school_name',(SELECT name FROM schools WHERE id=f.school_id),'student_name',(SELECT concat_ws(' ',first_name,last_name) FROM students WHERE id=f.student_id),'student_code',(SELECT student_code FROM students WHERE id=f.student_id),'academic_year',(SELECT name FROM academic_sessions WHERE id=f.academic_session_id),'receipt_no',a.after->'receipt'->>'receipt_no','payment_date',paid_date,'payment_method',a.after->'receipt'->>'payment_method','currency',f.currency,'amount',a.after->'receipt'->>'amount_paid_now','balance_after',greatest(f.amount_due-coalesce((a.after->>'amount_paid')::numeric,0),0),'lines',jsonb_build_array(jsonb_build_object('label',f.fee_type,'installment',f.due_on,'amount',a.after->'receipt'->>'amount_paid_now')));
    snapshot:=snapshot||jsonb_build_object('amount',snapshot->>'amount','balance_after',snapshot->>'balance_after','recorded_by',coalesce((SELECT full_name FROM users WHERE id=a.actor_id),'Historical record'),'class_label',NULL,'roll_number',NULL,'reference','','note',coalesce(a.after->'receipt'->>'note',''));
    INSERT INTO fee_payments(school_id,student_id,academic_session_id,receipt_no,payment_date,amount,currency,payment_method,note,recorded_by,receipt_snapshot)
    VALUES(f.school_id,f.student_id,f.academic_session_id,a.after->'receipt'->>'receipt_no',paid_date,(a.after->'receipt'->>'amount_paid_now')::numeric,f.currency,CASE WHEN a.after->'receipt'->>'payment_method' IN ('CASH','UPI','BANK_TRANSFER','CARD','CHEQUE','OTHER') THEN a.after->'receipt'->>'payment_method' ELSE 'OTHER' END,coalesce(a.after->'receipt'->>'note',''),(SELECT id FROM users WHERE id=a.actor_id),snapshot) RETURNING id INTO pid;
    INSERT INTO fee_payment_allocations(school_id,payment_id,fee_id,amount) VALUES(f.school_id,pid,f.id,(a.after->'receipt'->>'amount_paid_now')::numeric);remaining:=remaining-(a.after->'receipt'->>'amount_paid_now')::numeric;
   END IF;
  END LOOP;
  IF remaining>0 THEN
   label:='OPENING-'||f.id;
   INSERT INTO fee_payments(school_id,student_id,academic_session_id,receipt_no,payment_date,amount,currency,payment_method,kind,note,receipt_snapshot)
   VALUES(f.school_id,f.student_id,f.academic_session_id,label,(f.created_at AT TIME ZONE 'UTC')::date,remaining,f.currency,'OTHER','OPENING','Historical paid balance; original payment date and method unavailable',jsonb_build_object('legacy',true,'receipt_no',label,'school_name',(SELECT name FROM schools WHERE id=f.school_id),'student_name',(SELECT concat_ws(' ',first_name,last_name) FROM students WHERE id=f.student_id),'student_code',(SELECT student_code FROM students WHERE id=f.student_id),'academic_year',(SELECT name FROM academic_sessions WHERE id=f.academic_session_id),'currency',f.currency,'amount',remaining::text,'balance_after',(f.amount_due-f.amount_paid)::text,'payment_method','OTHER','payment_date',null,'recorded_by','Historical record','class_label',null,'roll_number',null,'reference','','note','Historical opening balance; this is not a newly collected payment.','lines',jsonb_build_array(jsonb_build_object('label',f.fee_type,'installment',f.due_on,'amount',remaining::text)))) RETURNING id INTO pid;
   INSERT INTO fee_payment_allocations(school_id,payment_id,fee_id,amount) VALUES(f.school_id,pid,f.id,remaining);
  END IF;
 END LOOP;
END $$;

-- Private runtime RLS. Parents/students cannot reach other students even by SQL.
CREATE POLICY fee_read_scope ON fee_records AS RESTRICTIVE FOR SELECT TO app_api USING(app.fee_student_visible(school_id,student_id));
CREATE POLICY fee_insert_scope ON fee_records AS RESTRICTIVE FOR INSERT TO app_api WITH CHECK(app.fee_writer(school_id));
CREATE POLICY fee_update_scope ON fee_records AS RESTRICTIVE FOR UPDATE TO app_api USING(app.fee_writer(school_id)) WITH CHECK(app.fee_writer(school_id));
CREATE POLICY fee_delete_scope ON fee_records AS RESTRICTIVE FOR DELETE TO app_api USING(false);
DO $$ DECLARE t text;has_student boolean; BEGIN
 FOREACH t IN ARRAY ARRAY['fee_structures','fee_structure_sections','fee_structure_items','fee_transport_routes','fee_transport_assignments','fee_payments','fee_payment_allocations','fee_payment_reversals'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated,app_device,app_platform',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO app_api',t);EXECUTE format('GRANT SELECT ON %I TO app_worker',t);
  EXECUTE format('CREATE POLICY tenant ON %I TO app_api,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id())',t);
  IF t IN ('fee_payments','fee_transport_assignments') THEN
   EXECUTE format('CREATE POLICY visible ON %I AS RESTRICTIVE FOR SELECT TO app_api USING(app.fee_student_visible(school_id,student_id))',t);
  ELSIF t IN ('fee_payment_allocations','fee_payment_reversals') THEN
   EXECUTE format('CREATE POLICY visible ON %I AS RESTRICTIVE FOR SELECT TO app_api USING(EXISTS(SELECT FROM fee_payments p WHERE p.school_id=%I.school_id AND p.id=%I.payment_id))',t,t,t);
  ELSE
   EXECUTE format('CREATE POLICY visible ON %I AS RESTRICTIVE FOR SELECT TO app_api USING(app.school_role(school_id) IN (''school_admin'',''finance_staff'',''principal''))',t);
  END IF;
  EXECUTE format('CREATE POLICY writer ON %I AS RESTRICTIVE FOR INSERT TO app_api WITH CHECK(app.fee_writer(school_id))',t);
  EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.audit_change()',t);
 END LOOP;
END $$;
GRANT UPDATE ON fee_transport_routes,fee_transport_assignments TO app_api;
CREATE POLICY route_update ON fee_transport_routes AS RESTRICTIVE FOR UPDATE TO app_api USING(app.fee_writer(school_id)) WITH CHECK(app.fee_writer(school_id));
CREATE POLICY transport_end ON fee_transport_assignments AS RESTRICTIVE FOR UPDATE TO app_api USING(app.fee_writer(school_id)) WITH CHECK(app.fee_writer(school_id));

CREATE FUNCTION app.fee_record_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ta fee_transport_assignments;it fee_structure_items;st fee_structures; BEGIN
 IF current_user<>'app_api' THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NOT app.fee_writer(CASE WHEN TG_OP='DELETE' THEN OLD.school_id ELSE NEW.school_id END) THEN RAISE EXCEPTION 'FEE_WRITE_DENIED' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'FEE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM app.lock_fee_account(NEW.school_id,NEW.student_id,NEW.academic_session_id);
  IF NEW.amount_paid<>0 OR NEW.status NOT IN ('UNPAID','WAIVED') THEN RAISE EXCEPTION 'FEE_LEDGER_REQUIRED' USING ERRCODE='23514';END IF;
  NEW.created_by:=app.user_id();
 ELSIF pg_trigger_depth()=1 THEN
  IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid OR NEW.status IS DISTINCT FROM OLD.status AND NOT(NEW.status='WAIVED' AND OLD.amount_paid=0 AND NEW.voided_at IS NOT NULL) THEN RAISE EXCEPTION 'FEE_LEDGER_REQUIRED' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT FROM fee_payment_allocations WHERE school_id=OLD.school_id AND fee_id=OLD.id) AND ROW(NEW.student_id,NEW.academic_session_id,NEW.amount_due,NEW.fee_type,NEW.due_on,NEW.currency,NEW.class_id,NEW.category,NEW.structure_item_id,NEW.transport_assignment_id,NEW.assessment_key) IS DISTINCT FROM ROW(OLD.student_id,OLD.academic_session_id,OLD.amount_due,OLD.fee_type,OLD.due_on,OLD.currency,OLD.class_id,OLD.category,OLD.structure_item_id,OLD.transport_assignment_id,OLD.assessment_key) THEN RAISE EXCEPTION 'FEE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF OLD.voided_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'FEE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF num_nonnulls(OLD.structure_item_id,OLD.transport_assignment_id)>0 AND ROW(NEW.student_id,NEW.academic_session_id,NEW.amount_due,NEW.fee_type,NEW.due_on,NEW.currency,NEW.class_id,NEW.category,NEW.structure_item_id,NEW.transport_assignment_id,NEW.assessment_key,NEW.installment_label) IS DISTINCT FROM ROW(OLD.student_id,OLD.academic_session_id,OLD.amount_due,OLD.fee_type,OLD.due_on,OLD.currency,OLD.class_id,OLD.category,OLD.structure_item_id,OLD.transport_assignment_id,OLD.assessment_key,OLD.installment_label) THEN RAISE EXCEPTION 'FEE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.class_id IS NOT NULL AND NOT EXISTS(SELECT FROM classes c WHERE c.school_id=NEW.school_id AND c.id=NEW.class_id AND c.academic_session_id=NEW.academic_session_id) THEN RAISE EXCEPTION 'FEE_CLASS_INVALID' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' AND NEW.structure_item_id IS NOT NULL THEN
  SELECT * INTO it FROM fee_structure_items WHERE school_id=NEW.school_id AND id=NEW.structure_item_id;
  SELECT * INTO st FROM fee_structures WHERE school_id=NEW.school_id AND id=it.structure_id;
  IF st.academic_session_id IS DISTINCT FROM NEW.academic_session_id OR it.category<>NEW.category OR it.label<>NEW.fee_type OR it.amount<>NEW.amount_due OR NEW.currency<>'INR' OR NEW.class_id IS NULL OR NOT EXISTS(SELECT FROM fee_structure_sections sec JOIN enrollments e ON e.school_id=sec.school_id AND e.class_id=sec.class_id WHERE sec.school_id=NEW.school_id AND sec.structure_id=st.id AND sec.class_id=NEW.class_id AND (it.class_id IS NULL OR it.class_id=sec.class_id) AND e.student_id=NEW.student_id AND e.academic_session_id=NEW.academic_session_id AND e.status='ACTIVE' AND NEW.due_on BETWEEN e.starts_on AND coalesce(e.ends_on,'infinity'::date)) THEN RAISE EXCEPTION 'FEE_STRUCTURE_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.transport_assignment_id IS NOT NULL THEN
  SELECT * INTO ta FROM fee_transport_assignments WHERE school_id=NEW.school_id AND id=NEW.transport_assignment_id;
  IF ta.student_id IS DISTINCT FROM NEW.student_id OR ta.academic_session_id<>NEW.academic_session_id OR NEW.due_on NOT BETWEEN ta.starts_on AND coalesce(ta.ended_on,ta.ends_on) OR NEW.amount_due<>ta.amount THEN RAISE EXCEPTION 'FEE_TRANSPORT_INVALID' USING ERRCODE='23514';END IF;
 ELSIF NEW.category='TRANSPORT' THEN RAISE EXCEPTION 'FEE_TRANSPORT_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fee_record_guard BEFORE INSERT OR UPDATE OR DELETE ON fee_records FOR EACH ROW EXECUTE FUNCTION app.fee_record_guard();
CREATE FUNCTION app.fee_refresh(sid uuid,fid uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE paid numeric;BEGIN
 SELECT coalesce(sum(a.amount),0) INTO paid FROM fee_payment_allocations a WHERE a.school_id=sid AND a.fee_id=fid AND NOT EXISTS(SELECT FROM fee_payment_reversals r WHERE r.school_id=a.school_id AND r.payment_id=a.payment_id);
 UPDATE fee_records SET amount_paid=paid,status=CASE WHEN status='WAIVED' THEN status WHEN paid=amount_due THEN 'PAID' WHEN paid>0 THEN 'PARTIAL' ELSE 'UNPAID' END WHERE school_id=sid AND id=fid;
END $$;
CREATE FUNCTION app.fee_ledger_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE f fee_records;p fee_payments;BEGIN
 IF NOT app.fee_writer(NEW.school_id) THEN RAISE EXCEPTION 'FEE_WRITE_DENIED' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='fee_payments' THEN
  PERFORM app.lock_fee_account(NEW.school_id,NEW.student_id,NEW.academic_session_id);
  NEW.recorded_by:=app.user_id();
  IF app.school_role(NEW.school_id)='finance_staff' THEN NEW.receipt_no:='REC-'||NEW.id;END IF;
  IF NEW.receipt_no !~ '^[A-Za-z0-9][A-Za-z0-9/_-]*$' THEN RAISE EXCEPTION 'FEE_RECEIPT_INVALID' USING ERRCODE='23514';END IF;
  IF NEW.kind<>'PAYMENT' OR NEW.payment_date>(SELECT (now() AT TIME ZONE timezone)::date FROM schools WHERE id=NEW.school_id) OR NEW.idempotency_key IS NULL OR NEW.request_hash IS NULL THEN RAISE EXCEPTION 'FEE_PAYMENT_INVALID' USING ERRCODE='23514';END IF;
  IF NEW.payment_method IN ('UPI','BANK_TRANSFER','CARD','CHEQUE') AND length(btrim(NEW.reference))=0 THEN RAISE EXCEPTION 'FEE_REFERENCE_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO p FROM fee_payments WHERE school_id=NEW.school_id AND id=NEW.payment_id;
  IF p.id IS NULL THEN RAISE EXCEPTION 'FEE_PAYMENT_INVALID' USING ERRCODE='23514';END IF;
  PERFORM app.lock_fee_account(p.school_id,p.student_id,p.academic_session_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.school_id::text||':fee-ledger:'||NEW.payment_id::text,0));
  IF TG_TABLE_NAME='fee_payment_allocations' THEN
   IF EXISTS(SELECT FROM fee_payment_reversals WHERE school_id=p.school_id AND payment_id=p.id) THEN RAISE EXCEPTION 'FEE_PAYMENT_REVERSED' USING ERRCODE='23514';END IF;
   SELECT * INTO f FROM fee_records WHERE school_id=NEW.school_id AND id=NEW.fee_id FOR UPDATE;
   IF f.id IS NULL OR f.student_id<>p.student_id OR f.academic_session_id<>p.academic_session_id OR f.currency<>p.currency OR f.status='WAIVED' OR f.voided_at IS NOT NULL OR NEW.amount>f.amount_due-f.amount_paid THEN RAISE EXCEPTION 'FEE_ALLOCATION_INVALID' USING ERRCODE='23514';END IF;
  ELSE
   NEW.recorded_by:=app.user_id();
   PERFORM 1 FROM fee_records WHERE school_id=NEW.school_id AND id IN(SELECT fee_id FROM fee_payment_allocations WHERE school_id=NEW.school_id AND payment_id=p.id) ORDER BY id FOR UPDATE;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION app.fee_ledger_refresh() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE fid uuid;BEGIN
 IF TG_TABLE_NAME='fee_payment_allocations' THEN PERFORM app.fee_refresh(NEW.school_id,NEW.fee_id);
 ELSE FOR fid IN SELECT fee_id FROM fee_payment_allocations WHERE school_id=NEW.school_id AND payment_id=NEW.payment_id ORDER BY fee_id LOOP PERFORM app.fee_refresh(NEW.school_id,fid);END LOOP;END IF;RETURN NEW;
END $$;
CREATE FUNCTION app.fee_ledger_balanced() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE pid uuid;BEGIN
 IF TG_TABLE_NAME='fee_payments' THEN pid:=NEW.id;ELSE pid:=NEW.payment_id;END IF;
 IF EXISTS(SELECT FROM fee_payments p WHERE p.school_id=NEW.school_id AND p.id=pid AND p.amount<>(SELECT coalesce(sum(a.amount),0) FROM fee_payment_allocations a WHERE a.school_id=p.school_id AND a.payment_id=p.id)) THEN RAISE EXCEPTION 'FEE_PAYMENT_UNBALANCED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE FUNCTION app.fee_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN IF current_user='app_api' THEN RAISE EXCEPTION 'FEE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['fee_payments','fee_payment_allocations','fee_payment_reversals'] LOOP
  EXECUTE format('CREATE TRIGGER ledger_guard BEFORE INSERT ON %I FOR EACH ROW WHEN (current_user=''app_api'') EXECUTE FUNCTION app.fee_ledger_guard()',t);
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.fee_immutable()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['fee_payments','fee_payment_allocations'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER balanced AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.fee_ledger_balanced()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['fee_payment_allocations','fee_payment_reversals'] LOOP EXECUTE format('CREATE TRIGGER refresh AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION app.fee_ledger_refresh()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['fee_structures','fee_structure_sections','fee_structure_items'] LOOP EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.fee_immutable()',t);END LOOP;
END $$;
CREATE FUNCTION app.fee_configuration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s fee_structures;ac academic_sessions;BEGIN
 IF current_user<>'app_api' THEN RETURN NEW;END IF;
 IF NOT app.fee_writer(NEW.school_id) THEN RAISE EXCEPTION 'FEE_WRITE_DENIED' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='fee_structure_sections' OR TG_TABLE_NAME='fee_structure_items' THEN
  SELECT * INTO s FROM fee_structures WHERE school_id=NEW.school_id AND id=NEW.structure_id;
  IF s.created_at IS DISTINCT FROM transaction_timestamp() OR s.created_by IS DISTINCT FROM app.user_id() THEN RAISE EXCEPTION 'FEE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF NEW.class_id IS NOT NULL AND NOT EXISTS(SELECT FROM classes c WHERE c.school_id=NEW.school_id AND c.id=NEW.class_id AND c.grade=s.grade AND c.academic_session_id=s.academic_session_id AND c.retired_at IS NULL) THEN RAISE EXCEPTION 'FEE_CLASS_INVALID' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='fee_structure_items' THEN
   SELECT * INTO ac FROM academic_sessions WHERE school_id=s.school_id AND id=s.academic_session_id;
   IF (s.mode='SAME')<>(NEW.class_id IS NULL) OR NEW.first_due_on NOT BETWEEN ac.starts_on AND ac.ends_on THEN RAISE EXCEPTION 'FEE_STRUCTURE_INVALID' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='fee_transport_assignments' THEN
  IF TG_OP='UPDATE' AND (OLD.ended_on IS NOT NULL OR ROW(NEW.id,NEW.school_id,NEW.student_id,NEW.academic_session_id,NEW.route_id,NEW.amount,NEW.frequency,NEW.starts_on,NEW.ends_on,NEW.first_due_on,NEW.created_by) IS DISTINCT FROM ROW(OLD.id,OLD.school_id,OLD.student_id,OLD.academic_session_id,OLD.route_id,OLD.amount,OLD.frequency,OLD.starts_on,OLD.ends_on,OLD.first_due_on,OLD.created_by)) THEN RAISE EXCEPTION 'FEE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
  SELECT * INTO ac FROM academic_sessions WHERE school_id=NEW.school_id AND id=NEW.academic_session_id;
  IF NEW.starts_on<ac.starts_on OR NEW.ends_on>ac.ends_on OR (TG_OP='INSERT' AND NOT EXISTS(SELECT FROM fee_transport_routes WHERE school_id=NEW.school_id AND id=NEW.route_id AND active)) THEN RAISE EXCEPTION 'FEE_TRANSPORT_INVALID' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;

-- Finance staff may read the school/year/class/student references needed for
-- collection, but gain no write privileges to academic or family records.
DO $$ DECLARE t text;BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='school_id' AND NOT a.attisdropped) AND c.relname NOT LIKE 'fee_%' AND c.relname NOT IN ('audit_logs','api_idempotency_keys') LOOP
  IF t NOT IN ('students','classes','academic_sessions','enrollments','subscriptions','teachers','school_memberships') THEN
   EXECUTE format('CREATE POLICY finance_scope ON %I AS RESTRICTIVE TO app_api USING(app.school_role(school_id) IS DISTINCT FROM ''finance_staff'') WITH CHECK(app.school_role(school_id) IS DISTINCT FROM ''finance_staff'')',t);
  ELSE
   EXECUTE format('CREATE POLICY finance_no_insert ON %I AS RESTRICTIVE FOR INSERT TO app_api WITH CHECK(app.school_role(school_id) IS DISTINCT FROM ''finance_staff'')',t);
   EXECUTE format('CREATE POLICY finance_no_update ON %I AS RESTRICTIVE FOR UPDATE TO app_api USING(app.school_role(school_id) IS DISTINCT FROM ''finance_staff'') WITH CHECK(app.school_role(school_id) IS DISTINCT FROM ''finance_staff'')',t);
   EXECUTE format('CREATE POLICY finance_no_delete ON %I AS RESTRICTIVE FOR DELETE TO app_api USING(app.school_role(school_id) IS DISTINCT FROM ''finance_staff'')',t);
  END IF;
 END LOOP;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['fee_structure_sections','fee_structure_items','fee_transport_assignments'] LOOP EXECUTE format('CREATE TRIGGER configuration_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.fee_configuration_guard()',t);END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.fee_record_guard(),app.fee_refresh(uuid,uuid),app.fee_ledger_guard(),app.fee_ledger_refresh(),app.fee_ledger_balanced(),app.fee_immutable(),app.fee_configuration_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.fee_refresh(uuid,uuid) TO app_api;

-- Include the ledger in the existing approved offboarding purge dependency order.
DO $$ DECLARE def text;BEGIN
 def:=pg_get_functiondef('app.purge_approved_school(uuid)'::regprocedure);
 IF position('''fee_records''' IN def)=0 THEN RAISE EXCEPTION 'Fee purge order unavailable';END IF;
 def:=replace(def,'''fee_records''','''fee_payment_reversals'',''fee_payment_allocations'',''fee_payments'',''fee_records'',''fee_transport_assignments'',''fee_transport_routes'',''fee_structure_items'',''fee_structure_sections'',''fee_structures''');
 EXECUTE def;
END $$;
