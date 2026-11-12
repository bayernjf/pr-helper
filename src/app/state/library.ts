import { loadGenerationRules } from '../../lib/generation-rules';
import { loadPullRequestDrafts } from '../../lib/pr-drafts';
import { getCloudSyncStatus, type CloudSyncStatus } from '../../lib/encrypted-sync';
import type { GenerationRule } from '../../lib/generation-rules';

export const GENERATION_RULES_KEY = 'pr-helper-generation-rules';
export const PULL_REQUEST_DRAFTS_KEY = 'pr-helper-pr-drafts';

// Local library state: the generation-rule and PR-draft caches backed by
// localStorage plus the encrypted-sync status (phase 1 of the main.ts split).
export const library = {
  generationRules: loadGenerationRules(() => localStorage.getItem(GENERATION_RULES_KEY)) as GenerationRule[],
  pullRequestDrafts: loadPullRequestDrafts(() => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY), Date.now()),
  draftStorageSynchronized: true,
  cloudSyncStatus: getCloudSyncStatus() as CloudSyncStatus,
};
