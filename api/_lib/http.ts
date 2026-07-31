export type ApiRequest = {
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  method?: string;
  body?: unknown;
};

export type ApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): { json(value: unknown): void };
  redirect(status: number, url: string): void;
};

export function isMutationRequest(method: string | undefined) {
  return Boolean(method && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()));
}

function headerValue(headers: ApiRequest['headers'], name: string) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function requestOriginAllowed(headers: ApiRequest['headers'], environment: Record<string, string | undefined>) {
  const origin = headerValue(headers, 'origin')?.trim();
  if (!origin) return true;
  const configured = [environment.APP_ORIGIN, ...(environment.CSRF_ALLOWED_ORIGINS || '').split(',')]
    .map(value => value?.trim().replace(/\/$/, ''))
    .filter((value): value is string => Boolean(value));
  return configured.includes(origin.replace(/\/$/, ''));
}

export function assertRequestOrigin(request: ApiRequest, environment: Record<string, string | undefined>) {
  if (isMutationRequest(request.method) && !requestOriginAllowed(request.headers, environment)) throw new Error('请求来源校验失败');
}

export function requestErrorStatus(error: unknown, fallback = 500) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('请求来源校验失败')) return 403;
  if (message.includes('请求过于频繁')) return 429;
  if (message.includes('其他窗口更新')) return 409;
  if (message.includes('GitHub 会话')) return 401;
  if (message.includes('DATABASE_URL')) return 503;
  return fallback;
}

export function queryValue(request: ApiRequest, key: string) {
  const value = request.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

export function readCookie(request: ApiRequest, name: string) {
  const header = request.headers?.cookie;
  const source = Array.isArray(header) ? header.join(';') : header || '';
  return source.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function setSecureCookie(response: ApiResponse, name: string, value: string, maxAgeSeconds: number) {
  response.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
}

export function requestMustBeGet(request: ApiRequest, response: ApiResponse) {
  if (!request.method || request.method === 'GET') return true;
  response.status(405).json({ message: 'Method not allowed' });
  return false;
}
