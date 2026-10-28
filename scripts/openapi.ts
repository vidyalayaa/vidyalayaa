import { writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import {
  resourceSchemas,
  firmwareManifestSchema,
  firmwareApprovalSchema,
  hardwareVerificationSchema,
  firmwareAssignmentSchema,
  securityPolicySchema,
  exportRequestSchema,
  reconciliationRequestSchema,
  retirementSchema,
  notificationPrivacySchema,
  customNotificationSchema,
  notificationSettingsSchema,
  campusAssociationSchema,
  supportRequestSchema,
  supportResponseSchema,
  deviceProtocol,
  eventSchema,
  batchSchema,
  heartbeatSchema,
  syncAckSchema,
  otaSchema,
  ruleSchema,
  correctionSchema,
  manualSchema,
  reportSchema,
  inviteSchema,
  bulkMarksSchema,
  firstAdminSchema,
  deviceTuningSchema,
  retentionPolicySchema,
  classAttendanceSchema,
  feePaymentSchema,
  feeDate,
  feeStructureSchema,
  feeAssessmentSchema,
  feeCollectionSchema,
  feeReasonSchema,
  transportRouteSchema,
  transportAssignmentSchema,
  classSubjectSchema,
  studentAdmissionSchema,
  studentImportRequestSchema,
  studentImportRowSchema,
  calendarEventSchema,
  calendarEventUpdateSchema,
  calendarDeleteSchema,
  schoolTimingsSchema,
  schoolTimingsUpdateSchema,
} from '@vidyalayaa/contracts';
// Generate from the same schemas used by Express and the browser. Do not edit JSON by hand.
function json(schema: z.ZodTypeAny): Record<string, unknown> {
  const d = schema._def;
  switch (d.typeName) {
    case 'ZodEffects':
      return json(d.schema);
    case 'ZodOptional':
      return json(d.innerType);
    case 'ZodNullable':
      return { anyOf: [json(d.innerType), { type: 'null' }] };
    case 'ZodDefault':
      return { ...json(d.innerType), default: d.defaultValue() };
    case 'ZodObject': {
      const shape = d.shape() as Record<string, z.ZodTypeAny>;
      return {
        type: 'object',
        properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, json(v)])),
        required: Object.entries(shape)
          .filter(([, v]) => !v.isOptional())
          .map(([k]) => k),
        additionalProperties: d.unknownKeys !== 'strict',
      };
    }
    case 'ZodString': {
      const s: Record<string, unknown> = { type: 'string' };
      for (const c of d.checks || []) {
        if (c.kind === 'uuid') s.format = 'uuid';
        if (c.kind === 'datetime') s.format = 'date-time';
        if (c.kind === 'email') s.format = 'email';
        if (c.kind === 'min') s.minLength = c.value;
        if (c.kind === 'max') s.maxLength = c.value;
        if (c.kind === 'regex') s.pattern = c.regex.source;
      }
      return s;
    }
    case 'ZodNumber': {
      const s: Record<string, unknown> = {
        type: d.checks.some((c: { kind: string }) => c.kind === 'int') ? 'integer' : 'number',
      };
      for (const c of d.checks) {
        if (c.kind === 'min') s[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value;
        if (c.kind === 'max') s[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value;
      }
      return s;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return { const: d.value };
    case 'ZodEnum':
      return { type: 'string', enum: d.values };
    case 'ZodArray':
      return {
        type: 'array',
        items: json(d.type),
        ...(d.minLength ? { minItems: d.minLength.value } : {}),
        ...(d.maxLength ? { maxItems: d.maxLength.value } : {}),
      };
    case 'ZodRecord':
      return { type: 'object', additionalProperties: json(d.valueType) };
    default:
      return {};
  }
}
const schemas = {
  FirmwareManifest: firmwareManifestSchema,
  FirmwareApproval: firmwareApprovalSchema,
  HardwareVerification: hardwareVerificationSchema,
  FirmwareAssignment: firmwareAssignmentSchema,
  SchoolSecurity: securityPolicySchema,
  SchoolExport: exportRequestSchema,
  Reconciliation: reconciliationRequestSchema,
  Retirement: retirementSchema,
  NotificationPrivacy: notificationPrivacySchema,
  CustomNotification: customNotificationSchema,
  SchoolNotificationSettings: notificationSettingsSchema,
  CampusAssociation: campusAssociationSchema,
  SupportRequest: supportRequestSchema,
  SupportResponse: supportResponseSchema,
  DeviceEvent: eventSchema,
  DeviceBatch: batchSchema,
  Heartbeat: heartbeatSchema,
  SyncAck: syncAckSchema,
  OtaStatus: otaSchema,
  AttendanceRules: ruleSchema,
  Correction: correctionSchema,
  ManualAttendance: manualSchema,
  ClassAttendance: classAttendanceSchema,
  FeePayment: feePaymentSchema,
  FeeStructure: feeStructureSchema,
  FeeAssessment: feeAssessmentSchema,
  FeeCollection: feeCollectionSchema,
  FeeCorrection: feeReasonSchema,
  FeeTransportEnd: feeReasonSchema.extend({ ended_on: feeDate }),
  FeeTransportRoute: transportRouteSchema,
  FeeTransportAssignment: transportAssignmentSchema,
  ClassSubject: classSubjectSchema,
  StudentAdmission: studentAdmissionSchema,
  StudentImportRequest: studentImportRequestSchema,
  StudentImportRow: studentImportRowSchema,
  CalendarEvent: calendarEventSchema,
  CalendarEventUpdate: calendarEventUpdateSchema,
  CalendarEventDelete: calendarDeleteSchema,
  SchoolTimings: schoolTimingsSchema,
  SchoolTimingsUpdate: schoolTimingsUpdateSchema,
  ReportRequest: reportSchema,
  Invitation: inviteSchema,
  BulkMarks: bulkMarksSchema,
  FirstSchoolAdministrator: firstAdminSchema,
  DeviceTuning: deviceTuningSchema,
  RetentionPolicy: retentionPolicySchema,
  ...resourceSchemas,
};
const paths: Record<string, Record<string, unknown>> = {};
function operation(
  path: string,
  method: string,
  summary: string,
  schema?: string,
  security = 'UserJWT',
  extra: Record<string, unknown> = {},
) {
  paths[path] ??= {};
  paths[path][method] = {
    summary,
    security: [{ [security]: [] }],
    parameters:
      security === 'DeviceCredential'
        ? [{ name: 'X-Device-Id', in: 'header', required: true, schema: { type: 'string' } }]
        : security === 'UserJWT'
          ? [
              {
                name: 'X-School-Id',
                in: 'header',
                required:
                  !['/me', '/invitations/pending', '/invitations/{id}/respond'].includes(path) &&
                  !path.startsWith('/account/') &&
                  !path.startsWith('/platform/'),
                schema: { type: 'string', format: 'uuid' },
              },
            ]
          : [],
    ...(schema
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
          },
        }
      : {}),
    responses: {
      '200': {
        description:
          'Successful response; see docs/API.md for projection and per-event acknowledgement semantics.',
      },
      '401': { description: 'Missing/invalid credential or expired session' },
      '403': { description: 'Permission, MFA, scope or entitlement denied' },
      '404': { description: 'Resource absent or outside the authorized scope' },
      '409': { description: 'Constraint, idempotency or version conflict' },
      '422': { description: 'Validation failed' },
      '429': { description: 'Rate limited; honor Retry-After' },
      '503': { description: 'Dependency unavailable; do not discard unacknowledged device events' },
    },
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'parameters')),
  };
  if (Array.isArray(extra.parameters)) {
    const op = paths[path][method] as { parameters: { name: string; in: string }[] };
    const merged = [...op.parameters, ...extra.parameters] as { name: string; in: string }[];
    op.parameters = [...new Map(merged.map((p) => [`${p.in}:${p.name}`, p])).values()];
  }
}
for (const name of Object.keys(resourceSchemas)) {
  operation(
    `/resources/${name}`,
    'get',
    `List scoped ${name}`,
    undefined,
    'UserJWT',
    ['marks', 'subjects', 'exams'].includes(name)
      ? {
          parameters: [
            {
              name: 'X-School-Id',
              in: 'header',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'class_id',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description:
                'Exact class/section record. Marks are filtered through the examination class; subjects use configured section assignments.',
            },
            ...(name === 'marks'
              ? [
                  {
                    name: 'exam_id',
                    in: 'query',
                    schema: { type: 'string', format: 'uuid' },
                    description:
                      'Combines with class_id; an examination from another class returns no matching marks.',
                  },
                ]
              : []),
          ],
        }
      : {},
  );
  operation(`/resources/${name}`, 'post', `Create ${name}`, name, 'UserJWT', {
    parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
  });
  operation(`/resources/${name}/{id}`, 'get', `Read scoped ${name}`);
  operation(`/resources/${name}/{id}`, 'patch', `Update ${name}`);
}
operation('/me', 'get', 'Verified identity, memberships, permissions and entitlements');
operation(
  '/parent/children',
  'get',
  'Parent: active linked children and their current class/section',
);
for (const section of [
  'profile',
  'attendance',
  'academics',
  'homework',
  'results',
  'results/insights',
  'fees',
  'payments',
  'reports',
  'announcements',
  'notifications',
  'corrections',
  'calendar/classes',
  'calendar/events',
  'timetable/settings',
  'timetable/clock',
  'timetable/classes',
  'timetable/classes/{id}/entries',
])
  operation(
    `/parent/children/{childId}/${section}`,
    'get',
    `Parent: selected-child ${section}; live ownership and database RLS required`,
  );
