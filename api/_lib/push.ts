import webpush from 'web-push';
import postgres from 'postgres';

export type BrowserPushSubscription = { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };
export type PushMessage = { title: string; body: string; url?: string };

function vapid(environment: Record<string, string | undefined>) {
  const publicKey = environment.VAPID_PUBLIC_KEY?.trim();
  const privateKey = environment.VAPID_PRIVATE_KEY?.trim();
  const subject = environment.VAPID_SUBJECT?.trim() || 'mailto:admin@pr-helper.app';
  if (!publicKey || !privateKey) return null;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return publicKey;
}

export function pushPublicKey(environment: Record<string, string | undefined>) {
  return environment.VAPID_PUBLIC_KEY?.trim() || '';
}

export function validPushSubscription(value: unknown): value is BrowserPushSubscription {
  if (!value || typeof value !== 'object') return false;
  const subscription = value as Partial<BrowserPushSubscription>;
  return typeof subscription.endpoint === 'string' && subscription.endpoint.startsWith('https://')
    && Boolean(subscription.keys) && typeof subscription.keys?.p256dh === 'string' && typeof subscription.keys?.auth === 'string';
}

export async function sendPushNotifications(environment: Record<string, string | undefined>, sql: ReturnType<typeof postgres>, userId: string, event: { eventKey: string; kind: string; title: string; body: string; url?: string }) {
  if (!vapid(environment)) return 0;
  const recorded = await sql`INSERT INTO pr_helper_notification_deliveries (user_id, event_key, kind, title, body) VALUES (${userId}, ${event.eventKey}, ${event.kind}, ${event.title}, ${event.body}) ON CONFLICT (user_id, event_key) DO NOTHING RETURNING id`;
  if (!recorded.length) return 0;
  const subscriptions = await sql<{ endpoint: string; subscription: BrowserPushSubscription }[]>`SELECT endpoint, subscription FROM pr_helper_push_subscriptions WHERE user_id = ${userId}`;
  const payload = JSON.stringify({ title: event.title, body: event.body, url: event.url || '/' });
  const results = await Promise.allSettled(subscriptions.map(item => webpush.sendNotification(item.subscription, payload)));
  const expired = results.flatMap((result, index) => result.status === 'rejected' && [404, 410].includes((result.reason as { statusCode?: number }).statusCode || 0) ? [subscriptions[index].endpoint] : []);
  if (expired.length) await sql`DELETE FROM pr_helper_push_subscriptions WHERE endpoint = ANY(${expired})`;
  return results.filter(result => result.status === 'fulfilled').length;
}
