export interface SubjectMaterial {
  id: string;
  title: string;
  body: string | null;
  created_at: string;
  has_attachment: boolean;
  filename: string | null;
}
