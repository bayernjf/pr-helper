-- 040: Contract step of 035 — replace a payload's inline generation rule content with its hash.
--
-- 035 gave every rule content a row of its own and the store stopped writing the content inline, but
-- dehydration only happens when a workflow is saved: measured 2026-08-21, 42 of 44 stages had not been
-- saved since and still carried the whole prompt. All 42 copies were the same single content, and that
-- content is already in pr_helper_generation_rules, so the copies buy nothing and cost 63% of what a
-- full-table payload read transfers (44 528 B of 70 837 B).
--
-- Safe because the read path no longer needs the inline copy: the server resolves a hash through
-- pr_helper_generation_rules, and the browser list read fills the content back before the payload
-- leaves the server (`hydrateGenerationRules`, deployed 2026-08-21 and verified in production).
--
-- Reversible: the content stays in pr_helper_generation_rules, so the inverse UPDATE puts it back
-- inline. Nothing here is a one-way door.
--
-- Out of scope on purpose:
--   * workflow_automation_runs.workflow_snapshot — a queued action's own copy of the prompt, which the
--     drain reads; rewriting it would break actions already in flight.
--   * workflow_versions.snapshot — no reader anywhere in the codebase, so stripping it saves no egress,
--     and snapshots written after 035 are dehydrated already.
--   * pr_helper_workflows.payload as a column — 14 read sites still parse it; that removal is its own
--     step and is not owed to this one.

-- Belt and braces. The stage rewrite below carries its own EXISTS guard, but a content that is not in
-- the table yet would simply be skipped and left inline, which is a silent no-op rather than a failure.
-- Re-running 035's backfill first makes the guard true for every content that exists today.
INSERT INTO pr_helper_generation_rules (user_id, content_hash, content)
SELECT DISTINCT
  workflows.user_id,
  encode(extensions.digest(stage->'automation'->'generationRule'->>'content', 'sha256'), 'hex'),
  stage->'automation'->'generationRule'->>'content'
FROM pr_helper_workflows AS workflows
CROSS JOIN LATERAL jsonb_array_elements(workflows.payload->'stages') AS stage
WHERE stage->'automation'->'generationRule'->>'content' IS NOT NULL
ON CONFLICT (user_id, content_hash) DO NOTHING;

-- The stages array is rebuilt element by element, so the aggregate must be ordered: stage order is the
-- pipeline order, and an unordered jsonb_agg would silently reshuffle `dev → main` ahead of its feeder.
-- A stage is rewritten only when its content is already recoverable from pr_helper_generation_rules;
-- anything else is left exactly as it is.
UPDATE pr_helper_workflows AS workflows
SET payload = jsonb_set(workflows.payload, '{stages}', (
  SELECT jsonb_agg(
    CASE
      WHEN element.stage->'automation'->'generationRule'->>'content' IS NOT NULL
        AND EXISTS (SELECT 1 FROM pr_helper_generation_rules AS rules
                    WHERE rules.user_id = workflows.user_id
                      AND rules.content = element.stage->'automation'->'generationRule'->>'content')
      THEN jsonb_set(
        element.stage #- '{automation,generationRule,content}',
        '{automation,generationRule,contentHash}',
        to_jsonb(encode(extensions.digest(element.stage->'automation'->'generationRule'->>'content', 'sha256'), 'hex'))
      )
      ELSE element.stage
    END
    ORDER BY element.ordinality
  )
  FROM jsonb_array_elements(workflows.payload->'stages') WITH ORDINALITY AS element(stage, ordinality)
))
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(workflows.payload->'stages') AS stage
  WHERE stage->'automation'->'generationRule'->>'content' IS NOT NULL
);

-- The relational stage rows are the sweep's copy of the same fact, and they already carry
-- rule_content_hash for all 44 stages (checked 2026-08-21), computed from the same content by the same
-- Node hash. Nothing here has to touch them.

-- Refuse to finish while a payload still carries an inline content that the rules table cannot resolve:
-- that combination means the rewrite skipped a stage, and a later run would strip it with no recovery.
DO $$
DECLARE unresolvable integer;
BEGIN
  SELECT count(*) INTO unresolvable
  FROM pr_helper_workflows AS workflows
  CROSS JOIN LATERAL jsonb_array_elements(workflows.payload->'stages') AS stage
  WHERE stage->'automation'->'generationRule'->>'content' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pr_helper_generation_rules AS rules
                    WHERE rules.user_id = workflows.user_id
                      AND rules.content = stage->'automation'->'generationRule'->>'content');
  IF unresolvable > 0 THEN
    RAISE EXCEPTION '040: % stages still carry an unresolvable inline generation rule', unresolvable;
  END IF;
END $$;
