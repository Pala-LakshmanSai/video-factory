-- A create whose outcome is unknown (5xx / network error / unreadable 2xx and the pod not found by name):
-- the job is held here, with no replacement create, until the pod is found or confirmed absent.
ALTER TABLE jobs ADD COLUMN create_uncertain_at INTEGER;
