# Subject study materials

The existing `assignments` table (`kind='MATERIAL'`) and private `school-documents` Storage bucket remain the only sources of truth. No duplicate catalogue, table or subject relationship is created.

## Where to share and read

- School Admin: **Academics → class → section → subject → Study materials**. Add notes or upload a file, edit existing material, or archive it when it should no longer appear.
- Teacher: **Study materials → assigned class and section → subject**. Only assigned subjects appear, and the backend checks both the class and exact subject. Being Class Teacher alone does not grant access to upload to unassigned subjects. Existing Homework workflows remain available.
- Student: **Academics → subject card**. Open the subject's notes and files or download them. Only the student's current enrolled class/section is available.
- Parent: select the linked child, then **Academics → subject card**. The subject list and material query follow that child. Switching children unmounts the old materials panel.

PDF, PNG and JPEG uploads are supported, up to 10 MiB each, following the existing storage restrictions. Each material has a title, optional notes and one optional file. Multiple materials may be added to a subject. Text notes can be shared without a file. On edit, the existing file is retained unless a replacement is uploaded. Retry after an uncertain response reuses the same idempotency key and previously uploaded path for the unchanged form to avoid duplicate material records. Uploaded files are never made public.

## Contracts and authorization

`GET /materials?class_id=<uuid>&subject_id=<uuid>&page=1&page_size=25` returns a page of authorized non-retired MATERIAL assignments with title, notes, creation time, attachment availability and filename. Page size is capped at 100. Both class and subject are required. Subjects must be configured for that exact section using an active teaching relationship. Students/parents cannot use an ID from a different section to view its data. Parents also have `GET /parent/children/:childId/materials` with the same query contract, behind the existing checked-child gate.

Uploads reuse `POST /materials/upload`. The new subject interface sends `class_id`, `subject_id` and a sanitized filename. `subject_id` is optional for compatibility with the existing general Homework uploader; when present, it is checked against the selected class and teacher assignment. Saving/editing uses the existing audited/idempotent `/resources/assignments` endpoints. Archiving uses `/resources/assignments/:id/retire`. Existing authoring permissions, school isolation, subscription gates and teacher subject policies remain in force.

Opening/downloading reuses `/materials/:id/download` and `/materials/:id/file`. The short-lived application signature is bound to the authenticated user and school. File requests check the current record permissions again, so an archived material or revoked parent link cannot be fetched merely by retaining the old signed URL. File paths and Storage credentials are not exposed by the material list. Preview fetches the authenticated file, forces one of the supported PDF/image MIME types, and uses a temporary object URL which is revoked when the preview is closed. Firebase's policy permits these local blob images/frames; object embedding remains disabled. No public signed Storage read link is introduced.

## Migration and release

Run the existing `npm run db:migrate` and `npm run db:verify` with the protected migration-owner connection, then build and deploy matching API, contracts and website versions. Include `firebase.json` when deploying Hosting so private-file previews have the required policy. Migration `20261030165823_subject_material_access.sql` adds restrictive current-student read policies and denies student writes on the existing assignments table. It changes no school records. Other roles retain existing policies. Keep these protections if rolling back the UI; removing them is a separate reviewed security change.

```powershell
npm run build -w @vidyalayaa/contracts
npm run db:migrate
npm run db:verify
npm run build
npx vitest run tests/api/subject-materials.test.ts tests/api/teacher-assignments.test.ts tests/api/parent-workspace.test.ts tests/api/student-learning.test.ts
npx playwright test tests/e2e/subject-materials.spec.ts --workers=1
```

Verification uses disposable databases and temporary API services with simulated external authentication and Storage. Live provider uploads and device-browser PDF rendering should also be checked with a real allowed file after deployment. File availability requires the existing Supabase private bucket and Storage service credentials; no new external service is required.

Verified on 31 October 2026: 34 API tests passed across subject materials, teacher assignments, parent workspace and student learning, and 10 schema/security checks passed. All eight new desktop/mobile material workflows passed for School Admin, Teacher, Student and Parent, covering upload, actual image preview, download, editing, archiving and read-only family controls. Existing parent navigation/child-switching and student learning/results also passed on desktop and mobile. These regression suites require separate invocations because their worker-scoped fixtures retain seeded examinations; a combined diagnostic invocation exposed that test-data dependency, and the student suite passed when rerun with its fresh fixture. API/website production builds, full workspace type checking, lint, formatting and secret scanning passed.

Migration `20261030165823_subject_material_access.sql` was applied to the configured database after existing migration checksum verification; database security verification passed in the same transaction. No existing school record was changed. The hosted API and Firebase site were not redeployed by this task.
