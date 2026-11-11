import { z } from 'zod';
export const markEntrySchema = z
  .object({
    student_id: z.guid(),
    subject_id: z.guid(),
    score: z.number().min(0).max(9999),
    remarks: z.string().max(2000).nullable().optional(),
  })
  .strict();
export const singleMarkSchema = z
  .object({ exam_id: z.guid(), entries: z.array(markEntrySchema).length(1) })
  .strict();
export const bulkMarksSchema = z
  .object({
    exam_id: z.guid(),
    entries: z.array(markEntrySchema).min(1).max(500),
  })
  .strict()
  .superRefine((v, c) => {
    const keys = v.entries.map((x) => `${x.student_id}:${x.subject_id}`);
    if (new Set(keys).size !== keys.length)
      c.addIssue({ code: 'custom', message: 'Duplicate student/subject rows in upload' });
  });
