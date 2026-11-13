import { z } from 'zod';
import type { AcademicCohort, AcademicPerformance } from '@vidyalayaa/contracts';
import type { Config } from '../../lib/config.js';
import { hash } from '../../lib/crypto.js';
import { ApiError } from '../../lib/errors.js';

const text = z.string().trim().min(1).max(800);
const list = z.array(text).max(12);
export const academicAdviceSchema = z.object({
  summary: text,
  strengths: list,
  priorities: list,
  goals: z.object({ short_term: text, long_term: text }),
  tasks: z
    .array(
      z.object({
        day: z.number().int().min(1).max(7),
        subject: z.number().int().min(1),
        minutes: z.number().int().min(10).max(90),
        activity: text,
      }),
    )
    .min(1)
    .max(21),
});
const model = '@cf/openai/gpt-oss-20b';
const academicDisciplines: Readonly<Record<string, string>> = {
  math: 'mathematics',
  maths: 'mathematics',
  mathematics: 'mathematics',
  science: 'science',
  physics: 'physics',
  chemistry: 'chemistry',
  biology: 'biology',
  english: 'English',
  hindi: 'Hindi',
  sanskrit: 'Sanskrit',
  history: 'history',
  geography: 'geography',
  'social science': 'social science',
  economics: 'economics',
  'computer science': 'computer science',
  'physical education': 'physical education',
};
const rules = [
  'You are a supportive academic coach for a school. Use only supplied statistics for factual claims.',
  'Never invent reasons for a change, personal traits, syllabus chapters, exam dates, or peer scores.',
  'Point out missing or insufficient evidence and describe recommendations as optional guidance.',
  'When discussing a change use percentage points. Never write or redefine official grades or ranks.',
  'Refer to subjects as [S1], [S2], etc. using their supplied indices. Return only valid JSON, without Markdown.',
].join(' ');

export function academicFacts(performance: AcademicPerformance) {
  return {
    result: performance.report.student.percentage,
    status: performance.report.status,
    subjects: performance.subjects.map((subject, i) => ({
      index: i + 1,
      discipline: Object.hasOwn(academicDisciplines, subject.name.trim().toLowerCase())
        ? academicDisciplines[subject.name.trim().toLowerCase()]
        : null,
      percentage: subject.percentage,
      prior_percentage: subject.previous,
      change_points: subject.change,
      class_average: subject.class_average,
      spread_points: subject.consistency,
      assessments: subject.assessments,
    })),
    comparable_exam_percentages: performance.trend.slice(-8).map((item) => item.percentage),
  };
}

// The assistant never forwards free text to the provider. Questions are mapped
// to academic topics and, when recognized, an authorized subject index.
export function assistantQuestion(input: string, performance: AcademicPerformance) {
  const message = input.toLowerCase();
  const topic = /decreas|declin|drop|fell|worse|lower|why/.test(message)
    ? 'Explain observed decreases and what evidence would establish their cause'
    : /compar|previous|trend|progress|improving/.test(message)
      ? 'Compare with earlier comparable exams'
      : /attention|weak|strength|best|worst|priorit/.test(message)
        ? 'Identify current strengths and study priorities'
        : /study|practi|revis|improve|next|prepare|plan|help/.test(message)
          ? 'Give actionable study and revision guidance'
          : /marks|score|result|perform|exam|grade/.test(message)
            ? 'Summarize academic performance'
            : null;
  const subject = performance.subjects.findIndex(({ name }) => {
    const label = name.toLowerCase().trim();
    if (label === 'mathematics' || label === 'maths' || label === 'math')
      return /\bmath(?:s|ematics)?\b/.test(message);
    return label.length > 2 && message.includes(label);
  });
  if (!topic && subject < 0)
    throw new ApiError(
      422,
      'ACADEMIC_QUESTION_REQUIRED',
      'Ask about marks, progress, study priorities, or an available subject.',
    );
  return {
    topic: topic ?? 'Explain how to improve in this subject',
    subject: subject < 0 ? null : subject + 1,
    benchmark: /class average|classmate|peer/.test(message),
  };
}

export function schoolFacts(cohort: AcademicCohort) {
  const indexed = (entries: AcademicCohort['subjects']) =>
    entries.map(({ percentage, count }, i) => ({
      index: i + 1,
      percentage,
      count,
    }));
  return {
    appeared: cohort.appeared,
    passed: cohort.passed,
    failed: cohort.failed,
    average: cohort.average,
    highest: cohort.highest,
    lowest: cohort.lowest,
    classes: cohort.classes.slice(0, 30).map((row, i) => ({
      index: i + 1,
      percentage: row.percentage,
      average_change: row.average_change,
      improved: row.improved,
      compared: row.compared,
    })),
    subjects: indexed(cohort.subjects.slice(0, 30)),
    sessions: indexed(cohort.sessions.slice(0, 20)),
    distribution: cohort.distribution,
    declining_results: cohort.standings.filter((row) => row.change !== null && row.change < 0)
      .length,
  };
}

