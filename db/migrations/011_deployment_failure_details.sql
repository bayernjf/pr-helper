ALTER TABLE workflow_stage_deployments
  ADD COLUMN IF NOT EXISTS failure_summary text,
  ADD COLUMN IF NOT EXISTS failure_job_url text;
