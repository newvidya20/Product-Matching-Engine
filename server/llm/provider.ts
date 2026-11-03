/**
 * Which LLM serves every AI feature. LLM_PROVIDER=openrouter|gemini picks one explicitly; unset, it
 * uses OpenRouter when OPENROUTER_API_KEY is present and Gemini otherwise. All Gemini code is kept,
 * so switching back is one env change.
 */
import { isOpenRouterConfigured, openRouterModel } from './openrouter.ts';

export type LlmProvider = 'openrouter' | 'gemini';

const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

export function activeLlmProvider(): LlmProvider {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === 'openrouter' || explicit === 'gemini') return explicit;
  return isOpenRouterConfigured() ? 'openrouter' : 'gemini';
}

export function isActiveLlmConfigured(): boolean {
  return activeLlmProvider() === 'openrouter'
    ? isOpenRouterConfigured()
    : Boolean(process.env.GEMINI_API_KEY?.trim());
}

/** Gemini model for the non-Document-AI services, overridable with GEMINI_MODEL. */
export function geminiServiceModel(): string {
  return process.env.GEMINI_MODEL?.trim() || GEMINI_DEFAULT_MODEL;
}

export function activeServiceModel(): string {
  return activeLlmProvider() === 'openrouter' ? openRouterModel() : geminiServiceModel();
}
