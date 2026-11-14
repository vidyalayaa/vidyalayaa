import { z } from 'zod';

export const operationsTopics = [
  'attendance',
  'fees',
  'corrections',
  'devices',
  'timetable',
] as const;
export type OperationsTopic = (typeof operationsTopics)[number];

export const operationsQuestionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('brief') }).strict(),
  z
    .object({
      kind: z.literal('question'),
      question: z.string().trim().min(3).max(240),
      topic: z.enum(operationsTopics).optional(),
    })
    .strict(),
]);

export const operationsStaffRoles = [
  'school_admin',
  'principal',
  'teacher',
  'finance_staff',
] as const;
export const operationsTopicPermissions: Record<OperationsTopic, readonly string[]> = {
  attendance: ['attendance.read'],
  fees: ['fees.read'],
  corrections: ['attendance.read', 'attendance.correct_approve'],
  devices: ['devices.read'],
  timetable: ['timetable.read', 'calendar.read'],
};

export interface OperationsAnswer {
  date: string;
  notes: { topic: OperationsTopic; text: string; details?: string[] }[];
  summary?: string;
}
