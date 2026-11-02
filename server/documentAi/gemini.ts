/**
 * The only file that reads GEMINI_API_KEY. Errors leaving here carry a fixed message and an
 * ExtractionErrorCode: provider text is read to classify a failure and is never forwarded.
 */
import { ApiError, GoogleGenAI, type Part, type Schema } from '@google/genai';
import type { ExtractionErrorCode } from '../../src/types/documentAi.ts';

const DEFAULT_MODEL = 'gemini-3.8-flash';
/** One retry on 429/503, per contract section 2. */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 900;

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

function createClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new LlmNotConfiguredError();
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
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

function isRetryable(error: unknown): boolean {
  const status = providerStatus(error);
  if (status !== null) return status === 429 || status === 503;
  return /\b(?:429|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(providerMessage(error));
}

/** Exported so the mapping can be unit tested. Returns a code, never the provider's text. */
export function classifyProviderError(error: unknown): ExtractionErrorCode {
  const status = providerStatus(error);
  const message = providerMessage(error);
  if (isRetryable(error)) return 'llm_rate_limited';
  if (status === 408 || status === 504 || /DEADLINE_EXCEEDED/.test(message)) return 'llm_timeout';
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

function waitForRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, RETRY_DELAY_MS);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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

  for (let attempt = 1; ; attempt += 1) {
    if (signal.aborted) throw abortError();
    try {
      const response = await client.models.generateContent({
        model: geminiModelName(),
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction,
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema,
          abortSignal: signal,
        },
      });
      if (signal.aborted) throw abortError();
      const text = response.text;
      if (!text) throw new ExtractionError('llm_invalid_response');
      return text;
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof ExtractionError) throw error;
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) {
        throw new ExtractionError(classifyProviderError(error));
      }
    }
    await waitForRetry(signal);
  }
}
