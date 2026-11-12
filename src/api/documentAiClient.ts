import {
  DOCUMENT_AI_API_BASE,
  type AuthStatusResponse,
  type CreateAuthSessionRequest,
  type DeleteDocumentMode,
  type DeleteDocumentResponse,
  type DocumentAiErrorBody,
  type DocumentAiErrorCode,
  type DocumentAiSettingsResponse,
  type DocumentSessionRecord,
  type DocumentSessionState,
  type FindSessionResponse,
  type JobStatusResponse,
  type SessionEdits,
  type SpreadsheetPreview,
  type StartExtractionRequest,
  type StartExtractionResponse,
  type UpdateDocumentAiSettingsRequest,
  type UpdateDocumentRequest,
  type UpdateEditsRequest,
  type UploadDocumentRequest,
  type UploadDocumentResponse,
} from '../types/documentAi';
import type { SessionTotals } from '../types/totals';

/** Error from a Document AI route. The message never carries borrower data. */
export class DocumentAiError extends Error {
  status: number;
  code: DocumentAiErrorCode | 'network';
  jobId?: string;

  constructor(status: number, code: DocumentAiErrorCode | 'network', message: string, jobId?: string) {
    super(message);
    this.name = 'DocumentAiError';
    this.status = status;
    this.code = code;
    this.jobId = jobId;
  }
}

type UnlockHandler = () => Promise<boolean>;
let unlockHandler: UnlockHandler | null = null;
let pendingUnlock: Promise<boolean> | null = null;

/** DocumentAccessGate registers itself here. On 401 the client asks for the code once, then retries. */
export function registerUnlockHandler(handler: UnlockHandler | null): void {
  unlockHandler = handler;
}

function requestUnlock(): Promise<boolean> {
  if (!unlockHandler) return Promise.resolve(false);
  if (!pendingUnlock) {
    pendingUnlock = unlockHandler().finally(() => {
      pendingUnlock = null;
    });
  }
  return pendingUnlock;
}

/** Opens the access-code prompt on demand, for example to unlock as admin. Resolves true once unlocked. */
export function promptForAccessCode(): Promise<boolean> {
  return requestUnlock();
}

const FRIENDLY_MESSAGES: Partial<Record<DocumentAiErrorCode | 'network', string>> = {
  unauthenticated: 'Enter the Document AI access code to continue.',
  forbidden: 'Only an admin can do that.',
  auth_not_configured:
    'Document AI is locked because no access code is set. An admin must add DOCUMENT_AI_ACCESS_CODE and DOCUMENT_AI_ADMIN_CODE in the server environment (Render > Environment).',
  too_many_attempts: 'Too many attempts. Try again in a few minutes.',
  disabled: 'Document AI is turned off in Settings.',
  file_too_large: 'That file is larger than 100 MB.',
  too_many_files: 'This assessment already has 25 files.',
  session_too_large: 'This assessment has reached the 100 MB upload limit.',
  unsupported_type: 'Only PDF, XLSX, CSV, PNG, JPG and WebP files are supported. Save .xls files as .xlsx.',
  type_mismatch: 'The file contents do not match its extension.',
  job_in_progress: 'Extraction is already running.',
  file_missing: 'The stored file is no longer available.',
  network: 'Could not reach the server. Check your connection and try again.',
};

async function parseError(response: Response): Promise<DocumentAiError> {
  let body: Partial<DocumentAiErrorBody> | null = null;
  try {
    body = (await response.json()) as Partial<DocumentAiErrorBody>;
  } catch {
    body = null;
  }
  const code = (body?.code ?? 'internal_error') as DocumentAiErrorCode;
  // For a rejected file the server's own reason is more useful than the generic line (it names what was wrong).
  const preferServer = code === 'unsupported_type' && !!body?.error;
  if (TRANSIENT_STATUSES.has(response.status) && !body?.error) {
    return new DocumentAiError(response.status, code, 'The server is busy or restarting. Wait a minute and press Retry.', body?.jobId);
  }
  const message = (preferServer ? body?.error : FRIENDLY_MESSAGES[code]) ?? body?.error ?? `Request failed (${response.status}).`;
  return new DocumentAiError(response.status, code, message, body?.jobId);
}

/** A busy or restarting server (the host's proxy answers 429/502/503/504) is retried a few times, not shown at once. */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [1500, 4000, 9000, 15000, 25000];
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function send(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let response: Response | null = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(`${DOCUMENT_AI_API_BASE}${path}`, {
        ...init,
        headers,
        credentials: 'same-origin',
      });
    } catch {
      response = null;
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw new DocumentAiError(0, 'network', FRIENDLY_MESSAGES.network ?? 'Network error.');
      }
      await pause(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (!TRANSIENT_STATUSES.has(response.status) || attempt >= RETRY_DELAYS_MS.length) break;
    const retryAfter = Number(response.headers.get('Retry-After'));
    await pause(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30000) : RETRY_DELAYS_MS[attempt]);
  }
  if (response.ok) return response;
  const error = await parseError(response);
  if (response.status === 401 && error.code === 'unauthenticated' && !retried) {
    if (await requestUnlock()) return send(path, init, true);
  }
  throw error;
}

