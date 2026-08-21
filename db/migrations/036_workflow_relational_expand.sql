-- Expand step of the workflow payload split (docs/supabase-egress-optimization.md 第五轮, step 1).
--
-- The single `pr_helper_workflows.payload` jsonb is still the only truth after this migration: nothing
-- reads these columns or tables yet, the writer merely mirrors into them. That is deliberate — the read
-- switch (a later migration) must have a representation to switch onto that has already been observed
-- filling correctly under real traffic, and this step is independently reversible by dropping it.
--
-- Every promoted column is nullable, including `name` and `repository`, which the type in
-- src/lib/workflow.ts declares required. Rows that predate this migration have no value to put there,
-- and a NOT NULL default would invent one. The backfill step tightens them once every row has a value.

ALTER TABLE pr_helper_workflows
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS repository text,
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS version integer,
  ADD COLUMN IF NOT EXISTS position integer,
  -- Distinct from the row's own `created_at`: this is the client-declared creation time carried in the
  -- payload, and it is text so a round trip cannot reformat it into Postgres's timestamp rendering.
  ADD COLUMN IF NOT EXISTS declared_created_at text,
  ADD COLUMN IF NOT EXISTS recovery_max_retries integer,
  ADD COLUMN IF NOT EXISTS recovery_cooldown_seconds integer;

CREATE TABLE IF NOT EXISTS workflow_stages (
  user_id uuid NOT NULL,
  workflow_id text NOT NULL,
  stage_id text NOT NULL,
  stage_index integer NOT NULL,
  source_rule text NOT NULL,
  target text NOT NULL,
  independent boolean,
  wait_for integer[],
  auto_create boolean,
  auto_merge boolean,
  execution_mode text,
  trigger_min_commits integer,
  rule_name text,
  rule_captured_at text,
  -- References pr_helper_generation_rules (user_id, content_hash) from migration 035 by value rather
  -- than by constraint: a stage may name a rule whose content row was pruned, and the enqueue path
  -- already refuses that case loudly instead of writing an empty prompt.
  rule_content_hash text,
  PRIMARY KEY (user_id, workflow_id, stage_id),
  FOREIGN KEY (user_id, workflow_id) REFERENCES pr_helper_workflows (user_id, id) ON DELETE CASCADE
);

-- The read switch will filter the sweep by branch rule and target, which is the push-down the third
-- round had to abandon while both lived inside jsonb.
CREATE INDEX IF NOT EXISTS workflow_stages_source_rule_idx ON workflow_stages (user_id, source_rule);
CREATE INDEX IF NOT EXISTS workflow_stages_target_idx ON workflow_stages (user_id, target);

-- Named for what it holds: the workflow's deployment *configuration*. The existing
-- workflow_stage_deployments and workflow_stage_deployment_runs hold observed runs, not config.
CREATE TABLE IF NOT EXISTS workflow_deployment_configs (
  user_id uuid NOT NULL,
  workflow_id text NOT NULL,
  -- Ordinal, not a natural key: two deployments may legitimately share a target with different
  -- providers or environments, so the array position is the only stable identity.
  position integer NOT NULL,
  target text NOT NULL,
  provider text NOT NULL,
  workflow_name text NOT NULL,
  environment text NOT NULL,
  github_environment text,
  health_check_path text,
  rollback_workflow_name text,
  PRIMARY KEY (user_id, workflow_id, position),
  FOREIGN KEY (user_id, workflow_id) REFERENCES pr_helper_workflows (user_id, id) ON DELETE CASCADE
);