operation(
  '/account/credentials',
  'get',
  'Current account email, pending email and password presence only; no user ID accepted and no credentials returned',
);
operation(
  '/account/sessions',
  'get',
  'List only the current user’s provider sessions and recent account security alerts; no school selection required',
);
operation(
  '/account/sessions/logout-others',
  'post',
  'End all owned provider sessions except the current session; no user ID accepted',
);
operation(
  '/account/sessions/{id}',
  'delete',
  'End one owned provider session, cascade its refresh credentials and report whether it was current',
  undefined,
  'UserJWT',
  {
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
    ],
  },
);
operation('/dashboard', 'get', 'Role-scoped school dashboard');
operation(
  '/student/profile',
  'get',
  'Student-only own profile, active guardians and enrollment history; authenticated identity only, no query parameters or record IDs accepted',
);
operation(
  '/timetable/settings',
  'get',
  'School timing template; configured=false means unsaved defaults',
);
operation(
  '/timetable/settings',
  'put',
  'School Admin-only versioned timing update; preserves existing lectures',
  'SchoolTimingsUpdate',
  'UserJWT',
  {
    parameters: [
      {
        name: 'X-School-Id',
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
    ],
  },
);
operation('/timetable/classes', 'get', 'Paginated authorized timetable classes and sections');
operation(
  '/timetable/clock',
  'get',
  'Uncached API UTC clock and the active school timezone for live lecture highlighting',
);
operation(
  '/timetable/mine',
  'get',
  'Teacher-only paginated own lectures across currently assigned classes and subjects; identity comes from the authenticated session',
  undefined,
  'UserJWT',
  {
    parameters: [
      {
        name: 'X-School-Id',
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
  },
);
for (const child of ['entries', 'assignments'])
  operation(
    `/timetable/classes/{id}/${child}`,
    'get',
    child === 'entries'
      ? 'Paginated weekly class lectures with labels'
      : 'School Admin-only active subject/teacher assignments for this class',
    undefined,
    'UserJWT',
    {
      parameters: [
        {
          name: 'X-School-Id',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
        { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
      ],
    },
  );
operation('/attendance', 'get', 'Paginated daily attendance');
operation('/attendance/manual', 'post', 'Manual classroom attendance', 'ManualAttendance');
operation(
  '/attendance/bulk',
  'post',
  'Atomic class register; enrollment, NFC and version checks; up to 500 unique students',
  'ClassAttendance',
  'UserJWT',
  {
    parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
  },
);
operation(
  '/fees/{id}/pay',
  'post',
  'Record an exact fee payment; retry returns the original receipt',
  'FeePayment',
  'UserJWT',
  {
    parameters: [
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 8, maxLength: 200 },
      },
    ],
  },
);
operation(
  '/corrections',
  'get',
  'Scoped correction requests; optional status and other-author reviewer filters',
  undefined,
  'UserJWT',
  {
    parameters: [
      {
        name: 'status',
        in: 'query',
        schema: {
          type: 'string',
          enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'APPLIED', 'CANCELLED'],
        },
      },
      {
        name: 'reviewable',
        in: 'query',
        description: '1 excludes requests by the current reviewer; approval permission required.',
        schema: { type: 'string', enum: ['1'] },
      },
    ],
  },
);
operation('/corrections', 'post', 'Request a correction', 'Correction');
operation('/corrections/{id}/decision', 'post', 'Approve/reject; self-approval prohibited');
operation('/marks/bulk', 'post', 'Atomic, idempotent upload of up to 500 mark rows', 'BulkMarks');
operation(
  '/invitations',
  'post',
  'Invite an existing same-school record; requires record_id and matching email/role',
  'Invitation',
);
operation(
  '/invitation-candidates',
  'get',
  'Eligible existing records; users.manage; role required; optional page, page_size and search',
);
operation('/invitations', 'get', 'Paginated school invitations; users.manage');
operation(
  '/invitations/pending',
  'get',
  'Own invitations matched to a verified Auth email; no school required',
);
operation(
  '/invitations/{id}/respond',
  'post',
  'Accept or decline the authenticated recipient’s invitation; {accept:boolean}',
);
operation(
  '/invitations/{id}/resend',
  'post',
  'Retry an invitation; users.manage; preserves current sending lease',
);
operation(
  '/invitations/{id}/cancel',
  'post',
  'Cancel an unaccepted school invitation; users.manage',
);
operation(
  '/lookups/accounts',
  'get',
  'Paginated active school accounts, filtered by teacher/parent/student role; users.manage',
);
operation(
  '/teaching/classes',
  'get',
  'Current teacher assigned classes, sections, subjects and Class Teacher designation; classrooms.read',
);
for (const child of ['classes', 'students', 'parents', 'enrollment-classes'])
  operation(
    `/student-directory/${child}`,
    'get',
    'School Admin only; school-scoped class-wise student directory and admission lookups',
    undefined,
    'UserJWT',
    {
      parameters: [
        {
          name: 'X-School-Id',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        { name: 'search', in: 'query', schema: { type: 'string', maxLength: 120 } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
        { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ...(child === 'students'
          ? [
              { name: 'class_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
              { name: 'unassigned', in: 'query', schema: { type: 'string', enum: ['1'] } },
            ]
          : []),
      ],
      description:
        child === 'students'
          ? 'Select exactly one of class_id or unassigned=1. Current dated placements include all student statuses; future/former/unplaced students remain visible in the unassigned group.'
          : 'Classes are paginated with matching student counts and an unassigned_count. Admission choices exclude archived classes/sessions and inactive parents.',
    },
  );
operation(
  '/student-directory/admissions',
  'post',
  'School Admin only; save student, class enrollment, parents and family links atomically',
  'StudentAdmission',
  'UserJWT',
  {
    parameters: [
      {
        name: 'X-School-Id',
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 8, maxLength: 200 },
      },
    ],
    description:
      'Requires students.write and parents.write as well as directory read permissions. Supply one or two guardians, each with exactly one parent_id or parent details. At most one primary contact. The academic session is derived from the selected class. Existing email matches require explicit selection; existing parents are never overwritten. No Auth accounts or invitations are created.',
  },
);
const admissionResponses = (
  paths['/student-directory/admissions'].post as { responses: Record<string, unknown> }
).responses;
admissionResponses['201'] = {
  description:
    'Student, enrollment, parents and family connections saved together; safe retries return the same saved records.',
};
delete admissionResponses['200'];
operation(
  '/student-directory/imports',
  'post',
  'School Admin only; validate or atomically import complete student admissions with enrollments and family connections',
  'StudentImportRequest',
  'UserJWT',
  {
    parameters: [
      {
        name: 'X-School-Id',
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      {
        name: 'Idempotency-Key',
        in: 'header',
        schema: { type: 'string', minLength: 8, maxLength: 200 },
        description: 'Required when validate_only is false.',
      },
    ],
    description:
      'Requires users.manage, students.write and parents.write plus directory reads. Rows follow StudentImportRow (1-500). Class grade/section/session resolve only inside the selected school. Blank session uses the current one. Each row supplies one or two NEW or explicit EXISTING guardians; EXISTING uses a unique active same-school parent email and leaves name/phone blank. Preview rolls back all records/audits. Commit saves the entire file or nothing, with idempotent retries. Does not create accounts, invitations or passwords.',
  },
);
operation(
  '/student-directory/export.csv',
  'get',
  'School Admin only; stream school-scoped full student, enrollment and family CSV',
  undefined,
  'UserJWT',
  {
    parameters: [
      {
        name: 'X-School-Id',
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      { name: 'search', in: 'query', schema: { type: 'string', maxLength: 120 } },
      { name: 'academic_session_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
    ],
    description:
      'UTF-8 CSV with BOM, no-store and attachment disposition. Streams keyset batches under a repeatable-read snapshot, including inactive/unassigned students. Current enrollment is preferred, otherwise latest enrollment. Includes all linked parents, including read-only parent/link/enrollment statuses and extra parent columns when existing records have more than two active. Spreadsheet formulas are neutralized. Does not export credentials, attendance, marks or fee histories.',
  },
);
const studentImportResponses = (
  paths['/student-directory/imports'].post as { responses: Record<string, unknown> }
).responses;
studentImportResponses['200'] = {
  description:
    'Entire file validated without retaining admission records; returns validated and imported counts (imported is zero).',
};
studentImportResponses['201'] = {
  description:
    'Entire file imported atomically; returns validated and imported counts. Matching retry keys return the same result.',
};
const studentExportResponses = (
  paths['/student-directory/export.csv'].get as { responses: Record<string, unknown> }
).responses;
studentExportResponses['200'] = {
  description: 'UTF-8 CSV attachment; school-scoped student, enrollment and parent records.',
  content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
};
operation(
  '/calendar/classes',
  'get',
  'Calendar read: paginated accessible class/section choices; families see only current authorized enrollment sections',
  undefined,
  'UserJWT',
  {
    parameters: [
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
  },
);
operation(
  '/calendar/events',
  'get',
  'Calendar read: all applicable events overlapping an inclusive date range, with current role/ownership enforcement',
  undefined,
  'UserJWT',
  {
    parameters: [
      { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
      { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
      {
        name: 'kind',
        in: 'query',
        schema: {
          type: 'string',
          enum: [
            'HOLIDAY',
            'SCHOOL_EVENT',
            'EXAM_DAY',
            'ACTIVITY',
            'ANNOUNCEMENT',
            'OTHER',
            'WEEKEND_OVERRIDE',
            'SHORT_DAY',
          ],
        },
      },
      {
        name: 'class_ids',
        in: 'query',
        schema: { type: 'string' },
        description:
          'Comma-separated accessible section UUIDs; school-wide events remain included.',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
    description:
      'calendar.read; date span <=366 days. Returns paginated events with id,title,description,kind,start_date,end_date,audience,class_ids,targets,version. Target labels are projected through class authorization. Existing multi-day events overlapping the range are included even when they start before it.',
  },
);
const calendarId = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
operation(
  '/calendar/events/{id}',
  'get',
  'Calendar read: one applicable event or scope-safe 404',
  undefined,
  'UserJWT',
  { parameters: [calendarId] },
);
operation(
  '/calendar/events',
  'post',
  'School Admin calendar.write only: create one school-wide or multi-section event',
  'CalendarEvent',
  'UserJWT',
  { parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }] },
);
const calendarResponses = (paths['/calendar/events'].post as { responses: Record<string, unknown> })
  .responses;
calendarResponses['201'] = {
  description: 'Calendar event created; idempotent retries return the same event.',
};
delete calendarResponses['200'];
operation(
  '/calendar/events/{id}',
  'patch',
  'School Admin only: update complete event details and targets with expected_version',
  'CalendarEventUpdate',
  'UserJWT',
  {
    parameters: [calendarId, { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
  },
);
operation(
  '/calendar/events/{id}',
  'delete',
  'School Admin only: remove event from calendars while preserving audited history',
  'CalendarEventDelete',
  'UserJWT',
  {
    parameters: [calendarId, { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
  },
);
operation(
  '/academics/classes',
  'get',
  'School Admin only; class/section summaries with student_count, male_count, female_count, other_count, unspecified_count for dated active enrollments, assigned subjects, Class Teacher and school sessions with dates',
  undefined,
  'UserJWT',
  {
    parameters: [
      {
        name: 'X-School-Id',
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      { name: 'session_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
  },
);
operation(
  '/academics/classes/{id}/subjects',
  'post',
  'School Admin only; atomically create or select a subject and assign its required teacher to this section; academics.write and teachers.write',
  'ClassSubject',
  'UserJWT',
  {
    parameters: [
      {
        name: 'X-School-Id',
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
    ],
    description:
      'Supply exactly one of subject_id or subject {code,name}. teacher_id and starts_on are required. Both records commit together; invalid teachers roll back new subjects. Other sections are unchanged.',
  },
);
for (const child of ['subjects', 'enrollments', 'unconfigured-assignments'])
  operation(
    `/academics/classes/{id}/${child}`,
    'get',
    `School Admin only; school- and class-scoped ${child}`,
    undefined,
    'UserJWT',
    {
      parameters: [
        {
          name: 'X-School-Id',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
        { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ...(child === 'enrollments'
          ? [
              {
                name: 'view',
                in: 'query',
                schema: { type: 'string', enum: ['current', 'all'], default: 'current' },
              },
            ]
          : []),
      ],
    },
  );
operation(
  '/lookups/class-teachers',
  'get',
  'Eligible active Teacher profiles for class_id designation, including new classes; academics.write',
  undefined,
  'UserJWT',
  {
    parameters: [
      { name: 'class_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
    ],
  },
);
operation(
  '/school',
  'patch',
  'Update school name, IANA timezone and notification locale; school.manage',
);
operation(
  '/school/retention',
  'get',
  'Read approved document/notification retention policy; school.manage',
);
operation(
  '/school/retention',
  'put',
  'Record an approved retention policy; no child/audit record deletion',
  'RetentionPolicy',
);
operation('/school/retention', 'delete', 'Stop future retention cleanup; school.manage');
operation('/support-access', 'get', 'Current school approved support-access notice');
operation(
  '/devices/{id}/configurations',
  'get',
  'Paginated append-only configuration history; devices.read',
);
operation(
  '/devices/{id}',
  'patch',
  'Change reader state and safe tuning; partial config preserves omitted keys',
);
operation(
  '/notifications/members',
  'get',
  'School Admin: paginated active members and push-device counts; search/role filters. Never returns raw tokens.',
);
operation(
  '/notifications/preview',
  'post',
  'School Admin: validate school recipients and preview FCM readiness.',
  'CustomNotification',
);
operation(
  '/notifications/messages',
  'post',
  'School Admin: queue custom FCM message with mandatory Idempotency-Key; durable recipient snapshot.',
  'CustomNotification',
);
operation(
  '/notifications/messages',
  'get',
  'School Admin / Principal: paginated school outbox; kind/status filters.',
);
operation(
  '/notifications/messages/{id}/deliveries',
  'get',
  'School Admin / Principal: paginated delivery status, no device credentials.',
);
operation(
  '/notifications/messages/{id}/cancel',
  'post',
  'School Admin: cancel pending work with audited reason; cannot recall accepted messages.',
  'Reconciliation',
);
operation(
  '/notifications/settings',
  'get',
  'School Admin: school channel and event controls, optimistic version.',
);
operation(
  '/notifications/settings',
  'put',
  'School Admin: save versioned school notification controls.',
  'SchoolNotificationSettings',
);
operation(
  '/push-tokens',
  'post',
  'Any active school member: register encrypted FCM endpoint for own account.',
);
operation('/push-tokens', 'delete', 'Unregister only own endpoint by SHA-256 token_hash.');
operation('/reports', 'get', 'Own reports');
operation('/reports', 'post', 'Queue a private report', 'ReportRequest');
operation('/reports/{id}/download', 'get', 'Obtain a short-lived authorized download');
for (const [p, m, n] of [
  ['/device/events/batch', 'post', 'DeviceBatch'],
  ['/device/heartbeat', 'post', 'Heartbeat'],
  ['/device/config', 'get', null],
  ['/device/sync-ack', 'post', 'SyncAck'],
  ['/device/ota/status', 'post', 'OtaStatus'],
] as const)
  operation(p, m, p, n || undefined, 'DeviceCredential');
for (const p of [
  '/devices',
  '/notifications',
  '/subscription',
  '/audit',
  '/memberships',
  '/support-grants',
])
  operation(p, 'get', `Read ${p}`);
for (const p of ['/schools', '/devices', '/plans', '/support-grants']) {
  operation('/platform' + p, 'get', `Platform metadata ${p}`);
  if (p !== '/plans') operation('/platform' + p, 'post', `Platform operation ${p}`);
}
operation(
  '/platform/operations',
  'get',
  'MFA-protected aggregate usage, backlog and private worker health',
);
operation(
  '/platform/plans/{id}',
  'patch',
  'Edit defined plan features/limits; reason and MFA required',
);
operation(
  '/platform/schools/{id}/subscription',
  'patch',
  'Edit subscription; omitted overrides and grace period are preserved',
);
operation(
  '/platform/schools/{id}/administrator-invitation',
  'post',
  'Invite first School Admin only; email side effect, verified email acceptance and MFA',
  'FirstSchoolAdministrator',
);
operation(
  '/platform/schools/{id}/administrator-invitation/{invitation}/cancel',
  'post',
  'Cancel first-admin invitation before acceptance; MFA required',
);
operation(
  '/platform/support-grants/{id}/{feature}',
  'get',
  'Approved, scoped, paginated support read; live grant lock and audit in one transaction',
);
for (const [path, method, summary, schema] of [
  ['/support-requests', 'get', 'Own school support requests; no implied support grant', undefined],
  ['/support-requests', 'post', 'School Admin support intake', 'SupportRequest'],
  ['/platform/support-requests', 'get', 'School support queue', undefined],
  ['/platform/support-requests/{id}', 'patch', 'Platform support response', 'SupportResponse'],
  ['/platform/notices', 'get', 'Metadata-only lifecycle and device escalations', undefined],
  ['/school/security', 'get', 'Read approved school security policy', undefined],
  ['/school/security', 'put', 'Set policy; school.manage and verified MFA', 'SchoolSecurity'],
  ['/analytics', 'get', 'Current authorized academic and attendance aggregates', undefined],
  ['/attendance/events', 'get', 'Scoped raw movement history', undefined],
  [
    '/attendance/events/{id}/reconcile',
    'post',
    'Request review without rewriting the raw event',
    'Reconciliation',
  ],
  ['/attendance/reviews', 'get', 'Scoped review queue', undefined],
  ['/profile/family', 'get', 'Own permitted family profile', undefined],
  ['/profile/preferences', 'get', 'Parent lock-screen privacy', undefined],
  ['/profile/preferences', 'put', 'Update parent privacy', 'NotificationPrivacy'],
  ['/exports', 'get', 'School Admin exports', undefined],
  ['/exports', 'post', 'Request consistent full-school export', 'SchoolExport'],
  ['/exports/{id}', 'get', 'Current authorized export manifest', undefined],
  ['/exports/{id}/files/{index}', 'get', 'Authorized private export object', undefined],
  ['/offboarding', 'get', 'Own school closure proposal', undefined],
  ['/offboarding/{id}/approve', 'post', 'School Admin contractual approval', undefined],
  ['/usage', 'get', 'Own persisted daily usage', undefined],
  [
    '/organization/campuses',
    'get',
    'Same organization campuses with explicit membership',
    undefined,
  ],
  ['/notifications/{id}/retry', 'post', 'Admin retry with reason', 'Reconciliation'],
  ['/devices/{id}/health', 'get', 'Paginated device health history', undefined],
  ['/platform/audit', 'get', 'Platform metadata audit only', undefined],
  ['/platform/usage', 'get', 'Persisted platform usage', undefined],
  ['/platform/organizations', 'get', 'Campus groups', undefined],
  ['/platform/organizations', 'post', 'Create campus group', undefined],
  [
    '/platform/schools/{id}/organization',
    'patch',
    'Associate Enterprise campus; never grants membership',
    'CampusAssociation',
  ],
  ['/platform/offboarding', 'get', 'School closure review', undefined],
  [
    '/platform/schools/{id}/offboarding',
    'post',
    'Propose contractual export/retention windows',
    undefined,
  ],
  [
    '/platform/offboarding/{id}/close',
    'post',
    'Close after distinct school approval and device synchronization',
    undefined,
  ],
  ['/platform/offboarding/{id}/hold', 'post', 'Record legal hold decision', undefined],
  [
    '/platform/offboarding/{id}/purge',
    'post',
    'Queue approved operational-data deletion',
    undefined,
  ],
] as const)
  operation(path, method, summary, schema);
for (const name of [
  'students',
  'parents',
  'teachers',
  'student_parents',
  'teacher_class_assignments',
])
  operation('/imports/' + name, 'post', 'Validate or atomically import up to 500 named records');
for (const name of [
  'academic_sessions',
  'classes',
  'subjects',
  'exams',
  'assignments',
  'timetable_entries',
  'school_holidays',
  'announcements',
  'teacher_class_assignments',
])
  operation(
    '/resources/' + name + '/{id}/retire',
    'post',
    'Retire record; preserve history',
    'Retirement',
  );
operation(
  '/platform/firmware-releases',
  'get',
  'Paginated immutable signed release metadata; platform MFA',
);
operation(
  '/platform/firmware-releases',
  'post',
  'Publish disabled signed image; approved RSA-3072 public key required',
  undefined,
  'UserJWT',
  {
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            required: ['image', 'manifest'],
            properties: {
              image: {
                type: 'string',
                format: 'binary',
                description: 'ESP-IDF signed app image; 1024..1245184 bytes',
              },
              manifest: { type: 'string', description: 'JSON encoding of FirmwareManifest' },
            },
            additionalProperties: false,
          },
        },
      },
    },
    responses: {
      '201': { description: 'Immutable release published, enabled=false' },
      '413': { description: 'Image exceeds application partition size' },
      '422': { description: 'Invalid manifest, hash, signature or image' },
      '403': { description: 'Platform MFA required' },
      '503': { description: 'Signing configuration or private storage unavailable' },
    },
  },
);
operation(
  '/platform/firmware-releases/{version}',
  'patch',
  'Enable accepted release or disable future offers',
  'FirmwareApproval',
);
operation(
  '/platform/devices/{id}/hardware',
  'patch',
  'Record physical hardware verification; never infer from device name',
  'HardwareVerification',
);
operation(
  '/platform/devices/{id}/ota',
  'post',
  'Assign accepted release or withdraw reader assignment',
  'FirmwareAssignment',
);
operation(
  '/device/ota/image/{version}',
  'get',
  'Assigned reader authenticated image download; SHA-256 checked',
  '',
  'DeviceCredential',
  {
    responses: {
      '200': {
        description: 'Private signed application bytes',
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
      '404': { description: 'No matching active assignment' },
      '503': { description: 'Storage unavailable or integrity failed' },
    },
  },
);
for (const [path, method, summary, schema] of [
  ['/fees/options', 'get', 'Accessible fee year and class choices', ''],
  ['/fees/students', 'get', 'Paginated authorized fee students; academic_session_id required', ''],
  [
    '/fees/students/{id}',
    'get',
    'Authoritative academic/transport statement and payment history; academic_session_id required',
    '',
  ],
  [
    '/fees/assessments/{id}',
    'get',
    'Authorized installment lookup for existing student-profile payment links',
    '',
  ],
  ['/fees/payments/{id}', 'get', 'Authorized immutable receipt and reversal status', ''],
  [
    '/fees/structures',
    'get',
    'Paginated class fee versions; academic_session_id and grade required',
    '',
  ],
  [
    '/fees/structures',
    'post',
    'Create an immutable class-wide or section fee version',
    'FeeStructure',
  ],
  [
    '/fees/assessments/preview',
    'post',
    'Preview only unassessed enrollment installments',
    'FeeAssessment',
  ],
  [
    '/fees/assessments',
    'post',
    'Idempotently assess class-section or student without rewriting prior charges',
    'FeeAssessment',
  ],
  [
    '/fees/assessments/{id}/void',
    'post',
    'Void an unpaid assessment with audit reason',
    'FeeCorrection',
  ],
  [
    '/fees/payments',
    'post',
    'Record balanced multi-installment payment; required durable Idempotency-Key; manual receipt override School Admin-only',
    'FeeCollection',
  ],
  [
    '/fees/payments/{id}/reverse',
    'post',
    'Reverse full payment with immutable original receipt; required Idempotency-Key',
    'FeeCorrection',
  ],
  ['/fees/routes', 'get', 'List transport routes for authorized school staff', ''],
  ['/fees/routes', 'post', 'Create transport route', 'FeeTransportRoute'],
  [
    '/fees/routes/{id}',
    'patch',
    'Edit or deactivate route; posted student prices unchanged',
    'FeeTransportRoute',
  ],
  [
    '/fees/transport',
    'post',
    'Assign service and assess transport installments; required Idempotency-Key',
    'FeeTransportAssignment',
  ],
  [
    '/fees/transport/{id}/end',
    'post',
    'End service; reason plus ended_on date; void future unpaid installments',
    'FeeTransportEnd',
  ],
  [
    '/fees/reports',
    'get',
    'Staff-only year/class/section/student/category summaries, paginated assessments and date-wise net collections',
    '',
  ],
  [
    '/fees/reports/export',
    'get',
    'Staff-only Excel-compatible CSV JSON download; max 10000 rows, spreadsheet formula protection',
    '',
  ],
] as const)
  operation(path, method, summary, schema || undefined);
for (const path of [
  '/fees/students',
  '/fees/students/{id}',
  '/fees/structures',
  '/fees/reports',
  '/fees/reports/export',
]) {
  const op = paths[path].get as { parameters: unknown[] };
  const fields =
    path === '/fees/structures'
      ? ['academic_session_id', 'grade', 'page', 'page_size']
      : path === '/fees/students/{id}'
        ? ['academic_session_id']
        : path.startsWith('/fees/reports')
          ? [
              'academic_session_id',
              'grade',
              'class_id',
              'student_id',
              'category',
              'search',
              'from',
              'to',
              'page',
              'page_size',
            ]
          : ['academic_session_id', 'grade', 'class_id', 'search', 'page', 'page_size'];
  for (const name of fields)
    op.parameters.push({
      name,
      in: 'query',
      required:
        (name === 'academic_session_id' && !path.startsWith('/fees/reports')) ||
        (path === '/fees/structures' && name === 'grade'),
      schema: name.endsWith('_id')
        ? { type: 'string', format: 'uuid' }
        : name === 'page' || name === 'page_size'
          ? { type: 'integer', minimum: 1, ...(name === 'page_size' ? { maximum: 100 } : {}) }
          : name === 'from' || name === 'to'
            ? { type: 'string', format: 'date' }
            : { type: 'string' },
    });
}
for (const path of ['/fees/payments', '/fees/payments/{id}/reverse', '/fees/transport']) {
  const op = paths[path].post as { parameters: unknown[] };
  op.parameters.push({
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 8, maxLength: 200, pattern: '^[a-zA-Z0-9:_-]+$' },
  });
}
for (const [path, methods] of Object.entries(paths))
  for (const op of Object.values(methods)) {
    const o = op as {
      parameters: { name: string; in: string; required?: boolean; schema: unknown }[];
    };
    for (const m of path.matchAll(/\{([^}]+)\}/g))
      if (!o.parameters.some((p) => p.in === 'path' && p.name === m[1]))
        o.parameters.push({
          name: m[1],
          in: 'path',
          required: true,
          schema:
            m[1] === 'version'
              ? { type: 'string', pattern: '^\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}$' }
              : m[1] === 'index'
                ? { type: 'integer', minimum: 0 }
                : m[1] === 'feature'
                  ? { type: 'string', enum: ['students', 'attendance', 'marks', 'fees'] }
                  : { type: 'string', format: 'uuid' },
        });
  }
const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Vidyalayaa REST & NFC Device API',
    version: '1.0.0',
    description:
      'SAS v1.0. All paths are relative to /api/v1. School selection is never authority. Zod refinements (ordering and window consistency) execute on the server in addition to this JSON Schema.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: {
      UserJWT: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      DeviceCredential: {
        type: 'http',
        scheme: 'bearer',
        description: 'Per-device random bearer secret plus required X-Device-Id',
      },
    },
    schemas: Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, json(v)])),
  },
  paths,
};
await mkdir('docs/api', { recursive: true });
await writeFile('docs/api/openapi.json', JSON.stringify(spec, null, 2) + '\n');
console.info('Generated OpenAPI from shared Zod contracts.');

await writeFile(
  'firmware/include/protocol.generated.h',
  `// Generated by npm run contracts. Do not edit.\n#pragma once\n#define VIDYALAYAA_PROTOCOL_VERSION ${deviceProtocol.version}\n#define VIDYALAYAA_MAX_BATCH_EVENTS ${deviceProtocol.maxBatchEvents}\n#define VIDYALAYAA_DEVICE_CODE_MAX ${deviceProtocol.maxDeviceCodeLength}\n`,
);
