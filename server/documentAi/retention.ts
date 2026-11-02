/**
 * Retention (docs/contracts.md section 10). Runs at boot and every 6 hours, by uploadedAt.
 * Never touches activity/.
 */
import { UNLINKED_SESSION_TTL_HOURS } from '../../src/types/documentAi.ts';
import { logActivity } from './activity.ts';
import {
  deleteSessionDir,
  expireDocument,
  getSession,
  getSettings,
  listDocuments,
  listSessionIds,
} from './store.ts';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export async function runRetention(now: Date = new Date()): Promise<{ files: number; sessions: number }> {
  let files = 0;
  let sessions = 0;
  try {
    const { retentionDays } = await getSettings();
    const fileCutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const sessionCutoff = now.getTime() - UNLINKED_SESSION_TTL_HOURS * 60 * 60 * 1000;

    for (const sessionId of await listSessionIds()) {
      try {
        const session = await getSession(sessionId);
        if (!session) continue;
        if (!session.assessmentId && new Date(session.createdAt).getTime() < sessionCutoff) {
          await deleteSessionDir(sessionId);
          sessions += 1;
          void logActivity({ type: 'unlinked_session_purged', actor: 'system', sessionId });
          continue;
        }
        for (const doc of await listDocuments(sessionId)) {
          // Documents already deleted by a user still have results and snippets to expire.
          if (new Date(doc.uploadedAt).getTime() < fileCutoff) {
            if (await expireDocument(sessionId, doc.documentId)) files += 1;
          }
        }
      } catch {
        // One bad session must not stop the sweep.
      }
    }
    if (files > 0) void logActivity({ type: 'retention_purged', actor: 'system', counts: { files } });
  } catch {
    // Retention is best effort.
  }
  return { files, sessions };
}

export function startRetention(): void {
  if (timer) return;
  void runRetention();
  timer = setInterval(() => void runRetention(), SIX_HOURS_MS);
  timer.unref();
}
