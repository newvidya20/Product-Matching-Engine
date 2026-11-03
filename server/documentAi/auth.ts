/**
 * Access-code authentication with a signed HttpOnly cookie (docs/contracts.md section 7.1).
 * Fails closed in production. No bearer tokens are accepted on these routes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type {
  AuthStatusResponse,
  CreateAuthSessionRequest,
  DocumentActor,
  DocumentAiErrorBody,
} from '../../src/types/documentAi.ts';
import type { UserRole } from '../../src/types/domain.ts';
import { logActivity } from './activity.ts';
import { getRoot } from './store.ts';

const COOKIE_NAME = 'lb_docai_session';
const MAX_AGE_SECONDS = 43200;
const THROTTLE_MAX_FAILURES = 10;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/** Failed sign-ins per client, plus a much higher global ceiling so one client cannot lock everyone out. */
const THROTTLE_GLOBAL_MAX_FAILURES = 200;
const THROTTLE_MAX_CLIENTS = 5000;
const clientFailures = new Map<string, number[]>();
const globalFailures: number[] = [];

/** Socket address locally; the last X-Forwarded-For hop (appended by Render's proxy) in production. */
function clientKey(req: Request): string {
  if (isProduction()) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff.join(',') : xff || '';
    const last = raw.split(',').pop()?.trim();
    if (last) return last;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function prune(list: number[], now: number): void {
  while (list.length && now - list[0] > THROTTLE_WINDOW_MS) list.shift();
}

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

/**
 * Dedicated signing secret, never derived from an access code: DOCUMENT_AI_SESSION_SECRET, otherwise a random
 * secret generated once and persisted (mode 0600) under the data dir.
 */
let cachedSecret: { file: string; key: Buffer } | null = null;
function signingKey(): Buffer {
  const fromEnv = (process.env.DOCUMENT_AI_SESSION_SECRET || '').trim();
  if (fromEnv.length >= 16) return crypto.createHash('sha256').update(`lb-docai-secret:${fromEnv}`).digest();
  const file = path.join(getRoot(), 'session-secret');
  if (cachedSecret && cachedSecret.file === file) return cachedSecret.key;
  let hex = '';
  let exists = false;
  try {
    hex = fs.readFileSync(file, 'utf-8').trim();
    exists = true;
  } catch {
    hex = '';
  }
  const valid = (v: string) => /^[0-9a-f]{64}$/.test(v);
  if (!valid(hex)) {
    const fresh = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, fresh, { mode: 0o600 });
    try {
      if (!exists) {
        try {
          fs.linkSync(tmp, file); // fails if another writer won the race; then read theirs
        } catch {
          /* keep existing */
        }
      } else {
        fs.renameSync(tmp, file); // existing content is invalid: replace it
      }
    } catch {
      /* fall through to re-read */
    }
    fs.rmSync(tmp, { force: true });
    try {
      hex = fs.readFileSync(file, 'utf-8').trim();
    } catch {
      hex = '';
    }
    if (!valid(hex)) hex = fresh; // unreadable or still invalid: use ours for this process
  }
  const key = Buffer.from(hex, 'hex');
  cachedSecret = { file, key };
  return key;
}

/** Binds a cookie to the code of its role, so changing a code ends that role's sessions. */
function codeVersion(role: UserRole): string {
  const code = role === 'admin' ? adminCode() : accessCode();
  if (!code) return '';
  return crypto.createHmac('sha256', signingKey()).update(`cv:${role}:${code}`).digest('base64url').slice(0, 16);
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
  cv: string;
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
  const wantSig = Buffer.from(sign(`v1.${parts[1]}`));
  if (given.length !== wantSig.length || !crypto.timingSafeEqual(given, wantSig)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as CookiePayload;
    if (typeof p.exp !== 'number' || p.exp * 1000 < Date.now()) return null;
    if (p.role !== 'admin' && p.role !== 'employee') return null;
    // No code for the role means no session of that role can exist.
    const want = codeVersion(p.role);
    if (!want || typeof p.cv !== 'string' || p.cv !== want) return null;
    return p;
  } catch {
    return null;
  }
}

type Mode = 'code' | 'local_dev' | 'open' | 'closed';

function isLoopback(req: Request): boolean {
  const addr = req.socket?.remoteAddress || '';
  return (
    (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') &&
    !req.headers['x-forwarded-for']
  );
}

/**
 * With an access code set, staff sign in with it. With none set, Document AI is open to anyone who can
 * reach the app: the owner chose this (2026-11-03) so uploads need no extra step, accepting that uploaded
 * documents are then reachable without a code. DOCUMENT_AI_REQUIRE_ACCESS_CODE=true restores the lock.
 */
function currentMode(req: Request): Mode {
  if (accessCode() || adminCode()) return 'code';
  if (!isProduction() && isLoopback(req)) return 'local_dev';
  if (process.env.DOCUMENT_AI_REQUIRE_ACCESS_CODE?.trim().toLowerCase() === 'true') return 'closed';
  return 'open';
}

const OPEN_ACTOR: DocumentActor = {
  id: 'open_access',
  email: 'staff@document-ai',
  displayName: 'Staff',
  role: 'admin',
  via: 'local_dev',
};

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
  if (mode === 'open') return { mode, actor: OPEN_ACTOR };
  if (mode === 'closed') return { mode, actor: null };
  const p = verifyCookie(readCookieValue(req));
  return { mode, actor: p ? actorFromCookie(p) : null };
}

/** True when the request carries a valid Document AI session (or is local dev mode). */
export function hasValidDocumentSession(req: Request): boolean {
  return resolveActor(req).actor !== null;
}

/** Path=/api so the cookie also reaches DELETE /api/assessments/:id (needed to authorize the KYC purge). */
const COOKIE_PATH = '/api';
const LEGACY_COOKIE_PATH = '/api/document-ai';

function cookieAttrs(path: string = COOKIE_PATH): string {
  return `HttpOnly; SameSite=Strict; Path=${path}${isProduction() ? '; Secure' : ''}`;
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
  const key = clientKey(req);
  const mine = clientFailures.get(key) || [];
  prune(mine, now);
  prune(globalFailures, now);
  if (mine.length === 0) clientFailures.delete(key);
  if (mine.length >= THROTTLE_MAX_FAILURES || globalFailures.length >= THROTTLE_GLOBAL_MAX_FAILURES) {
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
    mine.push(now);
    globalFailures.push(now);
    if (!clientFailures.has(key)) {
      if (clientFailures.size >= THROTTLE_MAX_CLIENTS) {
        const oldest = clientFailures.keys().next().value;
        if (oldest !== undefined) clientFailures.delete(oldest);
      }
      clientFailures.set(key, mine);
    }
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
    cv: codeVersion(role),
    exp: Math.floor(now / 1000) + MAX_AGE_SECONDS,
  };
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${makeCookieValue(payload)}; ${cookieAttrs()}; Max-Age=${MAX_AGE_SECONDS}`,
    `${COOKIE_NAME}=; ${cookieAttrs(LEGACY_COOKIE_PATH)}; Max-Age=0`,
  ]);
  void logActivity({ type: 'auth_session_created', actor: email, code: role });
  const out: AuthStatusResponse = { authenticated: true, configured: true, actor: actorFromCookie(payload) };
  res.json(out);
}

export function logout(req: Request, res: Response): void {
  const { actor } = resolveActor(req);
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=; ${cookieAttrs()}; Max-Age=0`,
    `${COOKIE_NAME}=; ${cookieAttrs(LEGACY_COOKIE_PATH)}; Max-Age=0`,
  ]);
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
