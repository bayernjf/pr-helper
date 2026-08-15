import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../.github/workflows/reconcile-pr-helper.yml', import.meta.url), 'utf8');
const clock = readFileSync(new URL('../../db/migrations/030_reconciliation_pg_cron_clock.sql', import.meta.url), 'utf8');

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
