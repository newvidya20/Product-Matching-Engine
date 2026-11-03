import { promptForAccessCode } from './documentAiClient';
import type {
  ContinueEligibilityResponse,
  CreateEligibilityRecordRequest,
  EligibilityErrorBody,
  EligibilityErrorCode,
  EligibilityRecordResponse,
  EligibilityRulesResponse,
  EvaluateEligibilityRequest,
  EvaluateEligibilityResponse,
  ListEligibilityRecordsResponse,
  PrefillEligibilityRequest,
  PrefillEligibilityResponse,
  UpdateEligibilityRecordRequest,
} from '../types/eligibility';

export const ELIGIBILITY_API_BASE = '/api/eligibility';

/** Error from an eligibility route. The message never carries borrower data. */
export class EligibilityError extends Error {
  status: number;
  code: EligibilityErrorCode | 'network';
  fields: string[];

  constructor(status: number, code: EligibilityErrorCode | 'network', message: string, fields: string[] = []) {
    super(message);
    this.name = 'EligibilityError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

const FRIENDLY_MESSAGES: Partial<Record<EligibilityErrorCode | 'network', string>> = {
  unauthenticated: 'Enter the access code to continue.',
  rules_unavailable: 'The eligibility rules file is unavailable, so no check can run. Ask an admin to restore it.',
  rules_invalid: 'The eligibility rules file is invalid, so no check can run. Ask an admin to fix it.',
  record_final: 'This record is final. Only reassess or continue are allowed.',
  record_not_found: 'That eligibility record no longer exists.',
  assessment_not_found: 'That assessment could not be found.',
  network: 'Could not reach the server. Check your connection and try again.',
};

async function parseError(response: Response): Promise<EligibilityError> {
  let body: Partial<EligibilityErrorBody> | null = null;
  try {
    body = (await response.json()) as Partial<EligibilityErrorBody>;
  } catch {
    body = null;
  }
  const code = (body?.code ?? 'internal_error') as EligibilityErrorCode;
  const message = FRIENDLY_MESSAGES[code] ?? body?.error ?? `Request failed (${response.status}).`;
  return new EligibilityError(response.status, code, message, body?.fields ?? []);
}

async function send(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(`${ELIGIBILITY_API_BASE}${path}`, { ...init, headers, credentials: 'same-origin' });
  } catch {
    throw new EligibilityError(0, 'network', FRIENDLY_MESSAGES.network ?? 'Network error.');
  }
  if (response.ok) return response;
  const error = await parseError(response);
  // Same cookie as Document AI: DocumentAccessGate asks for the code once, then the call is retried.
  if (response.status === 401 && error.code === 'unauthenticated' && !retried) {
    if (await promptForAccessCode()) return send(path, init, true);
  }
  throw error;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await send(path, init);
  return (await response.json()) as T;
}

const enc = encodeURIComponent;
const body = (value: unknown) => JSON.stringify(value);

export const eligibilityClient = {
  getRules: () => json<EligibilityRulesResponse>('/rules'),
  evaluate: (request: EvaluateEligibilityRequest) =>
    json<EvaluateEligibilityResponse>('/evaluate', { method: 'POST', body: body(request) }),
  prefill: (request: PrefillEligibilityRequest) =>
    json<PrefillEligibilityResponse>('/prefill', { method: 'POST', body: body(request) }),

  listRecords: () => json<ListEligibilityRecordsResponse>('/records'),
  getRecord: (id: string) => json<EligibilityRecordResponse>(`/records/${enc(id)}`),
  createRecord: (request: CreateEligibilityRecordRequest) =>
    json<EligibilityRecordResponse>('/records', { method: 'POST', body: body(request) }),
  updateRecord: (id: string, request: UpdateEligibilityRecordRequest) =>
    json<EligibilityRecordResponse>(`/records/${enc(id)}`, { method: 'PUT', body: body(request) }),
  reassess: (id: string) =>
    json<EligibilityRecordResponse>(`/records/${enc(id)}/reassess`, { method: 'POST', body: body({}) }),
  continueToAssessment: (id: string) =>
    json<ContinueEligibilityResponse>(`/records/${enc(id)}/continue`, { method: 'POST', body: body({}) }),
};
