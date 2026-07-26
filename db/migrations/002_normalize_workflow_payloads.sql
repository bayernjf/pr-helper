-- Convert payloads written by the initial Postgres.js integration from JSON strings
-- into JSON objects. New writes use sql.json(workflow) and do not need this conversion.
UPDATE pr_helper_workflows
SET payload = (payload #>> '{}')::jsonb
WHERE jsonb_typeof(payload) = 'string';
