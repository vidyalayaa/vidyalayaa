-- Rename in place: retain all existing values, indexes, defaults and ownership.
ALTER TABLE public.students RENAME COLUMN sex TO gender;
ALTER TABLE public.students RENAME CONSTRAINT students_sex_check TO students_gender_check;
COMMENT ON COLUMN public.students.gender IS
  'Recorded gender for school records and enrollment statistics. NOT_SPECIFIED preserves legacy/unknown records.';
