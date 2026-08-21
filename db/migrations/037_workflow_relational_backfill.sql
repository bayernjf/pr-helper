-- Backfill step of the workflow payload split (docs/supabase-egress-optimization.md 第五轮, step 2).
--
-- Migration 036 added the columns and tables; the writer only mirrors on save, so rows that nobody has
-- saved since have no mirror. This fills all of them and then proves the mirror is faithful.
--
-- Wrapped in an explicit transaction, unlike every earlier migration in this directory. The consistency
-- check at the end raises, and a half-applied backfill sitting next to a failed check is worse than no
-- backfill at all: the read switch would later be reasoning about rows nobody verified.
--
-- Idempotent: every write is an upsert or a delete-then-insert keyed on identity, so re-running is a
-- no-op rather than a duplicate.

BEGIN;

UPDATE pr_helper_workflows SET
  name = payload->>'name',
  repository = payload->>'repository',
  -- The column is NOT NULL and no live payload carries the key, so `NULL = 'true'` (which is NULL,
  -- not false) would violate the constraint outright.
  archived = COALESCE((payload->>'archived') = 'true', false),
  version = (payload->>'version')::int,
  position = (payload->>'position')::int,
  declared_created_at = payload->>'createdAt',
  recovery_max_retries = (payload->'recoveryPolicy'->>'maxRetries')::int,
  recovery_cooldown_seconds = (payload->'recoveryPolicy'->>'cooldownSeconds')::int;

DELETE FROM workflow_stages;
INSERT INTO workflow_stages (
  user_id, workflow_id, stage_id, stage_index, source_rule, target, independent, wait_for,
  auto_create, auto_merge, execution_mode, trigger_min_commits, rule_name, rule_captured_at, rule_content_hash
)
SELECT
  w.user_id,
  w.id,
  stage.value->>'stageId',
  (stage.ordinality - 1)::int,
  stage.value->>'source',
  stage.value->>'target',
  (stage.value->>'independent')::boolean,
  CASE WHEN stage.value ? 'waitFor' THEN ARRAY(SELECT jsonb_array_elements_text(stage.value->'waitFor')::int) END,
  CASE WHEN stage.value ? 'automation' THEN COALESCE((stage.value->'automation'->>'autoCreatePullRequest') = 'true', false) END,
  CASE WHEN stage.value ? 'automation' THEN COALESCE((stage.value->'automation'->>'autoMergePullRequest') = 'true', false) END,
  stage.value->'automation'->>'executionMode',
  (stage.value->'automation'->>'triggerMinCommits')::int,
  stage.value->'automation'->'generationRule'->>'name',
  stage.value->'automation'->'generationRule'->>'capturedAt',
  -- Payloads written before migration 035's code deployed still carry the content inline. Hashing it
  -- here is what lets the rule row written by 035 be found by the stage row written here.
  COALESCE(
    stage.value->'automation'->'generationRule'->>'contentHash',
    encode(extensions.digest(stage.value->'automation'->'generationRule'->>'content', 'sha256'), 'hex')
  )
FROM pr_helper_workflows w
CROSS JOIN LATERAL jsonb_array_elements(w.payload->'stages') WITH ORDINALITY AS stage(value, ordinality);

DELETE FROM workflow_deployment_configs;
INSERT INTO workflow_deployment_configs (
  user_id, workflow_id, position, target, provider, workflow_name, environment,
  github_environment, health_check_path, rollback_workflow_name
)
SELECT
  w.user_id, w.id, (deployment.ordinality - 1)::int,
  deployment.value->>'target', deployment.value->>'provider', deployment.value->>'workflowName', deployment.value->>'environment',
  deployment.value->>'githubEnvironment', deployment.value->>'healthCheckPath', deployment.value->>'rollbackWorkflowName'
FROM pr_helper_workflows w
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.payload->'deployments', '[]'::jsonb)) WITH ORDINALITY AS deployment(value, ordinality);

