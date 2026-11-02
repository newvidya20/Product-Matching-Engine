/**
 * Access-code authentication with a signed HttpOnly cookie (docs/contracts.md section 7.1).
 * Fails closed in production. No bearer tokens are accepted on these routes.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type {
  AuthStatusResponse,
  CreateAuthSessionRequest,
  DocumentActor,
  DocumentAiErrorBody,
} from '../../src/types/documentAi.ts';
import type { UserRole } from '../../src/types/domain.ts';
import { logActivity } from './activity.ts';

const COOKIE_NAME = 'lb_docai_session';
const MAX_AGE_SECONDS = 43200;
const THROTTLE_MAX_FAILURES = 10;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

const failures: number[] = [];

export function sendError(
  res: Response,
  status: number,
  code: DocumentAiErrorBody['code'],
  error: string,
  extra?: { jobId?: string }
): void {
  const body: DocumentAiErrorBody = { error, code, ...(extra || {}) };
  res.status(status).json(body);
}

const accessCode = () => (process.env.DOCUMENT_AI_ACCESS_CODE || '').trim();
const adminCode = () => (process.env.DOCUMENT_AI_ADMIN_CODE || '').trim();
const isProduction = () => process.env.NODE_ENV === 'production';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest();
function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function signingKey(): Buffer {
  return sha256(`lb-docai-session:${accessCode()}${adminCode()}`);
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function sign(payload: string): string {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

interface CookiePayload {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  exp: number;
}

function makeCookieValue(p: CookiePayload): string {
  const body = b64u(JSON.stringify(p));
  return `v1.${body}.${sign(`v1.${body}`)}`;
}

function readCookieValue(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  return null;
}

function verifyCookie(value: string | null): CookiePayload | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const given = Buffer.from(parts[2]);
  const want = Buffer.from(sign(`v1.${parts[1]}`));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as CookiePayload;
    if (typeof p.exp !== 'number' || p.exp * 1000 < Date.now()) return null;
    if (p.role !== 'admin' && p.role !== 'employee') return null;
    return p;
  } catch {
    return null;
  }
}

type Mode = 'code' | 'local_dev' | 'closed';

function isLoopback(req: Request): boolean {
  const addr = req.socket?.remoteAddress || '';
  return (
    (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') &&
    !req.headers['x-forwarded-for']
  );
}

function currentMode(req: Request): Mode {
  if (accessCode() || adminCode()) return 'code';
  if (!isProduction() && isLoopback(req)) return 'local_dev';
  return 'closed';
}

const LOCAL_ACTOR: DocumentActor = {
  id: 'local_dev',
  email: 'local@localhost',
  displayName: 'Local developer',
  role: 'admin',
  via: 'local_dev',
};

function actorFromCookie(p: CookiePayload): DocumentActor {
  return { id: p.sub, email: p.email, displayName: p.name, role: p.role, via: 'access_code' };
}

function resolveActor(req: Request): { mode: Mode; actor: DocumentActor | null } {
  const mode = currentMode(req);
  if (mode === 'local_dev') return { mode, actor: LOCAL_ACTOR };
  if (mode === 'closed') return { mode, actor: null };
  const p = verifyCookie(readCookieValue(req));
  return { mode, actor: p ? actorFromCookie(p) : null };
}

function cookieAttrs(): string {
  return `HttpOnly; SameSite=Strict; Path=/api/document-ai${isProduction() ? '; Secure' : ''}`;
}

// eslint-disable-next-line no-control-regex
const CONTROL_OR_ANGLE = /[\u0000-\u001f\u007f<>]/g;
const cleanText = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(CONTROL_OR_ANGLE, '').trim().slice(0, max) : '';

// ------------------------------------------------------------- handlers

export function authStatus(req: Request, res: Response): void {
  const { mode, actor } = resolveActor(req);
  const body: AuthStatusResponse = {
    authenticated: Boolean(actor),
    configured: mode !== 'closed',
    actor,
  };
  res.json(body);
}

export function createAuthSession(req: Request, res: Response): void {
  const mode = currentMode(req);
  if (mode !== 'code') {
    sendError(res, 503, 'auth_not_configured', 'Document AI access is not configured on this server.');
    return;
  }
  const now = Date.now();
  while (failures.length && now - failures[0] > THROTTLE_WINDOW_MS) failures.shift();
  if (failures.length >= THROTTLE_MAX_FAILURES) {
    res.setHeader('Retry-After', String(Math.ceil(THROTTLE_WINDOW_MS / 1000)));
    sendError(res, 429, 'too_many_attempts', 'Too many failed attempts. Try again later.');
    return;
  }
  const body = (req.body || {}) as Partial<CreateAuthSessionRequest>;
  const supplied = typeof body.accessCode === 'string' ? body.accessCode.trim() : '';
  // Evaluate both comparisons so timing does not reveal which code matched.
  const isAdmin = Boolean(adminCode()) && safeEqual(supplied, adminCode());
  const isEmployee = Boolean(accessCode()) && safeEqual(supplied, accessCode());
  let role: UserRole | null = null;
  if (supplied && isAdmin) role = 'admin';
  else if (supplied && isEmployee) role = 'employee';

  if (!role) {
    failures.push(now);
    void logActivity({ type: 'auth_session_failed', actor: 'anonymous' });
    sendError(res, 401, 'unauthenticated', 'Invalid access code.');
    return;
  }
  const email = cleanText(body.actorEmail, 200) || `${role}@access-code`;
  const name = cleanText(body.actorDisplayName, 120) || (role === 'admin' ? 'Admin' : 'Employee');
  const payload: CookiePayload = {
    sub: `ac_${crypto.randomUUID()}`,
    email,
    name,
    role,
    exp: Math.floor(now / 1000) + MAX_AGE_SECONDS,
  };
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${makeCookieValue(payload)}; ${cookieAttrs()}; Max-Age=${MAX_AGE_SECONDS}`
  );
  void logActivity({ type: 'auth_session_created', actor: email, code: role });
  const out: AuthStatusResponse = { authenticated: true, configured: true, actor: actorFromCookie(payload) };
  res.json(out);
}

export function logout(req: Request, res: Response): void {
  const { actor } = resolveActor(req);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttrs()}; Max-Age=0`);
  if (actor) void logActivity({ type: 'auth_logout', actor: actor.email, code: actor.via });
  res.status(204).end();
}

// ------------------------------------------------------------ middleware

const OPEN_PATHS = new Set(['/auth/status', '/auth/session', '/auth/logout']);

export function requireDocumentAuth(req: Request, res: Response, next: NextFunction): void {
  if (OPEN_PATHS.has(req.path)) {
    next();
    return;
  }
  const { mode, actor } = resolveActor(req);
  if (mode === 'closed') {
    sendError(res, 503, 'auth_not_configured', 'Document AI access is not configured on this server.');
    return;
  }
  if (!actor) {
    sendError(res, 401, 'unauthenticated', 'Enter the Document AI access code to continue.');
    return;
  }
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      sendError(res, 415, 'invalid_request', 'Content-Type must be application/json.');
      return;
    }
  }
  res.locals.documentActor = actor;
  next();
}

export const getActor = (res: Response): DocumentActor => res.locals.documentActor as DocumentActor;
