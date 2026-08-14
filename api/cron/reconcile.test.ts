import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../.github/workflows/reconcile-pr-helper.yml', import.meta.url), 'utf8');

describe('scheduled reconciliation cadence', () => {
  // GitHub throttles scheduled deliveries: a `*/10` schedule actually arrived every 30-60 minutes,
  // and each delivery sweeps only one batch of workflows. A fleet larger than a batch then waited
  // hours for its automation to be evaluated, which reads as automation that never ran. Sweeping
  // repeatedly inside one job makes coverage depend on the job, not on when the schedule fires.
  it('sweeps repeatedly within one delivery instead of once', () => {
    const step = workflow.slice(workflow.indexOf('Calibrate active workflows'));
    expect(step).toMatch(/for .*seq|while /);
    expect(step).toContain('sleep');
  });

  it('keeps every sweep bounded so a hung one cannot consume the whole job', () => {
    expect(workflow).toContain('--max-time 90');
  });
});
