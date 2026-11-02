/** Pure helpers for the reopened-draft protection marks. */
import type { EditedFieldEntry } from '../../types/documentAi';

/** What the server says a document applied to a field, next to the value the saved draft holds. */
export interface AppliedComparison {
  /** Normalised value of the applied candidate; null when it cannot be found. */
  applied: string | number | null;
  /** The value saved on the draft, as the form stores it. */
  saved: string;
}

function toNumber(value: string | number): number {
  if (typeof value === 'number') return value;
  const cleaned = value.replace(/[,\s%₹]/g, '');
  return cleaned === '' ? Number.NaN : Number(cleaned);
}

/** Type-aware equality: numbers compare by value, everything else as trimmed text. */
export function sameFieldValue(saved: string, applied: string | number | null): boolean {
  if (applied === null || applied === undefined) return false;
  if (typeof applied === 'number') {
    const n = toNumber(saved);
    return Number.isFinite(n) && n === applied;
  }
  const a = toNumber(applied);
  const s = toNumber(saved);
  if (Number.isFinite(a) && Number.isFinite(s) && /^[\d.,\s%₹+-]+$/.test(applied) && /^[\d.,\s%₹+-]+$/.test(saved)) {
    return a === s;
  }
  return saved.trim() === applied.trim();
}

/**
 * Drops `preexisting_value` marks for fields where the server's applied value equals the saved value, since
 * that value came from the document. When they differ (or the applied value is unknown) the saved value is
 * the person's own, so the mark stays and is queued in `pendingSetEdited` so the server learns it.
 * Marks with any other origin are untouched. Returns the ids whose marks were dropped.
 */
export function dropSeededMarksForApplied(
  edited: Record<string, EditedFieldEntry>,
  pendingSetEdited: Record<string, EditedFieldEntry>,
  appliedById: Record<string, AppliedComparison>,
  serverEditedIds: ReadonlySet<string> = new Set()
): string[] {
  const dropped: string[] = [];
  for (const [id, cmp] of Object.entries(appliedById)) {
    const mark = edited[id]?.origin === 'preexisting_value' ? edited[id] : undefined;
    const pendingMark = pendingSetEdited[id]?.origin === 'preexisting_value' ? pendingSetEdited[id] : undefined;
    if (!mark && !pendingMark) continue;
    if (sameFieldValue(cmp.saved, cmp.applied)) {
      delete edited[id];
      delete pendingSetEdited[id];
      dropped.push(id);
    } else if (!serverEditedIds.has(id)) {
      const keep = (mark ?? pendingMark) as EditedFieldEntry;
      edited[id] = keep;
      pendingSetEdited[id] = keep;
    }
  }
  return dropped;
}