// The model sometimes returns "[S2]" for a subject, "Monday" for a day, strings for
// numbers, or a lone string where an array is expected. Coerce those shapes before
// strict validation so one cosmetic slip does not discard an otherwise valid plan.
const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
function integer(value: unknown) {
  if (typeof value === 'number') return Math.round(value);
  if (typeof value === 'string') {
    const digits = value.match(/\d+/);
    if (digits) return Number(digits[0]);
  }
  return Number.NaN;
}
function sentence(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 800) : value;
}
function sentences(value: unknown) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return items
    .map(sentence)
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, 12);
}
export function normalizeAdvice(value: unknown, subjectCount: number) {
  if (!value || typeof value !== 'object') return value;
  const raw = value as Record<string, unknown>;
  const goals =
    typeof raw.goals === 'string'
      ? { short_term: raw.goals, long_term: raw.goals }
      : ((raw.goals ?? {}) as Record<string, unknown>);
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .map((task, i) => {
      if (!task || typeof task !== 'object') return null;
      const t = task as Record<string, unknown>;
      const name = typeof t.day === 'string' ? weekdays.indexOf(t.day.trim().toLowerCase()) : -1;
      let day = name >= 0 ? name + 1 : integer(t.day);
      if (!(day >= 1 && day <= 7)) day = (i % 7) + 1;
      const minutes = integer(t.minutes);
      return {
        day,
        subject: integer(t.subject),
        minutes: Number.isNaN(minutes) ? 30 : Math.min(90, Math.max(10, minutes)),
        activity: sentence(t.activity ?? t.task ?? t.description),
      };
    })
    .filter(
      (task): task is NonNullable<typeof task> =>
        !!task &&
        task.subject >= 1 &&
        task.subject <= subjectCount &&
        typeof task.activity === 'string' &&
        task.activity.length > 0,
    )
    .slice(0, 21);
  return {
    summary: sentence(raw.summary),
    strengths: sentences(raw.strengths),
    priorities: sentences(raw.priorities),
    goals: {
      short_term: sentence(goals.short_term ?? goals.shortTerm),
      long_term: sentence(goals.long_term ?? goals.longTerm),
    },
    tasks,
  };
}

export function analysisKey(payload: unknown) {
  return hash(JSON.stringify(['academic-analysis-v1', model, payload]));
}

