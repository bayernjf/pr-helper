import { library } from './library';
import { githubAppApiUrl } from '../../lib/github';
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

export function autoCreatePrerequisites() { return aiState.automationCredentialConfigured && aiState.automationAutoGeneratePrMessage && aiState.automationAutoConfirmPrCreation && library.generationRules.length; }
export async function loadAutomationCredentialStatus() {
  try { const response = await fetch(githubAppApiUrl('/api/ai-credentials')); const payload = await response.json().catch(() => ({})) as { credential?: { configured?: boolean; autoGeneratePrMessage?: boolean; autoConfirmPrCreation?: boolean } }; aiState.automationCredentialConfigured = Boolean(response.ok && payload.credential?.configured); aiState.automationAutoGeneratePrMessage = Boolean(payload.credential?.autoGeneratePrMessage); aiState.automationAutoConfirmPrCreation = Boolean(payload.credential?.autoConfirmPrCreation); }
  catch { aiState.automationCredentialConfigured = false; aiState.automationAutoGeneratePrMessage = false; aiState.automationAutoConfirmPrCreation = false; }
}
