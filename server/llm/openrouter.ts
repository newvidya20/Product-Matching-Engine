/**
 * OpenRouter client, used when LLM_PROVIDER resolves to "openrouter". The only file that reads
 * OPENROUTER_API_KEY. Callers keep building Gemini-shaped requests (Part[], Schema); this file
 * translates them to OpenRouter's OpenAI-compatible chat API, so prompts and schemas have one source.
 * Gemini stays fully supported: see server/llm/provider.ts.
 */
import type { Part, Schema } from '@google/genai';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Free models by default (no credits needed). dots-3 reads images, supports JSON schema and is offered
 * by a provider that does not collect data. Nemotron is stronger but every host of it trains on
 * prompts, so OpenRouter only uses it when OPENROUTER_ALLOW_DATA_COLLECTION=true.
 */
export const DEFAULT_OPENROUTER_MODEL = 'dots-studio/dots-3-note-preview:free';
/** Tried in order by OpenRouter when the primary model fails or is unavailable. */
export const DEFAULT_OPENROUTER_FALLBACKS = ['nvidia/nemotron-3.5-super-vl:free'];

/** Off unless set to true: borrower documents are KYC material. */
export function openRouterAllowsDataCollection(): boolean {
  return process.env.OPENROUTER_ALLOW_DATA_COLLECTION?.trim().toLowerCase() === 'true';
}

/**
 * Free models take no PDF files (and OpenRouter wants paid credit for files), so by default a digital
 * PDF goes as the text the server read itself. OPENROUTER_PDF_INPUT=file sends the file instead.
 */
export function openRouterSendsPdfAsText(): boolean {
  return process.env.OPENROUTER_PDF_INPUT?.trim().toLowerCase() !== 'file';
}

export function openRouterModel(): string {
  return process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
}

export function openRouterFallbackModels(): string[] {
  const raw = process.env.OPENROUTER_FALLBACK_MODELS;
  if (raw === undefined) return DEFAULT_OPENROUTER_FALLBACKS;
  return raw
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

/** Caps the output reservation: without it a fallback model reserves its own maximum (65k tokens) of credit. */
export function openRouterMaxTokens(): number {
  const value = Number(process.env.OPENROUTER_MAX_TOKENS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 12_000;
}

/**
 * Thinking models write long hidden reasoning before answering. Extraction is checked by the server
 * afterwards, so it is off by default: about 3x faster on the free model with the same fields.
 * OPENROUTER_REASONING=low or on brings it back.
 */
export function openRouterReasoning(): { enabled: false } | { effort: 'low' } | null {
  const mode = process.env.OPENROUTER_REASONING?.trim().toLowerCase();
  if (mode === 'on') return null;
  if (mode === 'low') return { effort: 'low' };
  return { enabled: false };
}

export function isOpenRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

/** Carries the HTTP status only, so callers classify by status and never forward provider text. */
export class OpenRouterHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpenRouterHttpError';
    this.status = status;
  }
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

type JsonSchema = Record<string, unknown>;

/** Gemini Type values are upper-case names ("OBJECT"); JSON Schema wants lower-case ("object"). */
export function toJsonSchema(schema: Schema): JsonSchema {
  const out: JsonSchema = {};
  const baseType = schema.type ? String(schema.type).toLowerCase() : undefined;
  if (baseType && baseType !== 'type_unspecified') {
    out.type = schema.nullable ? [baseType, 'null'] : baseType;
  }
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.nullable ? [...schema.enum, null] : [...schema.enum];
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)])
    );
    out.additionalProperties = false;
  }
  if (schema.required) out.required = [...schema.required];
  if (schema.items) out.items = toJsonSchema(schema.items);
  if (schema.minimum !== undefined) out.minimum = schema.minimum;
  if (schema.maximum !== undefined) out.maximum = schema.maximum;
  if (schema.minItems !== undefined) out.minItems = Number(schema.minItems);
  if (schema.maxItems !== undefined) out.maxItems = Number(schema.maxItems);
  return out;
}

