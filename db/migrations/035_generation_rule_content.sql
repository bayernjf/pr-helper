-- 035: Store a generation rule's content once per user instead of once per stage.
--
-- Every server-mode stage carries the whole prompt inline in `pr_helper_workflows.payload`, and the
-- payload is copied again into every `workflow_versions.snapshot`. Measured 2026-08-21: 44 stages all
-- carried a generationRule, the 44 copies of `content` came to 44 528 B of the 70 837 B a full-table
-- read costs (63%), and only one of those 44 contents was actually different. The content is immutable
-- once captured, so it belongs in its own row keyed by its hash.
--
-- Keyed by (user_id, content_hash) rather than by the hash alone: the same prompt written by two users
-- is two rows. Cross-tenant dedup would save a handful of bytes and would put one user's prompt behind
-- a key another user could hold, which is not a trade worth making.
--
-- `content_hash` is `encode(digest(content, 'sha256'), 'hex')`, which is what `createHash('sha256')`
-- produces in the store, so a row backfilled here is found by a hash computed in Node.
CREATE TABLE IF NOT EXISTS pr_helper_generation_rules (
  user_id uuid NOT NULL REFERENCES pr_helper_users (id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, content_hash)
);

-- Backfill from the payloads that already carry the content, so the read path finds every rule the
-- moment the code starts looking it up by hash. This is the expand step: nothing is removed from any
-- payload here, and the store keeps accepting an inline `content` until a later contract migration.
INSERT INTO pr_helper_generation_rules (user_id, content_hash, content)
SELECT DISTINCT
  workflows.user_id,
  encode(extensions.digest(stage->'automation'->'generationRule'->>'content', 'sha256'), 'hex'),
  stage->'automation'->'generationRule'->>'content'
FROM pr_helper_workflows AS workflows
CROSS JOIN LATERAL jsonb_array_elements(workflows.payload->'stages') AS stage
WHERE stage->'automation'->'generationRule'->>'content' IS NOT NULL
ON CONFLICT (user_id, content_hash) DO NOTHING;

-- Historical snapshots hold the same contents, and a restore reads them, so their rules must resolve too.
INSERT INTO pr_helper_generation_rules (user_id, content_hash, content)
SELECT DISTINCT
  versions.user_id,
  encode(extensions.digest(stage->'automation'->'generationRule'->>'content', 'sha256'), 'hex'),
  stage->'automation'->'generationRule'->>'content'
FROM workflow_versions AS versions
CROSS JOIN LATERAL jsonb_array_elements(versions.snapshot->'stages') AS stage
WHERE stage->'automation'->'generationRule'->>'content' IS NOT NULL
ON CONFLICT (user_id, content_hash) DO NOTHING;
