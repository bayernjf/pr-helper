-- Append-only, user-visible history for the GitHub-synchronised workflow stages.
CREATE TABLE IF NOT EXISTS workflow_stage_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  stage_index integer NOT NULL,
  event_key text NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_key),
  FOREIGN KEY (user_id, workflow_id) REFERENCES pr_helper_workflows(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workflow_stage_events_recent_idx
  ON workflow_stage_events (user_id, occurred_at DESC);
