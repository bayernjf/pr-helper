import { describe, expect, it } from 'vitest';

import { navigationClass, navigationTarget, selectWorkflowAfterCloudLoad, shouldRefreshWorkflowDetail, startsNewWorkflow } from './navigation';

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

  it('does not replace a new workflow editor with the first cloud workflow', () => {
    const loaded = [{ id: 'existing' }, { id: 'other' }];
    expect(selectWorkflowAfterCloudLoad(null, loaded, 'editor')).toBeNull();
    expect(selectWorkflowAfterCloudLoad(loaded[1], loaded, 'editor')).toEqual(loaded[1]);
    expect(selectWorkflowAfterCloudLoad(null, loaded, 'overview')).toEqual(loaded[0]);
  });

  it('refreshes GitHub status when entering a workflow detail page', () => {
    expect(shouldRefreshWorkflowDetail('overview', 'detail')).toBe(true);
    expect(shouldRefreshWorkflowDetail('detail', 'detail')).toBe(false);
  });
});
