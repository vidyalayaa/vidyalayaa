import { z } from 'zod';
export const bulkMarksSchema = z
  .object({
    exam_id: z.string().uuid(),
    entries: z
      .array(
        z
          .object({
            student_id: z.string().uuid(),
            subject_id: z.string().uuid(),
            score: z.number().min(0).max(9999),
            remarks: z.string().max(2000).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((v, c) => {
    const keys = v.entries.map((x) => `${x.student_id}:${x.subject_id}`);
    if (new Set(keys).size !== keys.length)
      c.addIssue({ code: 'custom', message: 'Duplicate student/subject rows in upload' });
  });
