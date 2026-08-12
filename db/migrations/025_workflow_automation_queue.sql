-- 025: Versioned workflow automation runs and idempotent action queue.
CREATE TABLE IF NOT EXISTS workflow_automation_runs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  stage_index INTEGER NOT NULL,
  stage_id TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  workflow_snapshot JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'waiting-gates', 'paused', 'succeeded', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (user_id, workflow_id) REFERENCES pr_helper_workflows(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workflow_automation_runs_recent_idx
  ON workflow_automation_runs (user_id, workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_automation_actions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES workflow_automation_runs(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create-pr', 'merge-pr', 'advance-stage')),
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'paused', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS workflow_automation_actions_queue_idx
  ON workflow_automation_actions (state, created_at)
  WHERE state IN ('queued', 'running');
