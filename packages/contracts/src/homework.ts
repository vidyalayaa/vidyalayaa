export type HomeworkDiaryEntry = {
  id: string;
  title: string;
  body: string | null;
  instructions: string | null;
  reference_url: string | null;
  storage_path: string | null;
  due_at: string | null;
  assigned_on: string;
  subject: string | null;
  grade: string;
  section: string;
} & Record<string, unknown>;
export interface HomeworkDiaryResponse {
  data: HomeworkDiaryEntry[];
  dates: { date: string; count: number }[];
  classes: { id: string; grade: string; section: string }[];
  total: number;
  page: number;
  page_size: number;
}
