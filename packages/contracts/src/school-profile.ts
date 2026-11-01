import { z } from 'zod';
import type { TimetableSettings } from './timetable.js';
const text = (max = 200) => z.string().trim().max(max).default('');
const email = z.union([z.literal(''), z.string().trim().email().max(254)]).default('');
const phone = z
  .string()
  .trim()
  .max(40)
  .refine((v) => !v || /^[+\d][\d\s().-]{5,39}$/.test(v), 'Enter a valid contact number.')
  .default('');
const website = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    if (!v) return true;
    try {
      const u = new URL(v);
      return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'Use an http:// or https:// website address.')
  .default('');
export const schoolProfileDetailsSchema = z
  .object({
    tagline: text(),
    motto: text(),
    about: text(5000),
    established_year: z
      .string()
      .regex(/^(|\d{4})$/)
      .default(''),
    school_type: text(100),
    address_line1: text(300),
    address_line2: text(300),
    locality: text(150),
    city: text(100),
    district: text(100),
    state: text(100),
    postal_code: text(20),
    country: text(100),
    email,
    phone,
    alternate_phone: phone,
    website,
    principal_name: text(),
    principal_email: email,
    principal_phone: phone,
    principal_qualification: text(300),
    board: text(100),
    affiliation_number: text(100),
    recognition_number: text(100),
    recognized_by: text(),
    recognition_valid_until: z
      .string()
      .refine(
        (v) =>
          !v ||
          (/^\d{4}-\d{2}-\d{2}$/.test(v) &&
            !Number.isNaN(Date.parse(v)) &&
            new Date(v).toISOString().slice(0, 10) === v),
        'Choose a valid recognition date.',
      )
      .default(''),
    udise_code: text(40),
    grades_offered: text(200),
    medium: text(200),
    academic_pattern: text(300),
    office_hours: text(200),
    visiting_hours: text(200),
    facilities: z.array(z.string().trim().min(1).max(100)).max(40).default([]),
    infrastructure: text(5000),
    accessibility: text(3000),
    transport_information: text(3000),
    emergency_phone: phone,
    emergency_instructions: text(3000),
    policies: text(12000),
  })
  .strict();
export const schoolProfileAdminSchema = z
  .object({
    management_name: text(),
    management_contact_name: text(),
    management_email: email,
    management_phone: phone,
    management_address: text(1000),
    internal_emergency_contacts: text(4000),
    internal_policies: text(10000),
  })
  .strict();
export const schoolProfileUpdateSchema = z
  .object({
    expected_version: z.number().int().min(0).max(2147483646),
    name: z.string().trim().min(2).max(200),
    timezone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v }).format();
          return true;
        } catch {
          return false;
        }
      }, 'Choose a valid IANA timezone.'),
    locale: z.enum(['en-IN', 'hi-IN']),
    details: schoolProfileDetailsSchema,
    administration: schoolProfileAdminSchema.optional(),
    principal_edit_authorized: z.boolean().optional(),
  })
  .strict();
export const schoolCreateSchema = z
  .object({
    school_code: z.string().regex(/^[A-Z0-9_-]{3,32}$/),
    name: z.string().trim().min(2).max(200),
    timezone: schoolProfileUpdateSchema.shape.timezone,
    plan_code: z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']),
    trial_ends_at: z.string().datetime(),
    email: email.optional(),
    phone: phone.optional(),
    address_line1: text(300).optional(),
    city: text(100).optional(),
    state: text(100).optional(),
    postal_code: text(20).optional(),
    country: text(100).optional(),
  })
  .strict();
export const schoolAssetSchema = z
  .object({ kind: z.enum(['LOGO', 'IMAGE', 'POLICY']), title: z.string().trim().min(1).max(150) })
  .strict();
export type SchoolProfileDetails = z.infer<typeof schoolProfileDetailsSchema>;
export type SchoolProfileAdmin = z.infer<typeof schoolProfileAdminSchema>;
export type SchoolProfileUpdate = z.infer<typeof schoolProfileUpdateSchema>;
export interface SchoolProfileAsset {
  id: string;
  kind: 'LOGO' | 'IMAGE' | 'POLICY';
  title: string;
  content_type: string;
  size: number;
  created_at: string;
}
export interface ProfileCompletion {
  percent: number;
  complete: number;
  total: number;
  missing: { key: string; label: string; section: string }[];
}
export interface SchoolProfile {
  school_id: string;
  school_code: string;
  name: string;
  timezone: string;
  locale: 'en-IN' | 'hi-IN';
  version: number;
  details: SchoolProfileDetails;
  administration?: SchoolProfileAdmin;
  principal_edit_authorized?: boolean;
  can_edit: boolean;
  can_delegate: boolean;
  can_manage_timings: boolean;
  completion: ProfileCompletion | null;
  assets: SchoolProfileAsset[];
  timings: TimetableSettings;
  announcements: { id: string; title: string; body: string; published_at: string }[];
}
export function schoolProfileCompletion(p: {
  name: string;
  details: SchoolProfileDetails;
  administration?: SchoolProfileAdmin;
  assets: SchoolProfileAsset[];
  timings: TimetableSettings;
}): ProfileCompletion {
  const d = p.details,
    a = p.administration;
  const checks: [string, string, string, unknown][] = [
    ['name', 'School name', 'Identity', p.name],
    ['logo', 'School logo', 'Images', p.assets.some((v) => v.kind === 'LOGO')],
    ['about', 'About the school', 'Identity', d.about],
    ['address_line1', 'Street address', 'Contact', d.address_line1],
    ['city', 'City', 'Contact', d.city],
    ['state', 'State / region', 'Contact', d.state],
    ['postal_code', 'Postal code', 'Contact', d.postal_code],
    ['country', 'Country', 'Contact', d.country],
    ['email', 'School email', 'Contact', d.email],
    ['phone', 'Official contact number', 'Contact', d.phone],
    ['principal_name', 'Principal name', 'Leadership', d.principal_name],
    ['management_name', 'Management organization', 'Administration', a?.management_name],
    ['management_phone', 'Management contact number', 'Administration', a?.management_phone],
    ['board', 'Education board', 'Affiliation', d.board],
    [
      'recognition',
      'Affiliation or recognition number',
      'Affiliation',
      d.affiliation_number || d.recognition_number,
    ],
    ['grades_offered', 'Grades offered', 'Academics', d.grades_offered],
    ['medium', 'Medium of instruction', 'Academics', d.medium],
    ['timings', 'School timings', 'Academics', p.timings.configured],
    ['facilities', 'Facilities', 'Facilities', d.facilities.length],
    ['emergency_phone', 'Emergency contact number', 'Safety & policies', d.emergency_phone],
    ['policies', 'Important school policies', 'Safety & policies', d.policies],
  ];
  const missing = checks
    .filter((c) => !c[3])
    .map(([key, label, section]) => ({ key, label, section }));
  return {
    percent: Math.round((100 * (checks.length - missing.length)) / checks.length),
    complete: checks.length - missing.length,
    total: checks.length,
    missing,
  };
}
