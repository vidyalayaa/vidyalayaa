-- Additive change: preserve all existing students without guessing their sex.
ALTER TABLE public.students
  ADD COLUMN sex text NOT NULL DEFAULT 'NOT_SPECIFIED',
  ADD CONSTRAINT students_sex_check CHECK (sex IN ('NOT_SPECIFIED','MALE','FEMALE','OTHER'));
COMMENT ON COLUMN public.students.sex IS
  'Recorded sex for school records and enrollment statistics. NOT_SPECIFIED preserves legacy/unknown records.';
