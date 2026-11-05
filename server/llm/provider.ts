/**
 * OpenRouter is the active business choice for this project. Gemini remains installed and configured
 * in the environment, but it stays on standby until an operator deliberately re-enables it.
 */
import { isOpenRouterConfigured, openRouterModel } from './openrouter.ts';

export type LlmProvider = 'openrouter' | 'gemini';

const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

export function activeLlmProvider(): LlmProvider {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === 'openrouter') return 'openrouter';
  if (explicit === 'gemini') return isOpenRouterConfigured() ? 'openrouter' : 'gemini';
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
