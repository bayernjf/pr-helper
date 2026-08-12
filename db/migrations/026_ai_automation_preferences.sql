-- 026: Server-side automation prerequisites, separate from browser session AI settings.
ALTER TABLE pr_helper_ai_automation_credentials
  ADD COLUMN IF NOT EXISTS auto_generate_pr_message BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_confirm_pr_creation BOOLEAN NOT NULL DEFAULT false;
