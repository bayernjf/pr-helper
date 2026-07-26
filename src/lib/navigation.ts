export type Screen = 'overview' | 'editor' | 'detail';

export function navigationClass(current: string, target: string) {
  return `nav-button${current === target ? ' active' : ''}`;
}

export function navigationTarget(current: Screen, target: Screen | 'back', hasCurrentWorkflow = false): Screen {
  if (target !== 'back') return target;
  return current === 'editor' && hasCurrentWorkflow ? 'detail' : 'overview';
}

export function startsNewWorkflow(target: Screen) {
  return target === 'editor';
}

export function shouldRefreshWorkflowDetail(previous: Screen, next: Screen) {
  return previous !== 'detail' && next === 'detail';
}
