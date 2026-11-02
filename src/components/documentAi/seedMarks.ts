/** Pure helpers for the reopened-draft protection marks and the stored session pointer. */
import type { EditedFieldEntry } from '../../types/documentAi';

/**
 * Drops `preexisting_value` marks for fields the server says a document applied. Those marks were a
 * render-time guess made before the server's applied fields were known. Marks for all other fields stay,
 * as do marks with any other origin. Returns the ids whose marks were dropped.
 */
export function dropSeededMarksForApplied(
  edited: Record<string, EditedFieldEntry>,
  pendingSetEdited: Record<string, EditedFieldEntry>,
  serverAppliedIds: Iterable<string>
): string[] {
  const dropped: string[] = [];
  for (const id of serverAppliedIds) {
    let removed = false;
    if (edited[id]?.origin === 'preexisting_value') {
      delete edited[id];
      removed = true;
    }
    if (pendingSetEdited[id]?.origin === 'preexisting_value') {
      delete pendingSetEdited[id];
      removed = true;
    }
    if (removed) dropped.push(id);
  }
  return dropped;
}

/** Reset keeps an existing stored session pointer so it cannot orphan an unsaved session. */
export function nextStoredSession(existing: string | null, next: string): string {
  return existing ? existing : next;
}
