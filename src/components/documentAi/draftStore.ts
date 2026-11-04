/**
 * Browser-side draft for New Assessment. The server's disk is wiped on every restart (Render free), so
 * anything that must survive a restart or a tab change lives here, in the user's own browser.
 *
 * What is stored: the form values, the edited/applied/dismissed maps, the session id and the last known
 * document session state (names, types, statuses, read results with source snippets, conflicts, warnings).
 * Never stored: access codes, API keys, file bytes. Only the Reset button (and Populate Demo, which
 * replaces the content) removes it; saving or submitting does not.
 * Pure, no React. Every storage call is guarded: blocked or full storage degrades, never throws.
 */
import type {
  AppliedFieldEntry,
  DocumentSessionState,
  EditedFieldEntry,
} from '../../types/documentAi';
import type { FormState } from './formModel';

export const DRAFT_STORAGE_KEY = 'lb.assessmentDraft.v1';
export const ELIGIBILITY_DRAFT_STORAGE_KEY = 'lb.eligibilityDraft.v1';

export interface DraftExtras {
  /** The assessment this form was saved as, so the next save updates it instead of duplicating it. */
  saved?: { id: string; referenceCode: string } | null;
  /** Eligibility record this form came from. */
  eligibilityRecordId?: string | null;
  conditions?: Array<{ criterionId: string; label: string; reason: string }>;
}

export interface AssessmentDraft {
  v: 1;
  savedAt: string;
  sessionId: string;
  form: FormState;
  edited: Record<string, EditedFieldEntry>;
  applied: Record<string, AppliedFieldEntry>;
  /** Fields this page applied itself (the only ones apply logic may later revert). */
  localApplied: string[];
  dismissed: Record<string, string>;
  /** Last known server state. Null before any upload. */
  docState: DocumentSessionState | null;
  protectInitial: boolean;
  extras: DraftExtras;
}

export type WriteResult = 'full' | 'without_documents' | 'failed';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDraft(): AssessmentDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AssessmentDraft> | null;
    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.sessionId !== 'string' ||
      !parsed.sessionId ||
      !parsed.form ||
      typeof parsed.form !== 'object' ||
      !parsed.form.financialProfile
    ) {
      return null;
    }
    return {
      v: 1,
      savedAt: String(parsed.savedAt ?? ''),
      sessionId: parsed.sessionId,
      form: parsed.form,
      edited: parsed.edited && typeof parsed.edited === 'object' ? parsed.edited : {},
      applied: parsed.applied && typeof parsed.applied === 'object' ? parsed.applied : {},
      localApplied: Array.isArray(parsed.localApplied) ? parsed.localApplied : [],
      dismissed: parsed.dismissed && typeof parsed.dismissed === 'object' ? parsed.dismissed : {},
      docState:
        parsed.docState && typeof parsed.docState === 'object' && Array.isArray(parsed.docState.documents)
          ? parsed.docState
          : null,
      protectInitial: Boolean(parsed.protectInitial),
      extras: parsed.extras && typeof parsed.extras === 'object' ? parsed.extras : {},
    };
  } catch {
    return null;
  }
}

/** Full snapshot first; if the quota is hit, the form and marks without the document results. */
export function writeDraft(draft: AssessmentDraft): WriteResult {
  const store = storage();
  if (!store) return 'failed';
  try {
    store.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    return 'full';
  } catch {
    /* quota or blocked: try a smaller snapshot */
  }
  try {
    store.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ ...draft, docState: null }));
    return 'without_documents';
  } catch {
    return 'failed';
  }
}

export function clearDraft(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

// ------------------------------------------------------------- Eligibility

export interface EligibilityDraft {
  v: 1;
  savedAt: string;
  values: Record<string, string>;
  sources: Record<string, unknown>;
  applicantLabel: string;
  assessmentId: string;
  sessionId: string;
  /** The saved record being edited, if any. Reloaded from the server on restore. */
  recordId: string | null;
}

export function readEligibilityDraft(): EligibilityDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(ELIGIBILITY_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EligibilityDraft> | null;
    if (!parsed || parsed.v !== 1 || !parsed.values || typeof parsed.values !== 'object') return null;
    return {
      v: 1,
      savedAt: String(parsed.savedAt ?? ''),
      values: parsed.values,
      sources: parsed.sources && typeof parsed.sources === 'object' ? parsed.sources : {},
      applicantLabel: String(parsed.applicantLabel ?? ''),
      assessmentId: String(parsed.assessmentId ?? ''),
      sessionId: String(parsed.sessionId ?? ''),
      recordId: typeof parsed.recordId === 'string' ? parsed.recordId : null,
    };
  } catch {
    return null;
  }
}

export function writeEligibilityDraft(draft: EligibilityDraft): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(ELIGIBILITY_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    /* full or blocked: the draft is simply not kept */
  }
}

export function clearEligibilityDraft(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(ELIGIBILITY_DRAFT_STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
