import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_FUNCTION_CEILING_MS, CRON_RECONCILE_BUDGET_MS, cronReconcileBudgetMs } from '../_lib/workflows-store';

const workflow = readFileSync(new URL('../../.github/workflows/reconcile-pr-helper.yml', import.meta.url), 'utf8');
const clock = readFileSync(new URL('../../db/migrations/030_reconciliation_pg_cron_clock.sql', import.meta.url), 'utf8');
const handler = readFileSync(new URL('./reconcile.ts', import.meta.url), 'utf8');

describe('scheduled reconciliation cadence', () => {
  // Measured over seven days, consecutive deliveries of the `*/10` schedule arrived 46 minutes apart at
  // the median and 152 minutes apart at the worst, while one delivery covers only the few minutes it
  // sweeps for. Postgres keeps a real clock, so the schedule lives there and the job is only a fallback.
  it('drains on the abandon window rather than on whenever the schedule fires', () => {
    expect(clock).toMatch(/cron\.schedule\(\s*'pr-helper-drain'\s*,\s*'\*\/2 \* \* \* \*'/);
  });

  // A sweep costs about 69 GitHub calls, so a two-minute reconcile would spend 2070 an hour and sit on
  // the 2500 ceiling by itself. Five minutes buys a real clock without spending the budget on it.
  it('reconciles less often than it drains because a sweep costs GitHub calls', () => {
    expect(clock).toMatch(/cron\.schedule\(\s*'pr-helper-reconcile'\s*,\s*'\*\/5 \* \* \* \*'/);
  });

  it('reads the cron secret from the vault and never carries one itself', () => {
    expect(clock).toContain('vault.decrypted_secrets');
    expect(clock).not.toMatch(/Bearer [\w-]/);
  });

  // A missing secret would otherwise send an Authorization header of null and leave nothing but 401s in
  // `net._http_response`, which reads as a broken endpoint rather than a missing secret.
  it('fails loudly when the vault secret is absent', () => {
    expect(clock).toMatch(/raise exception/i);
  });

  // pg_net defaults to five seconds and the endpoints are allowed sixty, so the default would record a
  // timeout for every sweep that did its job.
  it('waits longer than the endpoints are allowed to run', () => {
    const timeout = /timeout_milliseconds\s*:?=\s*(\d+)/.exec(clock);
    expect(Number(timeout?.[1])).toBeGreaterThan(60_000);
  });

  it('keeps every sweep bounded so a hung one cannot consume the whole job', () => {
    expect(workflow).toContain('--max-time 90');
  });

  // The repeated in-job sweeping existed only because the schedule was the clock. Restoring it would
  // double the reconcile spend against pg_cron for coverage pg_cron already provides.
  it('leaves the job as a single fallback sweep now that pg_cron is the clock', () => {
    expect(workflow).toMatch(/SWEEPS: '1'/);
  });
});

// The scheduled sweep used to run unbounded on the premise that it owns its whole request. It does not
// own the platform limit: a sweep that runs past it is killed mid-flight, which answers the caller with
// a 504 that fails the fallback job and leaves a `running` row for the reaper to call an instance
// recycling five minutes later. Yielding first turns that into a `degraded` row plus a pending marker
// the next tick picks up — the handoff the realtime triggers already use.
describe('the scheduled sweep yields before the platform kills it', () => {
  it('leaves room for the closing writes and the retention cleanup that follow the stages', () => {
    expect(CRON_RECONCILE_BUDGET_MS).toBeLessThanOrEqual(AUTOMATION_FUNCTION_CEILING_MS - 15_000);
  });

  // Every sweep that completed in the 30 hours before this change took at most 32.8 seconds, so a budget
  // at or below that would start deferring sweeps that are doing their job.
  it('sits above the slowest sweep that actually finished, so a healthy one never defers', () => {
    expect(CRON_RECONCILE_BUDGET_MS).toBeGreaterThan(33_000);
  });

  it('can be overridden per environment without touching the ceiling', () => {
    expect(cronReconcileBudgetMs({ CRON_RECONCILE_BUDGET_MS: '20000' })).toBe(20_000);
    expect(cronReconcileBudgetMs({ CRON_RECONCILE_BUDGET_MS: 'soon' })).toBe(CRON_RECONCILE_BUDGET_MS);
    expect(cronReconcileBudgetMs({})).toBe(CRON_RECONCILE_BUDGET_MS);
  });

  // The budget has to reach the sweep to do anything, and this endpoint is the only cron entry point:
  // both pg_cron and the fallback job call it.
  it('is handed to the sweep by the endpoint that both clocks call', () => {
    expect(handler).toContain('cronReconcileBudgetMs');
    expect(handler).toMatch(/reconcileWorkflowStages\([\s\S]*?deadlineMs: cronReconcileBudgetMs\(process\.env\)/);
  });
});
