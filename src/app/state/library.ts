import { showToast } from '../ui/toast';
import { t } from '../../lib/i18n';
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

export function persistGenerationRules(next: GenerationRule[]) { localStorage.setItem(GENERATION_RULES_KEY, JSON.stringify(next)); library.generationRules = next; }
export function cloudSyncDeviceId() {
  const existing = localStorage.getItem('pr-helper-cloud-sync-device-id');
  if (existing && /^[a-zA-Z0-9_-]{1,120}$/.test(existing)) return existing;
  const next = `device-${crypto.randomUUID().replaceAll('-', '')}`;
  localStorage.setItem('pr-helper-cloud-sync-device-id', next);
  return next;
}

export function persistPullRequestDrafts(next: typeof library.pullRequestDrafts) { library.pullRequestDrafts = next; try { localStorage.setItem(PULL_REQUEST_DRAFTS_KEY, JSON.stringify(next)); library.draftStorageSynchronized = true; } catch { library.draftStorageSynchronized = false; showToast(t('connect.draft.saveError')); } }
persistPullRequestDrafts(library.pullRequestDrafts);
