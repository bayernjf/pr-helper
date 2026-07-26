import { describe, expect, it } from 'vitest';
import { githubWebhookSignature, verifyGithubWebhookSignature } from './github-webhook';

describe('GitHub webhook signatures', () => {
  it('accepts an exact signed raw body and rejects changes', () => {
    const body = '{"action":"opened"}';
    expect(verifyGithubWebhookSignature(body, githubWebhookSignature(body, 'secret'), 'secret')).toBe(true);
    expect(verifyGithubWebhookSignature('{"action":"closed"}', githubWebhookSignature(body, 'secret'), 'secret')).toBe(false);
  });
});
