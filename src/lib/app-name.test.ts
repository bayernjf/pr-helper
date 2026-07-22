import { describe, expect, it } from 'vitest';

import { appName } from './app-name';

describe('appName', () => {
  it('identifies the application', () => {
    expect(appName).toBe('PR Helper');
  });
});
