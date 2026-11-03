import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@google/genai';
import {
  DEFAULT_OPENROUTER_MODEL,
  OpenRouterHttpError,
  openRouterJson,
  stripCodeFence,
  toContentParts,
  toJsonSchema,
} from '../server/llm/openrouter.ts';
import { activeLlmProvider, isActiveLlmConfigured } from '../server/llm/provider.ts';
import { classifyProviderError } from '../server/documentAi/gemini.ts';

const ENV_KEYS = ['LLM_PROVIDER', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_FALLBACK_MODELS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  globalThis.fetch = realFetch;
});

function setEnv(values: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
}

describe('provider selection', () => {
  it('uses OpenRouter when its key is set and no provider is named', () => {
    setEnv({ OPENROUTER_API_KEY: 'or-key', GEMINI_API_KEY: 'g-key' });
    assert.equal(activeLlmProvider(), 'openrouter');
  });

  it('falls back to Gemini when only the Gemini key is set', () => {
    setEnv({ GEMINI_API_KEY: 'g-key' });
    assert.equal(activeLlmProvider(), 'gemini');
    assert.equal(isActiveLlmConfigured(), true);
  });

  it('honours LLM_PROVIDER=gemini even with an OpenRouter key, so switching back is one setting', () => {
    setEnv({ LLM_PROVIDER: 'gemini', OPENROUTER_API_KEY: 'or-key', GEMINI_API_KEY: 'g-key' });
    assert.equal(activeLlmProvider(), 'gemini');
  });

  it('reports not configured when the named provider has no key', () => {
    setEnv({ LLM_PROVIDER: 'openrouter', GEMINI_API_KEY: 'g-key' });
    assert.equal(isActiveLlmConfigured(), false);
  });
});

describe('Gemini schema to JSON Schema', () => {
  it('lower-cases types, keeps required and enums, and closes objects', () => {
    const schema = toJsonSchema({
      type: Type.OBJECT,
      properties: {
        unit: { type: Type.STRING, nullable: true, enum: ['lakh', 'crore'] },
        rows: { type: Type.ARRAY, items: { type: Type.INTEGER, nullable: true } },
      },
      required: ['unit'],
    });
    assert.deepEqual(schema, {
      type: 'object',
      properties: {
        unit: { type: ['string', 'null'], enum: ['lakh', 'crore', null] },
        rows: { type: 'array', items: { type: ['integer', 'null'] } },
      },
      additionalProperties: false,
      required: ['unit'],
    });
  });
});

describe('Gemini parts to OpenRouter content', () => {
  it('sends PDFs as file parts, images as data URLs and text as text', () => {
    const parts = toContentParts([
      { inlineData: { mimeType: 'application/pdf', data: 'UERG' } },
      { inlineData: { mimeType: 'image/png', data: 'iVBO' } },
      { text: 'hello' },
    ]);
    assert.deepEqual(parts, [
      { type: 'file', file: { filename: 'document-1.pdf', file_data: 'data:application/pdf;base64,UERG' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } },
      { type: 'text', text: 'hello' },
    ]);
  });

  it('refuses an unsupported part instead of dropping it', () => {
    assert.throws(() => toContentParts([{ inlineData: { mimeType: 'audio/mp3', data: 'x' } }]), OpenRouterHttpError);
  });
});

describe('openRouterJson', () => {
  it('asks for JSON schema output from providers that do not collect data, with fallbacks', async () => {
    setEnv({ OPENROUTER_API_KEY: 'or-key' });
    let sent = null as { url: string; body: Record<string, unknown>; auth: string } | null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = {
        url,
        body: JSON.parse(String(init.body)),
        auth: String((init.headers as Record<string, string>).Authorization),
      };
      return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] }), {
        status: 200,
      });
    }) as typeof fetch;

    const text = await openRouterJson({
      systemInstruction: 'sys',
      parts: [{ text: 'doc' }],
      responseSchema: { type: Type.OBJECT, properties: { ok: { type: Type.BOOLEAN } } },
    });

    assert.equal(text, '{"ok":true}');
    assert.ok(sent);
    assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(sent.auth, 'Bearer or-key');
    assert.equal(sent.body.model, DEFAULT_OPENROUTER_MODEL);
    assert.ok(Array.isArray(sent.body.models) && (sent.body.models as string[]).length > 1);
    assert.deepEqual(sent.body.provider, { data_collection: 'deny' });
    assert.equal(sent.body.max_tokens, 12000);
    assert.deepEqual(sent.body.reasoning, { enabled: false });
    assert.equal((sent.body.response_format as { type: string }).type, 'json_schema');
    assert.equal(sent.body.temperature, 0);
  });

  it('turns provider errors into statuses that map to retryable or operator codes', async () => {
    setEnv({ OPENROUTER_API_KEY: 'or-key' });
    for (const [status, code] of [
      [429, 'llm_rate_limited'],
      [502, 'llm_rate_limited'],
      [402, 'llm_not_configured'],
      [401, 'llm_not_configured'],
    ] as const) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { code: status, message: 'provider text' } }), { status })) as typeof fetch;
      const error = await openRouterJson({
        systemInstruction: 's',
        parts: [{ text: 'd' }],
        responseSchema: { type: Type.OBJECT },
      }).catch((e: unknown) => e);
      assert.ok(error instanceof OpenRouterHttpError);
      assert.equal(classifyProviderError(error), code, String(status));
    }
  });

  it('fails as not configured without a key and makes no request', async () => {
    setEnv({});
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;
    const error = await openRouterJson({ systemInstruction: 's', parts: [{ text: 'd' }], responseSchema: { type: Type.OBJECT } }).catch(
      (e: unknown) => e
    );
    assert.equal(called, false);
    assert.equal(classifyProviderError(error), 'llm_not_configured');
  });
});

describe('stripCodeFence', () => {
  it('leaves bare JSON alone', () => {
    assert.equal(stripCodeFence(' {"a":1} '), '{"a":1}');
  });
});

describe('daily quota', () => {
  it('maps a per-day limit to llm_quota_exhausted instead of a retryable busy error', () => {
    const daily = new OpenRouterHttpError(429, 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day');
    assert.equal(classifyProviderError(daily), 'llm_quota_exhausted');
    assert.equal(classifyProviderError(new OpenRouterHttpError(429, 'Rate limit exceeded, retry shortly')), 'llm_rate_limited');
  });
});