/** `noUnlock` fails on 401 instead of opening the access-code prompt. */
async function json<T>(path: string, init?: RequestInit, noUnlock = false): Promise<T> {
  const response = await send(path, init, noUnlock);
  return (await response.json()) as T;
}

const enc = encodeURIComponent;
const body = (value: unknown) => JSON.stringify(value);

export function sessionDocumentFileUrl(
  sessionId: string,
  documentId: string,
  disposition: 'inline' | 'attachment'
): string {
  return `${DOCUMENT_AI_API_BASE}/sessions/${enc(sessionId)}/documents/${enc(documentId)}/file?disposition=${disposition}`;
}

export const documentAiClient = {
  getAuthStatus: () => json<AuthStatusResponse>('/auth/status'),
  createAuthSession: (request: CreateAuthSessionRequest) =>
    json<AuthStatusResponse>('/auth/session', { method: 'POST', body: body(request) }),
  logout: async () => {
    await send('/auth/logout', { method: 'POST', body: body({}) }).catch(() => undefined);
  },

  getSettings: () => json<DocumentAiSettingsResponse>('/settings'),
  updateSettings: (request: UpdateDocumentAiSettingsRequest) =>
    json<DocumentAiSettingsResponse>('/settings', { method: 'PUT', body: body(request) }),

  findSession: (assessmentId: string) =>
    json<FindSessionResponse>(`/sessions?assessmentId=${enc(assessmentId)}`),
  /** Null while the session has no upload yet (404), which the client treats as empty. */
  async getSession(sessionId: string): Promise<DocumentSessionState | null> {
    try {
      return await json<DocumentSessionState>(`/sessions/${enc(sessionId)}`);
    } catch (error) {
      if (error instanceof DocumentAiError && error.status === 404) return null;
      throw error;
    }
  },
  getTotals: (sessionId: string) => json<SessionTotals>(`/sessions/${enc(sessionId)}/totals`),
  linkSession: (sessionId: string, assessmentId: string) =>
    json<DocumentSessionState>(`/sessions/${enc(sessionId)}/link`, {
      method: 'POST',
      body: body({ assessmentId }),
    }),

  /** Streams the file itself (no base64), so large files and multi-GB ZIPs stay out of memory. */
  uploadFile: (sessionId: string, file: File) =>
    json<UploadDocumentResponse>(`/sessions/${enc(sessionId)}/uploads`, {
      method: 'POST',
      body: file,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        'X-Document-AI-Upload': '1',
      },
    }),
  uploadDocument: (sessionId: string, request: UploadDocumentRequest) =>
    json<UploadDocumentResponse>(`/sessions/${enc(sessionId)}/documents`, {
      method: 'POST',
      body: body(request),
    }),
  updateDocument: (sessionId: string, documentId: string, request: UpdateDocumentRequest) =>
    json<DocumentSessionState>(`/sessions/${enc(sessionId)}/documents/${enc(documentId)}`, {
      method: 'PATCH',
      body: body(request),
    }),
  getPreview: (sessionId: string, documentId: string) =>
    json<SpreadsheetPreview>(`/sessions/${enc(sessionId)}/documents/${enc(documentId)}/preview`),
  deleteDocument: (sessionId: string, documentId: string, mode: DeleteDocumentMode) =>
    json<DeleteDocumentResponse>(
      `/sessions/${enc(sessionId)}/documents/${enc(documentId)}?mode=${mode}`,
      { method: 'DELETE' }
    ),

  /** Opens a password-protected PDF. The password is sent once, over this request only, and is never kept. */
  unlockPdf: (sessionId: string, documentId: string, password: string) =>
    json<DocumentSessionState>(`/sessions/${enc(sessionId)}/documents/${enc(documentId)}/unlock`, {
      method: 'POST',
      body: body({ password }),
    }),

  startExtraction: (sessionId: string, request: StartExtractionRequest = {}) =>
    json<StartExtractionResponse>(`/sessions/${enc(sessionId)}/extract`, {
      method: 'POST',
      body: body(request),
    }),
  getJob: (sessionId: string, jobId: string) =>
    json<JobStatusResponse>(`/sessions/${enc(sessionId)}/jobs/${enc(jobId)}`),

  putEdits: (
    sessionId: string,
    request: UpdateEditsRequest,
    options: { signal?: AbortSignal; noUnlock?: boolean } = {}
  ) =>
    json<SessionEdits>(
      `/sessions/${enc(sessionId)}/edits`,
      { method: 'PUT', body: body(request), ...(options.signal ? { signal: options.signal } : {}) },
      options.noUnlock ?? false
    ),
};

export type { DocumentSessionRecord };
