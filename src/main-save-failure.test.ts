import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

function body(name: string) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start));
}

describe('reportWorkflowSaveError', () => {
  // Toggles are applied to memory and localStorage before the request goes out, so a failed save
  // leaves the checkbox showing a switch the server never accepted — and localStorage keeps showing
  // it after a reload. Reporting the failure is not enough; the stored state has to be read back.
  it('realigns the local projection with what the server actually stored', () => {
    const report = body('reportWorkflowSaveError');
    expect(report).toContain('loadCloudWorkflows()');
  });

  it('takes the workflow id the queue reports so the failure can be attributed', () => {
    expect(source).toContain('function reportWorkflowSaveError(error: unknown, workflowId: string)');
  });
});
