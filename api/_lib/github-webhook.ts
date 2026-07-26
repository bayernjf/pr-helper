import { createHmac, timingSafeEqual } from 'node:crypto';

export function githubWebhookSignature(body: string, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function verifyGithubWebhookSignature(body: string, signature: string | undefined, secret: string) {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(githubWebhookSignature(body, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
