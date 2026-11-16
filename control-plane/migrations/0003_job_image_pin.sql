-- Per-job renderer pin: the image (and so the exact style files) a job was accepted with.
-- Replacement pods reuse it, so a later global RENDERER_IMAGE change can't swap a job's style mid-flight.
-- Additive: older Workers ignore the column.
ALTER TABLE jobs ADD COLUMN renderer_image TEXT;
