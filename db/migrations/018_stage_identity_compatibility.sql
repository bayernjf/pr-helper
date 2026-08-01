-- 018: Add stable stage identity without removing stage_index compatibility.
-- Run after 017. The next migration can switch primary keys after validation.

ALTER TABLE workflow_stage_states
  ADD COLUMN IF NOT EXISTS stage_id text;

ALTER TABLE workflow_stage_events
  ADD COLUMN IF NOT EXISTS stage_id text,
  ADD COLUMN IF NOT EXISTS target text;

ALTER TABLE workflow_stage_deployments
  ADD COLUMN IF NOT EXISTS stage_id text;

ALTER TABLE workflow_stage_deployment_runs
  ADD COLUMN IF NOT EXISTS stage_id text;

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS stage_id text;

-- Normalize legacy workflow payloads first so every table can use the same ID.
WITH normalized AS (
  SELECT
    workflows.user_id,
    workflows.id,
    jsonb_agg(
      CASE
        WHEN NULLIF(stage.value ->> 'stageId', '') IS NULL
          THEN stage.value || jsonb_build_object('stageId', 's-db-' || replace(gen_random_uuid()::text, '-', ''))
        ELSE stage.value
      END
      ORDER BY stage.ordinality
    ) AS stages
  FROM pr_helper_workflows workflows
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(workflows.payload -> 'stages') = 'array'
      THEN workflows.payload -> 'stages'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS stage(value, ordinality)
  WHERE jsonb_typeof(workflows.payload -> 'stages') = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(workflows.payload -> 'stages') = 'array'
          THEN workflows.payload -> 'stages'
          ELSE '[]'::jsonb
        END
      ) AS existing(value)
      WHERE NULLIF(existing.value ->> 'stageId', '') IS NULL
    )
  GROUP BY workflows.user_id, workflows.id
)
UPDATE pr_helper_workflows workflows
SET payload = jsonb_set(workflows.payload, '{stages}', normalized.stages, false)
FROM normalized
WHERE workflows.user_id = normalized.user_id
  AND workflows.id = normalized.id;

UPDATE workflow_stage_states states
SET stage_id = workflows.payload -> 'stages' -> states.stage_index ->> 'stageId'
FROM pr_helper_workflows workflows
WHERE states.user_id = workflows.user_id
  AND states.workflow_id = workflows.id
  AND states.stage_id IS NULL;

UPDATE workflow_stage_states
SET stage_id = 's-legacy-' || md5(format('%s:%s:%s:%s', user_id, workflow_id, stage_index, source))
WHERE stage_id IS NULL;

UPDATE workflow_stage_events events
SET stage_id = states.stage_id,
    target = states.target
FROM workflow_stage_states states
WHERE events.user_id = states.user_id
  AND events.workflow_id = states.workflow_id
  AND events.stage_index = states.stage_index
  AND events.source IS NOT NULL
  AND events.source = states.source
  AND events.stage_id IS NULL;

UPDATE workflow_stage_events events
SET stage_id = 's-legacy-' || md5(format('%s:%s:%s:%s', user_id, workflow_id, stage_index, COALESCE(source, '')))
WHERE stage_id IS NULL;

UPDATE workflow_stage_events events
SET target = workflows.payload -> 'stages' -> events.stage_index ->> 'target'
FROM pr_helper_workflows workflows
WHERE events.user_id = workflows.user_id
  AND events.workflow_id = workflows.id
  AND events.target IS NULL;

UPDATE workflow_stage_deployments deployments
SET stage_id = states.stage_id
FROM workflow_stage_states states
WHERE deployments.user_id = states.user_id
  AND deployments.workflow_id = states.workflow_id
  AND deployments.stage_index = states.stage_index
  AND deployments.source = states.source
  AND deployments.stage_id IS NULL;

UPDATE workflow_stage_deployment_runs runs
SET stage_id = states.stage_id
FROM workflow_stage_states states
WHERE runs.user_id = states.user_id
  AND runs.workflow_id = states.workflow_id
  AND runs.stage_index = states.stage_index
  AND runs.source = states.source
  AND runs.stage_id IS NULL;

UPDATE workflow_runs runs
SET stage_id = COALESCE(
  NULLIF(runs.stage_snapshot ->> 'stageId', ''),
  workflows.payload -> 'stages' -> runs.stage_index ->> 'stageId',
  's-legacy-' || md5(format('%s:%s:%s:%s', runs.user_id, runs.workflow_id, runs.stage_index, runs.source))
)
FROM pr_helper_workflows workflows
WHERE runs.user_id = workflows.user_id
  AND runs.workflow_id = workflows.id
  AND runs.stage_id IS NULL;

CREATE INDEX IF NOT EXISTS workflow_stage_states_stage_id_idx
  ON workflow_stage_states (user_id, workflow_id, stage_id, source);

CREATE INDEX IF NOT EXISTS workflow_stage_events_stage_id_idx
  ON workflow_stage_events (user_id, workflow_id, stage_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS workflow_stage_deployments_stage_id_idx
  ON workflow_stage_deployments (user_id, workflow_id, stage_id, source, provider);

CREATE INDEX IF NOT EXISTS workflow_stage_deployment_runs_stage_id_idx
  ON workflow_stage_deployment_runs (user_id, workflow_id, stage_id, source, updated_at DESC);

CREATE INDEX IF NOT EXISTS workflow_runs_stage_id_idx
  ON workflow_runs (user_id, workflow_id, stage_id, started_at DESC);