-- The consistency check. It rebuilds the workflow object out of the rows alone and compares it to the
-- payload field for field, which is the same guarantee api/_lib/workflow-rows.test.ts asserts in
-- TypeScript. Re-deriving it independently in SQL is the point: a shared implementation would agree
-- with itself even while both were wrong.
CREATE FUNCTION pr_helper_rebuild_workflow(p_user_id uuid, p_workflow_id text) RETURNS jsonb LANGUAGE sql STABLE AS $fn$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'id', w.id,
    'name', w.name,
    'repository', w.repository,
    'createdAt', w.declared_created_at,
    'position', w.position,
    'version', w.version,
    'archived', CASE WHEN w.archived THEN true END,
    'recoveryPolicy', CASE WHEN w.recovery_max_retries IS NOT NULL
      THEN jsonb_build_object('maxRetries', w.recovery_max_retries, 'cooldownSeconds', w.recovery_cooldown_seconds) END,
    'stages', (
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'source', s.source_rule,
        'target', s.target,
        'independent', s.independent,
        'waitFor', to_jsonb(s.wait_for),
        'stageId', s.stage_id,
        'automation', CASE WHEN s.execution_mode IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
          'autoCreatePullRequest', CASE WHEN s.auto_create THEN true END,
          'autoMergePullRequest', CASE WHEN s.auto_merge THEN true END,
          'executionMode', s.execution_mode,
          'triggerMinCommits', s.trigger_min_commits,
          'generationRule', CASE WHEN s.rule_name IS NOT NULL THEN jsonb_build_object(
            'name', s.rule_name, 'capturedAt', s.rule_captured_at, 'contentHash', s.rule_content_hash) END
        )) END
      )) ORDER BY s.stage_index)
      FROM workflow_stages s WHERE s.user_id = w.user_id AND s.workflow_id = w.id
    ),
    'deployments', (
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'target', d.target, 'provider', d.provider, 'workflowName', d.workflow_name, 'environment', d.environment,
        'githubEnvironment', d.github_environment, 'healthCheckPath', d.health_check_path,
        'rollbackWorkflowName', d.rollback_workflow_name
      )) ORDER BY d.position)
      FROM workflow_deployment_configs d WHERE d.user_id = w.user_id AND d.workflow_id = w.id
    )
  ))
  FROM pr_helper_workflows w WHERE w.user_id = p_user_id AND w.id = p_workflow_id;
$fn$;

-- Normalizes the payload side to the two collapses the row representation cannot express:
-- `deployments: []` is indistinguishable from an absent key once it is zero rows, and the prompt
-- content is replaced by its hash because migration 035 moved the content out of the payload.
-- `stages: []` needs no such handling: the store refuses to leave a workflow with no stage, and no live
-- row has one.
CREATE FUNCTION pr_helper_normalize_payload(p_payload jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_strip_nulls(
    (CASE WHEN COALESCE(jsonb_array_length(p_payload->'deployments'), 0) = 0
      THEN p_payload - 'deployments' ELSE p_payload END)
    || jsonb_build_object('stages', (
      SELECT jsonb_agg(
        CASE WHEN stage.value->'automation'->'generationRule' ? 'content'
          THEN jsonb_set(stage.value, '{automation,generationRule}', jsonb_build_object(
            'name', stage.value->'automation'->'generationRule'->>'name',
            'capturedAt', stage.value->'automation'->'generationRule'->>'capturedAt',
            'contentHash', encode(extensions.digest(stage.value->'automation'->'generationRule'->>'content', 'sha256'), 'hex')))
          ELSE stage.value END
        ORDER BY stage.ordinality)
      FROM jsonb_array_elements(p_payload->'stages') WITH ORDINALITY AS stage(value, ordinality)
    ))
  );
$fn$;

DO $$
DECLARE mismatched int;
BEGIN
  SELECT count(*) INTO mismatched FROM pr_helper_workflows w
  WHERE pr_helper_rebuild_workflow(w.user_id, w.id) IS DISTINCT FROM pr_helper_normalize_payload(w.payload);
  IF mismatched > 0 THEN
    RAISE EXCEPTION 'relational backfill disagrees with the payload for % workflow(s); rolling back', mismatched;
  END IF;
END $$;

DROP FUNCTION pr_helper_normalize_payload(jsonb);
DROP FUNCTION pr_helper_rebuild_workflow(uuid, text);

COMMIT;
