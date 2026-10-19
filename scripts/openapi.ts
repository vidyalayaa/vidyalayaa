import { writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import {
  resourceSchemas,
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
  DeviceEvent: eventSchema,
  DeviceBatch: batchSchema,
  Heartbeat: heartbeatSchema,
  SyncAck: syncAckSchema,
  OtaStatus: otaSchema,
  AttendanceRules: ruleSchema,
  Correction: correctionSchema,
  ManualAttendance: manualSchema,
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
    ...extra,
  };
}
for (const name of Object.keys(resourceSchemas)) {
  operation(`/resources/${name}`, 'get', `List scoped ${name}`);
  operation(`/resources/${name}`, 'post', `Create ${name}`, name, 'UserJWT', {
    parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
  });
  operation(`/resources/${name}/{id}`, 'get', `Read scoped ${name}`);
  operation(`/resources/${name}/{id}`, 'patch', `Update ${name}`);
}
operation('/me', 'get', 'Verified identity, memberships, permissions and entitlements');
operation('/dashboard', 'get', 'Role-scoped school dashboard');
operation('/attendance', 'get', 'Paginated daily attendance');
operation('/attendance/manual', 'post', 'Manual classroom attendance', 'ManualAttendance');
operation('/corrections', 'get', 'Scoped correction requests');
operation('/corrections', 'post', 'Request a correction', 'Correction');
operation('/corrections/{id}/decision', 'post', 'Approve/reject; self-approval prohibited');
operation('/marks/bulk', 'post', 'Atomic, idempotent upload of up to 500 mark rows', 'BulkMarks');
operation('/invitations', 'post', 'Invite school member', 'Invitation');
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
for (const [path, methods] of Object.entries(paths))
  for (const op of Object.values(methods)) {
    const o = op as {
      parameters: { name: string; in: string; required?: boolean; schema: unknown }[];
    };
    for (const m of path.matchAll(/\{([^}]+)\}/g))
      o.parameters.push({
        name: m[1],
        in: 'path',
        required: true,
        schema:
          m[1] === 'feature'
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