/** Inline PDFs go as file parts, images as data URLs, text as text. Anything else is refused. */
export function toContentParts(parts: Part[]): ContentPart[] {
  return parts.map((part, index) => {
    if (typeof part.text === 'string') return { type: 'text', text: part.text };
    const inline = part.inlineData;
    if (inline?.data && inline.mimeType) {
      const dataUrl = `data:${inline.mimeType};base64,${inline.data}`;
      if (inline.mimeType === 'application/pdf') {
        return { type: 'file', file: { filename: `document-${index + 1}.pdf`, file_data: dataUrl } };
      }
      if (inline.mimeType.startsWith('image/')) return { type: 'image_url', image_url: { url: dataUrl } };
    }
    throw new OpenRouterHttpError(400, 'unable to process: unsupported part for OpenRouter');
  });
}

export interface OpenRouterJsonRequest {
  systemInstruction: string;
  parts: Part[];
  responseSchema: Schema;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * One request, no retries (callers own retries). Asks only providers that do not collect data,
 * because borrower documents are KYC material. Returns the model's JSON text.
 */
export async function openRouterJson(request: OpenRouterJsonRequest): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new OpenRouterHttpError(401, 'API key not valid: OPENROUTER_API_KEY is not set');

  const fallbacks = openRouterFallbackModels();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal: request.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'LoanBazaar Product Matching Engine',
      ...(process.env.APP_URL ? { 'HTTP-Referer': process.env.APP_URL } : {}),
    },
    body: JSON.stringify({
      model: openRouterModel(),
      ...(fallbacks.length > 0 ? { models: [openRouterModel(), ...fallbacks] } : {}),
      temperature: request.temperature ?? 0,
      max_tokens: openRouterMaxTokens(),
      ...(openRouterReasoning() ? { reasoning: openRouterReasoning() } : {}),
      messages: [
        { role: 'system', content: request.systemInstruction },
        { role: 'user', content: toContentParts(request.parts) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'response', strict: false, schema: toJsonSchema(request.responseSchema) },
      },
      // require_parameters is left off: with data_collection deny few hosts also pass the schema check.
      // Responses are parsed strictly downstream, so a non-conforming answer is rejected.
      provider: { data_collection: openRouterAllowsDataCollection() ? 'allow' : 'deny' },
    }),
  });

  const body = (await response.json().catch(() => null)) as {
    error?: { code?: number | string; message?: string };
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;

  if (!response.ok || body?.error) {
    const status = Number(body?.error?.code) || response.status || 500;
    throw new OpenRouterHttpError(status, String(body?.error?.message || `HTTP ${response.status}`));
  }
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new OpenRouterHttpError(502, 'empty response');
  return stripCodeFence(text);
}

/** Some models wrap JSON in a ```json fence despite response_format; the JSON itself is untouched. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

/**
 * Runs a Gemini-style generateContent payload on OpenRouter, for services written against the Gemini
 * SDK. Returns `{ text }` like the SDK response, so their parsing code is shared by both providers.
 */
export async function generateContentViaOpenRouter(payload: {
  contents: unknown;
  config?: { systemInstruction?: unknown; temperature?: number; responseSchema?: unknown };
}): Promise<{ text: string }> {
  const { contents, config = {} } = payload;
  const parts: Part[] =
    typeof contents === 'string'
      ? [{ text: contents }]
      : Array.isArray((contents as { parts?: Part[] })?.parts)
        ? (contents as { parts: Part[] }).parts
        : [];
  if (parts.length === 0 || !config.responseSchema) {
    throw new OpenRouterHttpError(400, 'unable to process: unsupported request for OpenRouter');
  }
  const text = await openRouterJson({
    systemInstruction: typeof config.systemInstruction === 'string' ? config.systemInstruction : '',
    parts,
    responseSchema: config.responseSchema as Schema,
    temperature: config.temperature,
    signal: AbortSignal.timeout(120_000),
  });
  return { text };
}