export function academicAi(config: Config) {
  const pending = new Map<string, Promise<unknown>>();
  const cache = new Map<string, { value: unknown; expires: number }>();
  const completion = z.object({
    choices: z
      .array(
        z.object({
          finish_reason: z.string().nullable().optional(),
          // Reasoning models can return null content when the budget runs out.
          message: z.object({ content: z.string().nullable().optional() }),
        }),
      )
      .min(1),
    usage: z.unknown().optional(),
  });
  async function generate<T>(
    payload: unknown,
    prompt: string,
    schema: z.ZodType<T>,
    key: string,
    options: { studyPlan?: boolean; normalize?: (value: unknown) => unknown } = {},
  ): Promise<T> {
    const { studyPlan = false, normalize } = options;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return schema.parse(cached.value);
    if (pending.has(key)) return schema.parse(await pending.get(key));
    const account = config.ACADEMIC_AI_CLOUDFLARE_ACCOUNT_ID;
    const token = config.ACADEMIC_AI_CLOUDFLARE_TOKEN;
    if (!account || !token)
      throw new ApiError(
        503,
        'ACADEMIC_AI_UNCONFIGURED',
        'AI guidance is unavailable until the school platform configures its AI service.',
      );
    if (pending.size >= 16)
      throw new ApiError(503, 'ACADEMIC_AI_BUSY', 'AI guidance is busy. Try again shortly.');
    const call = async () => {
      // A short assistant reply fits even when Workers AI uses its model default.
      // A full study plan needs an explicit Workers AI generation budget.
      const messages = [
        { role: 'system', content: `${rules}\n${prompt}` },
        { role: 'user', content: JSON.stringify(payload) },
      ];
      let failure = 'request';
      const detail: Record<string, unknown> = {};
      for (let attempt = 0; attempt < (studyPlan ? 2 : 1); attempt++) {
        failure = 'request';
        try {
          // Each attempt gets its own deadline. Previously one 45s signal was shared,
          // so a slow first attempt left the retry almost no time and it always timed out.
          const signal = AbortSignal.timeout(studyPlan ? 40000 : 25000);
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`,
            {
              method: 'POST',
              signal,
              redirect: 'error',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                reasoning_effort: 'low',
                ...(studyPlan
                  ? { max_tokens: attempt === 0 ? 3000 : 4096 }
                  : { max_completion_tokens: 3200 }),
                messages:
                  attempt === 0
                    ? messages
                    : [
                        ...messages.slice(0, 1),
                        {
                          role: 'system',
                          content:
                            'Keep every sentence short. Return a complete JSON object with seven brief activities, using numeric fields and only the provided subject indices.',
                        },
                        messages[1],
                      ],
              }),
            },
          );
          if (response.status === 429)
            throw new ApiError(
              429,
              'ACADEMIC_AI_LIMIT',
              'The AI usage limit has been reached. Try again later.',
            );
          if (!response.ok) {
            failure = `provider_http_${response.status}`;
            detail.provider = (await response.text().catch(() => '')).slice(0, 300);
            continue;
          }
          failure = 'invalid_response';
          const parsed = completion.safeParse(await response.json());
          const choice = parsed.success ? parsed.data.choices[0] : undefined;
          detail.finish_reason = choice?.finish_reason;
          detail.usage = parsed.success ? parsed.data.usage : undefined;
          if (!choice) continue;
          if (choice.finish_reason === 'length') {
            failure = 'truncated_response';
            continue;
          }
          // Tolerate Markdown fences or a stray sentence around the JSON object.
          const content = choice.message.content ?? '';
          const start = content.indexOf('{');
          const end = content.lastIndexOf('}');
          let decoded: unknown;
          try {
            if (start < 0 || end <= start) throw new Error('No JSON object');
            decoded = JSON.parse(content.slice(start, end + 1));
          } catch {
            failure = 'invalid_json';
            detail.content_length = content.length;
            continue;
          }
          const result = schema.safeParse(normalize ? normalize(decoded) : decoded);
          if (!result.success) {
            failure = 'invalid_schema';
            detail.issues = result.error.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
            continue;
          }
          const value = result.data;
          if (cache.size >= 512) cache.delete(cache.keys().next().value!);
          cache.set(key, { value, expires: Date.now() + 60 * 60 * 1000 });
          return value;
        } catch (error) {
          if (error instanceof ApiError) throw error;
          failure =
            (error as { name?: string } | null)?.name === 'TimeoutError' ? 'timeout' : 'request';
        }
      }
      console.warn('Academic AI generation failed', {
        operation: studyPlan ? 'study_plan' : 'summary',
        failure,
        ...detail,
      });
      throw new ApiError(
        503,
        'ACADEMIC_AI_UNAVAILABLE',
        'AI guidance is temporarily unavailable. Your published results are still available.',
      );
    };
    const promise = call();
    pending.set(key, promise);
    try {
      return await promise;
    } finally {
      pending.delete(key);
    }
  }
  return {
    advice: (facts: ReturnType<typeof academicFacts>, key: string) =>
      generate(
        facts,
        [
          'Return a JSON object with keys summary, strengths, priorities, goals and tasks.',
          'Write a short summary and 1-3 short sentences each for strengths and priorities (arrays of strings).',
          'Set goals.short_term and goals.long_term to one sentence each with realistic targets.',
          'Return seven concrete study activities, one for each day of the week.',
          'Each task has day (integer 1-7, Monday is 1), subject (a bare integer subject index such as 2, never "[S2]"), minutes (integer 10-90), and activity (one short sentence).',
          'Use the same subject index for multiple activities when appropriate. Tailor revision and practice to the supplied disciplines when available.',
        ].join(' '),
        academicAdviceSchema.refine(
          (advice) =>
            advice.tasks.every((task) => task.subject <= facts.subjects.length) &&
            new Set(advice.tasks.map((task) => task.day)).size >= 3,
        ),
        key,
        {
          studyPlan: true,
          normalize: (value) => normalizeAdvice(value, facts.subjects.length),
        },
      ),
    answer: (
      facts: ReturnType<typeof academicFacts>,
      question: ReturnType<typeof assistantQuestion>,
      key: string,
    ) =>
      generate(
        { ...facts, question },
        'Answer the supplied academic question in {answer:string}. If benchmark is true, use authorized class averages where present or explain that none are available. Use at most 110 words.',
        z.object({ answer: text }),
        key,
      ),
    school: (facts: ReturnType<typeof schoolFacts>, key: string) =>
      generate(
        facts,
        'Return {summary:string,insights:string[]}. Identify strengths, low averages and actionable academic support priorities. Use [C1], [S1] and [T1] for class, subject and session indices. Use comparable class changes when present. Session aggregates describe broad differences only. Do not assert an individual diagnosis or identify a student.',
        z.object({ summary: text, insights: list }),
        key,
      ),
  };
}
