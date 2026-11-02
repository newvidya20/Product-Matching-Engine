/**
 * The only file that reads GEMINI_API_KEY. Errors leaving here carry a fixed message and an
 * ExtractionErrorCode: provider text is read to classify a failure and is never forwarded.
 */
import { ApiError, GoogleGenAI, type Part, type Schema } from '@google/genai';
import type { ExtractionErrorCode } from '../../src/types/documentAi.ts';

const DEFAULT_MODEL = 'gemini-3.8-flash';
/**
 * Contract section 2. Backoff runs 1-2 s, 2-4 s, 4-8 s. Four hung attempts plus backoff take up to
 * 374 s, past the 300 s jobs.ts allows a file (section 7.6): the file then ends in llm_timeout,
 * which is retryable.
 */
const MAX_ATTEMPTS = 4;
const ATTEMPT_TIMEOUT_MS = 90_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 8_000;
/** The SDK's own limit, a backstop only: our per-attempt timeout must fire first and be recognised. */
const SDK_TIMEOUT_MS = ATTEMPT_TIMEOUT_MS + 5_000;

const ERROR_MESSAGES: Record<ExtractionErrorCode, string> = {
  password_protected: 'The document is password protected.',
  unreadable_document: 'The document could not be read.',
  llm_not_configured: 'The extraction model is not configured on the server.',
  llm_rate_limited: 'The extraction model is busy or rate limited.',
  llm_timeout: 'The extraction model timed out.',
  llm_invalid_response: 'The extraction model returned an unusable response.',
  llm_failed: 'The extraction model request failed.',
  interrupted: 'Extraction was interrupted.',
  file_missing: 'The document file is missing.',
};

/** Message is fixed per code, so it is safe to surface or log. */
export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;

  constructor(code: ExtractionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ExtractionError';
    this.code = code;
  }
}

/** A dedicated type, so a missing key cannot be mistaken for a provider failure. */
export class LlmNotConfiguredError extends ExtractionError {
  constructor() {
    super('llm_not_configured');
    this.name = 'LlmNotConfiguredError';
  }
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function geminiModelName(): string {
  return process.env.DOCUMENT_AI_GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * Retries live in callWithRetry, in one place: an SDK retry would multiply them and hide them from
 * the job's signal. The SDK retries only when retryOptions is set, so this is stated, not assumed.
 */
export const GEMINI_HTTP_OPTIONS = {
  headers: { 'User-Agent': 'aistudio-build' },
  timeout: SDK_TIMEOUT_MS,
  retryOptions: { attempts: 1 },
};

function createClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new LlmNotConfiguredError();
  return new GoogleGenAI({
    apiKey,
    httpOptions: GEMINI_HTTP_OPTIONS,
  });
}

function providerStatus(error: unknown): number | null {
  if (error instanceof ApiError) return error.status;
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = Number((error as { status?: unknown }).status);
    return Number.isFinite(status) ? status : null;
  }
  return null;
}

function providerMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function isRateLimited(error: unknown): boolean {
  const status = providerStatus(error);
  if (status !== null) return status === 429 || status === 503;
  return /\b(?:429|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(providerMessage(error));
}

function isProviderTimeout(error: unknown): boolean {
  const status = providerStatus(error);
  return status === 408 || status === 504 || /DEADLINE_EXCEEDED/.test(providerMessage(error));
}

/** Exported so the mapping can be unit tested. Returns a code, never the provider's text. */
export function classifyProviderError(error: unknown): ExtractionErrorCode {
  const status = providerStatus(error);
  const message = providerMessage(error);
  if (isRateLimited(error)) return 'llm_rate_limited';
  if (isProviderTimeout(error)) return 'llm_timeout';
  // A rejected key is an operator problem, the same one as a missing key.
  if (status === 401 || status === 403 || /API[_ ]KEY[_ ]INVALID|API key not valid/i.test(message)) {
    return 'llm_not_configured';
  }
  if (status === 400 && /no pages|invalid (?:pdf|document|image|file)|unable to process/i.test(message)) {
    return 'unreadable_document';
  }
  return 'llm_failed';
}

function abortError(): DOMException {
  return new DOMException('Extraction was aborted.', 'AbortError');
}

/** Delay before retry `retry` (1-based): capped exponential, with equal jitter. */
export function backoffDelayMs(retry: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (retry - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** Settles when `run` does, or as soon as `signal` fires, even if the provider call ignores it. */
function untilAborted<T>(run: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    run.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Runs one provider call with a timeout per attempt, retrying 429, 503 and timeouts. Rejects with
 * ExtractionError, whose code stays retryable (llm_rate_limited, llm_timeout) for those failures,
 * or with an AbortError when the job's signal fires, which is never retried.
 */
export async function callWithRetry<T>(
  run: (attemptSignal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = MAX_ATTEMPTS,
    attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
    sleep = waitForRetry,
    random = Math.random,
  } = options;

  for (let attempt = 1; ; attempt += 1) {
    if (signal.aborted) throw abortError();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), attemptTimeoutMs);
    const attemptSignal = AbortSignal.any([signal, timeout.signal]);
    try {
      return await untilAborted(run(attemptSignal), attemptSignal);
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof ExtractionError) throw error;
      const timedOut = timeout.signal.aborted;
      const retryable = timedOut || isRateLimited(error) || isProviderTimeout(error);
      if (attempt >= maxAttempts || !retryable) {
        throw new ExtractionError(timedOut ? 'llm_timeout' : classifyProviderError(error));
      }
    } finally {
      clearTimeout(timer);
    }
    await sleep(backoffDelayMs(attempt, random), signal);
  }
}

export interface GeminiJsonRequest {
  systemInstruction: string;
  parts: Part[];
  responseSchema: Schema;
  signal: AbortSignal;
}

/**
 * Returns the model's JSON text. Rejects with ExtractionError, or an AbortError when the signal
 * fires. Sends no tools: the model can only answer against the schema.
 */
export async function generateJson(request: GeminiJsonRequest): Promise<string> {
  const { systemInstruction, parts, responseSchema, signal } = request;
  const client = createClient();

  return callWithRetry(async (attemptSignal) => {
    const response = await client.models.generateContent({
      model: geminiModelName(),
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction,
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema,
        abortSignal: attemptSignal,
      },
    });
    const text = response.text;
    if (!text) throw new ExtractionError('llm_invalid_response');
    return text;
  }, signal);
}
