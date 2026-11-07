-- Old heartbeats have no recorded deployment name.
ALTER TABLE worker_instances ADD COLUMN worker_name text
 CHECK (worker_name IS NULL OR char_length(worker_name) BETWEEN 1 AND 80);
