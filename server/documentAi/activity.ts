/**
 * Append-only activity log (docs/contracts.md section 11).
 * IDs, file names and field IDs only. Never values, snippets, document text or secrets.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { ACTIVITY_EVENT_TYPES } from '../../src/types/documentAi.ts';
import type { ActivityEvent, ActivityEventType } from '../../src/types/documentAi.ts';
import { safeJoin } from './store.ts';

export type ActivityInput = Partial<Omit<ActivityEvent, 'id' | 'at' | 'type'>> & { type: ActivityEventType };

const GSTIN_SHAPE = /\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]/gi;
const PAN_SHAPE = /[A-Z]{5}\d{4}[A-Z]/gi;
const FIELD_ID_SHAPE = /^[A-Za-z0-9_.]{1,120}$/;
const CODE_SHAPE = /^[A-Za-z0-9_.:\-]{1,64}$/;
const COUNT_KEY_SHAPE = /^[A-Za-z0-9_]{1,40}$/;
const REF_SHAPE = /^[A-Za-z0-9_\-:.@]{1,200}$/;

export function maskIdentifiers(name: string): string {
  return name.replace(GSTIN_SHAPE, '[MASKED]').replace(PAN_SHAPE, '[MASKED]');
}

const refOrNull = (v: unknown): string | null =>
  typeof v === 'string' && REF_SHAPE.test(v) ? v : null;

let queue: Promise<unknown> = Promise.resolve();

/** Never throws, never rejects. */
export function logActivity(input: ActivityInput): Promise<void> {
  try {
    if (!ACTIVITY_EVENT_TYPES.includes(input.type)) return Promise.resolve();
    const at = new Date();
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(input.counts || {})) {
      if (COUNT_KEY_SHAPE.test(k) && typeof v === 'number' && Number.isFinite(v)) counts[k] = v;
    }
    const event: ActivityEvent = {
      id: `act_${crypto.randomUUID()}`,
      at: at.toISOString(),
      type: input.type,
      actor: typeof input.actor === 'string' ? maskIdentifiers(input.actor).slice(0, 200) : 'system',
      sessionId: refOrNull(input.sessionId),
      assessmentId: refOrNull(input.assessmentId),
      documentId: refOrNull(input.documentId),
      jobId: refOrNull(input.jobId),
      fileName:
        typeof input.fileName === 'string'
          ? maskIdentifiers(input.fileName.replace(/[\r\n]/g, ' ')).slice(0, 200)
          : null,
      fieldIds: (input.fieldIds || []).filter((f) => typeof f === 'string' && FIELD_ID_SHAPE.test(f)).slice(0, 500),
      code: typeof input.code === 'string' && CODE_SHAPE.test(input.code) ? input.code : null,
      counts,
    };
    const file = safeJoin('activity', `${event.at.slice(0, 7)}.jsonl`);
    const run = async () => {
      try {
        await fsp.mkdir(safeJoin('activity'), { recursive: true, mode: 0o700 });
        await fsp.appendFile(file, JSON.stringify(event) + '\n', { mode: 0o600 });
      } catch {
        // Logging must never break a request.
      }
    };
    const p = queue.then(run, run);
    queue = p;
    return p;
  } catch {
    return Promise.resolve();
  }
}
