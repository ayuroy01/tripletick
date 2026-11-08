import type { FastifyReply, FastifyRequest } from 'fastify';
import { scopeAllows, userFromApiKey, userFromSession, type Role, type User } from './auth.ts';
import { config } from './config.ts';

declare module 'fastify' {
  interface FastifyRequest { user: User; rawBody?: Buffer }
}

const COOKIE = 'tt_session';
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const fail = (status: number, message: string): never => { throw new HttpError(status, message); };

export function cookieToken(req: FastifyRequest) {
  return /(?:^|;\s*)tt_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
}

export function setCookie(reply: FastifyReply, token: string, maxAge: number) {
  const secure = config.publicUrl.startsWith('https') ? '; Secure' : '';
  reply.header('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function authenticate(req: FastifyRequest) {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const token = cookieToken(req);
  const user = bearer ? userFromApiKey(bearer) : token ? userFromSession(token) : undefined;
  if (!user) fail(401, 'Please sign in');
  req.user = user!;
}

export const need = (...roles: Role[]) => async (req: FastifyRequest) => {
  authenticate(req);
  if (roles.length && !roles.includes(req.user.role)) fail(403, "You don't have permission to do that");
  const key = req.user.apiKey;
  if (key && !scopeAllows(key.scopes, req.method, req.routeOptions.url ?? '')) fail(403, `This API key doesn't have permission for ${req.method} ${req.routeOptions.url}`);
};
export const anyone = need();
export const leads = need('admin', 'manager');
export const admins = need('admin');
