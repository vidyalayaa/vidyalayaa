import { z } from 'zod';

export const personKind = z.enum(['student', 'staff']);
export type PersonKind = z.infer<typeof personKind>;
export const staffRoles = ['teacher', 'principal', 'school_admin', 'finance_staff'] as const;

const line = (max: number) => z.string().trim().max(max).optional();
export const studentContactSchema = z
  .object({
    contact_phone: line(40),
    address: line(1200),
  })
  .strict();

export const staffDetailsSchema = studentContactSchema
  .extend({
    designation: line(120),
    department: line(120),
    qualification: line(500),
    specialization: line(200),
    experience_years: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() ? Number(value) : value),
      z.number().min(0).max(80).multipleOf(0.5).optional(),
    ),
    joined_on: z.string().date().optional(),
    emergency_name: line(200),
    emergency_phone: line(40),
    emergency_relationship: line(100),
  })
  .strict();
export const staffDetailFields = Object.keys(staffDetailsSchema.shape);

export type StaffDetails = z.infer<typeof staffDetailsSchema>;
export type StudentContact = z.infer<typeof studentContactSchema>;
export type PersonPhoto = { id: string; photo_id: string | null };
export type StaffProfile = PersonPhoto & {
  full_name: string;
  staff_code: string;
  email: string | null;
  staff_role: string;
  status: string;
  details: StaffDetails;
  assignments: {
    grade: string;
    section: string;
    subject: string | null;
    session_name: string;
    class_teacher: boolean;
  }[];
};

export const MAX_PROFILE_PHOTOS_PER_ARCHIVE = 200;
export const MAX_PROFILE_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_PROFILE_PHOTO_BYTES = 10 * 1024 * 1024;

export type PhotoCandidate = PersonPhoto & { code: string; name: string };
export type PhotoPreview = {
  archive_hash: string;
  photos: {
    index: number;
    filename: string;
    code: string;
    thumbnail?: string;
    matched?: string;
    issue?: string;
    duplicate: boolean;
  }[];
  candidates: PhotoCandidate[];
  missing: number;
};
export const photoAssignmentsSchema = z
  .object({
    archive_hash: z.string().regex(/^[a-f0-9]{64}$/),
    assignments: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            person_id: z.guid(),
            expected_photo_id: z.guid().nullable(),
            replace: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PROFILE_PHOTOS_PER_ARCHIVE),
  })
  .strict()
  .refine(
    ({ assignments }) =>
      new Set(assignments.map((row) => row.index)).size === assignments.length &&
      new Set(assignments.map((row) => row.person_id)).size === assignments.length,
    'Select one photo per profile and one profile per photo.',
  );
export type PhotoAssignment = z.infer<typeof photoAssignmentsSchema>['assignments'][number];
export type PhotoImportResult = {
  saved: number;
  failed: { index: number; message: string }[];
  missing: number;
};
