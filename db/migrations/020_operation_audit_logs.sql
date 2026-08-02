-- 020: Immutable user operation audit log.
-- Keep audit rows after a workflow is deleted so destructive actions remain traceable.

CREATE TABLE IF NOT EXISTS workflow_operation_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  installation_id TEXT,
  action TEXT NOT NULL CHECK (action IN (
    'workflow-created',
    'workflow-updated',
    'workflow-deleted',
    'pull-created',
    'pull-merged',
    'actions-rerun',
    'deployment-rerun',
    'deployment-rollback'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  repository TEXT,
  workflow_id TEXT,
  stage_id TEXT,
  source TEXT,
  target TEXT,
  pull_number INTEGER,
  run_id BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_operation_audit_logs_user_recent_idx
  ON workflow_operation_audit_logs (user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS workflow_operation_audit_logs_workflow_recent_idx
  ON workflow_operation_audit_logs (user_id, workflow_id, occurred_at DESC)
  WHERE workflow_id IS NOT NULL;
