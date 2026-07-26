import { describe, expect, it } from 'vitest';

import { navigationClass, navigationTarget, shouldRefreshWorkflowDetail, startsNewWorkflow } from './navigation';

describe('navigation state', () => {
  it('marks only the current screen as active', () => {
    expect(navigationClass('editor', 'overview')).toBe('nav-button');
    expect(navigationClass('editor', 'editor')).toBe('nav-button active');
  });

  it('returns from an existing workflow editor to its detail page', () => {
    expect(navigationTarget('editor', 'back', true)).toBe('detail');
  });

  it('returns from an unsaved workflow editor to the overview', () => {
    expect(navigationTarget('editor', 'back', false)).toBe('overview');
  });

  it('treats the editor navigation tab as starting a new workflow', () => {
    expect(startsNewWorkflow('editor')).toBe(true);
    expect(startsNewWorkflow('overview')).toBe(false);
  });

  it('refreshes GitHub status when entering a workflow detail page', () => {
    expect(shouldRefreshWorkflowDetail('overview', 'detail')).toBe(true);
    expect(shouldRefreshWorkflowDetail('detail', 'detail')).toBe(false);
  });
});
