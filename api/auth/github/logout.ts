import { type ApiRequest, type ApiResponse } from '../../_lib/http';

export default function handler(_request: ApiRequest, response: ApiResponse) {
  response.setHeader('Set-Cookie', 'pr-helper-session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  response.status(200).json({ ok: true });
}
