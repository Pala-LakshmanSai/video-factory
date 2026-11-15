-- Pod-creation safety (not yet applied remotely when written; apply before deploying the code that uses it).
-- create_claim: unique token of the selector run allowed to POST a create for this job. Set atomically before
--   the first POST, checked before every POST, cleared only on a definite outcome. While set and no POST is
--   running, the create outcome is unknown: the job is held, never replayed automatically.
-- create_uncertain_at: when the current claim was taken / the outcome became unknown.
-- admission_at: last selector attempt; the watchdog re-runs unclaimed admissions from it (never from
--   updated_at, which cost writes bump every minute).
ALTER TABLE jobs ADD COLUMN create_claim TEXT;
ALTER TABLE jobs ADD COLUMN create_uncertain_at INTEGER;
ALTER TABLE jobs ADD COLUMN admission_at INTEGER;
