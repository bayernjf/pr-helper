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
