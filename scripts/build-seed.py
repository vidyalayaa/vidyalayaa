from pathlib import Path
import json
root=Path(__file__).resolve().parents[1]
groups={
'school_admin':['students.read','students.write','academics.read','academics.write','parents.read','parents.write','teachers.read','teachers.write','attendance.read','attendance.manual_write','attendance.correct_request','attendance.correct_approve','marks.read','marks.write','assignments.read','assignments.write','timetable.read','timetable.write','announcements.read','announcements.write','fees.read','fees.write','devices.read','devices.manage','cards.read','cards.manage','rules.read','rules.manage','reports.export','users.manage','audit.read','subscription.read','notifications.read','school.manage'],
'principal':['students.read','academics.read','parents.read','teachers.read','attendance.read','attendance.correct_request','attendance.correct_approve','marks.read','assignments.read','timetable.read','announcements.read','announcements.write','fees.read','devices.read','cards.read','rules.read','reports.export','subscription.read','notifications.read'],
'teacher':['students.read','academics.read','teachers.read','attendance.read','attendance.manual_write','attendance.correct_request','marks.read','marks.write','assignments.read','assignments.write','timetable.read','announcements.read','announcements.write','reports.export'],
'parent':['students.read','academics.read','attendance.read','attendance.correct_request','marks.read','assignments.read','timetable.read','announcements.read','fees.read','reports.export','notifications.read','notifications.preferences'],
'student':['students.read','academics.read','attendance.read','marks.read','assignments.read','timetable.read','announcements.read','fees.read','reports.export']}
s=[]
for r,ps in groups.items():
 s.append(f"INSERT INTO roles(code,name) VALUES('{r}','{r.replace('_',' ').title()}') ON CONFLICT(code) DO NOTHING;")
 for p in ps:
  s.append(f"INSERT INTO permissions(code) VALUES('{p}') ON CONFLICT(code) DO NOTHING;")
  s.append(f"INSERT INTO role_permissions SELECT r.id,p.id FROM roles r,permissions p WHERE r.code='{r}' AND p.code='{p}' ON CONFLICT DO NOTHING;")
for p in ['BASIC','PROFESSIONAL','ENTERPRISE']:
 f={x:p!='BASIC' for x in ['nfc_attendance','parent_alerts','timetable','assignments','advanced_reporting']};f['multi_campus']=p=='ENTERPRISE'
 # Limits are conservative development defaults; explicitly configure each customer contract.
 l={'max_students':1000,'max_devices':0 if p=='BASIC' else 10,'max_campuses':10 if p=='ENTERPRISE' else 1,'report_retention_days':180}
 s.append(f"INSERT INTO subscription_plans(code,name,features,limits) VALUES('{p}','{p.title()}','{json.dumps(f)}','{json.dumps(l)}') ON CONFLICT(code) DO NOTHING;")
(root/'db/migrations/202610170002_rbac_plans.sql').write_text('\n'.join(s)+'\n')
print('RBAC and configurable plan defaults generated')
