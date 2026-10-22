DO $$ DECLARE n integer; BEGIN
 SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relkind='r' AND NOT c.relname LIKE 'spatial_%' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
 IF n>0 THEN RAISE EXCEPTION '% public tables do not force RLS',n; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN ('app_api','app_device','app_worker','app_platform') AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Application role bypasses RLS'; END IF;
 IF has_table_privilege('app_platform','students','SELECT') THEN RAISE EXCEPTION 'Platform can read student records'; END IF;
 IF has_table_privilege('app_api','audit_logs','UPDATE') OR has_table_privilege('app_api','attendance_events','DELETE') THEN RAISE EXCEPTION 'Audit mutability detected'; END IF;
 IF has_table_privilege('authenticated','students','SELECT') OR has_table_privilege('anon','students','SELECT') THEN RAISE EXCEPTION 'PostgREST access exposed'; END IF;
 IF NOT EXISTS(SELECT FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name='sex' AND is_nullable='NO') OR NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='students'::regclass AND conname='students_sex_check') THEN RAISE EXCEPTION 'Student sex column or validation missing'; END IF;
 IF NOT EXISTS(SELECT FROM pg_policy WHERE polrelid='school_holidays'::regclass AND polname='calendar_read' AND NOT polpermissive) OR NOT EXISTS(SELECT FROM pg_indexes WHERE indexname='calendar_no_duplicate') THEN RAISE EXCEPTION 'Calendar isolation or duplicate guard missing'; END IF;
 IF has_table_privilege('authenticated','school_holidays','SELECT') OR has_table_privilege('anon','school_holidays','SELECT') OR has_function_privilege('app_api','app.calendar_class_reference_guard()','EXECUTE') THEN RAISE EXCEPTION 'Calendar privileged surface exposed'; END IF;
 IF NOT EXISTS(SELECT FROM pg_indexes WHERE indexname='one_active_card') OR NOT EXISTS(SELECT FROM pg_indexes WHERE indexname='card_uid_lookup') THEN RAISE EXCEPTION 'Card uniqueness missing'; END IF;
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='daily_attendance'::regclass AND contype='u' AND pg_get_constraintdef(oid) LIKE '%school_id, student_id, attendance_date%') THEN RAISE EXCEPTION 'Daily idempotency missing'; END IF;
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='attendance_events'::regclass AND contype='u' AND pg_get_constraintdef(oid) LIKE '%device_id, device_event_id%') THEN RAISE EXCEPTION 'Event idempotency missing'; END IF;
 IF EXISTS(SELECT FROM storage.buckets WHERE id IN ('school-documents','firmware') AND public) THEN RAISE EXCEPTION 'Private bucket exposed'; END IF;
 IF EXISTS(SELECT FROM pg_policy WHERE polrelid=to_regclass('storage.objects') AND polroles && ARRAY[0::oid,(SELECT oid FROM pg_roles WHERE rolname='anon'),(SELECT oid FROM pg_roles WHERE rolname='authenticated')]) THEN RAISE EXCEPTION 'Review direct browser storage policies; Vidyalayaa requires no user listing/read policy'; END IF;
END $$;
