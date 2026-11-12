import type { AiConfig } from '../../lib/ai';

// AI automation state: the session-scoped config, the credential status flag
// and the resolved-automation dedupe cache (phase 1 of the main.ts split).
export const aiState = {
  aiConfig: loadAiConfig(),
  automationCredentialConfigured: false,
  automationAutoGeneratePrMessage: false,
  automationAutoConfirmPrCreation: false,
  resolvedAutomation: new Map<string, ResolvedAutomationRecord>(),
};

export type ResolvedAutomationRecord = { resolvedAt: number; source: string; actionId: number | null; updatedAt: string };

function loadAiConfig(): AiConfig | null { try { return JSON.parse(sessionStorage.getItem('pr-helper-ai') || 'null') as AiConfig | null; } catch { return null; } }
