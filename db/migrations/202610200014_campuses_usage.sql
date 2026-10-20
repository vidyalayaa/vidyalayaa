CREATE TABLE school_usage_snapshots(school_id uuid NOT NULL REFERENCES schools(id),on_date date NOT NULL,active_students integer NOT NULL,devices integer NOT NULL,notifications_sent integer NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(school_id,on_date));
ALTER TABLE school_usage_snapshots ENABLE ROW LEVEL SECURITY;ALTER TABLE school_usage_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON school_usage_snapshots TO app_api,app_worker USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id());
CREATE POLICY platform ON school_usage_snapshots FOR SELECT TO app_platform USING(app.is_platform_staff());
GRANT SELECT ON school_usage_snapshots TO app_api,app_platform;
GRANT SELECT,INSERT,UPDATE ON school_usage_snapshots TO app_worker;
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION app.audit_change();

CREATE FUNCTION app.set_school_organization(target uuid,org uuid,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE plan record;cap integer;used integer;
BEGIN
 IF NOT app.is_platform_staff() OR length(reason)<5 THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM schools WHERE id=target FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Unknown school';END IF;
 IF org IS NOT NULL THEN
  PERFORM 1 FROM organizations WHERE id=org FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Unknown organization';END IF;
  SELECT p.features,p.limits,s.limit_overrides,s.status INTO plan FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.school_id=target ORDER BY s.created_at DESC LIMIT 1;
  IF NOT coalesce((plan.features->>'multi_campus')::boolean,false) OR plan.status NOT IN ('ACTIVE','TRIALING','PAST_DUE') THEN RAISE EXCEPTION 'ENTERPRISE_REQUIRED' USING ERRCODE='23514';END IF;
  cap=coalesce((plan.limit_overrides->>'max_campuses')::integer,(plan.limits->>'max_campuses')::integer,0);
  -- Each participating school's contract remains a ceiling; adding a campus cannot bypass a smaller member cap.
  SELECT least(cap,coalesce(min(coalesce((sub.limit_overrides->>'max_campuses')::integer,(p.limits->>'max_campuses')::integer)),cap)) INTO cap
   FROM schools sc JOIN LATERAL(SELECT * FROM subscriptions WHERE school_id=sc.id ORDER BY created_at DESC LIMIT 1) sub ON true JOIN subscription_plans p ON p.id=sub.plan_id WHERE sc.organization_id=org AND sc.id<>target;
  SELECT count(*) INTO used FROM schools WHERE organization_id=org AND id<>target;
  IF used+1>cap THEN RAISE EXCEPTION 'CAMPUS_LIMIT_REACHED' USING ERRCODE='23514';END IF;
 END IF;
 UPDATE schools SET organization_id=org,access_version=access_version+1 WHERE id=target;
 INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES(target,'USER',app.user_id(),'school.organization.changed','schools',target,jsonb_build_object('organization_id',org,'reason',reason));
END $$;
REVOKE ALL ON FUNCTION app.set_school_organization(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.set_school_organization(uuid,uuid,text) TO app_platform;

-- Campus membership never conveys access to another campus's student records.
CREATE FUNCTION app.authorized_campuses() RETURNS TABLE(school_id uuid,school_name text,role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT sc.id,sc.name,r.code FROM schools sc JOIN school_memberships m ON m.school_id=sc.id JOIN roles r ON r.id=m.role_id
 JOIN schools current_school ON current_school.id=app.school_id()
 WHERE m.user_id=app.user_id() AND m.status='ACTIVE' AND sc.status<>'TERMINATED'
 AND EXISTS(SELECT FROM school_memberships own WHERE own.school_id=current_school.id AND own.user_id=app.user_id() AND own.status='ACTIVE')
 AND (sc.id=current_school.id OR (current_school.organization_id IS NOT NULL AND sc.organization_id=current_school.organization_id
 AND EXISTS(SELECT FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.school_id=current_school.id AND s.status IN ('ACTIVE','TRIALING','PAST_DUE') AND coalesce((p.features->>'multi_campus')::boolean,false)))) ORDER BY sc.name;
$$;
REVOKE ALL ON FUNCTION app.authorized_campuses() FROM PUBLIC,anon,authenticated,app_device,app_worker,app_platform;
GRANT EXECUTE ON FUNCTION app.authorized_campuses() TO app_api;
