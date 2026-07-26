CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event_name text NOT NULL,
  action text,
  repository text,
  received_at timestamptz NOT NULL DEFAULT now()
);
