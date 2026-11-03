/**
 * Eligibility record store (docs/eligibility-contracts.md section 8): one JSON file, atomic writes (temp file in
 * the same directory, then rename) behind one in-process promise queue. A file that exists but cannot be parsed
 * is never overwritten: every operation fails until it is fixed, so a read error cannot wipe records.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { EligibilityAssessmentRecord } from '../../src/types/eligibility.ts';

export interface RecordsFile {
  version: 1;
  records: EligibilityAssessmentRecord[];
}

export class StoreUnreadableError extends Error {
  constructor() {
    super('Eligibility records file cannot be read.');
    this.name = 'StoreUnreadableError';
  }
}

export function getDataDir(): string {
  return path.resolve(process.cwd(), process.env.ELIGIBILITY_DATA_DIR || 'data/eligibility');
}

export const getRecordsFile = () => path.join(getDataDir(), 'records.json');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

async function readRecordsFile(): Promise<RecordsFile> {
  const file = getRecordsFile();
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: 1, records: [] };
    throw new StoreUnreadableError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoreUnreadableError();
  }
  const p = parsed as Partial<RecordsFile> | null;
  if (!p || typeof p !== 'object' || p.version !== 1 || !Array.isArray(p.records)) throw new StoreUnreadableError();
  return p as RecordsFile;
}

async function writeRecordsFile(data: RecordsFile): Promise<void> {
  const file = getRecordsFile();
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: FILE_MODE });
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Creates the file when absent (section 8). Fails, without writing, when it exists but is unreadable. */
export function initRecordsStore(): Promise<void> {
  return enqueue(async () => {
    const data = await readRecordsFile();
    try {
      await fsp.access(getRecordsFile());
    } catch {
      await writeRecordsFile(data);
    }
  });
}

export function listRecords(): Promise<EligibilityAssessmentRecord[]> {
  return enqueue(async () => (await readRecordsFile()).records);
}

export function getRecord(id: string): Promise<EligibilityAssessmentRecord | null> {
  return enqueue(async () => (await readRecordsFile()).records.find((r) => r.id === id) ?? null);
}

/**
 * Read-modify-write under the queue. `fn` returns the value to resolve with and whether to write.
 * If `fn` throws, nothing is written.
 */
export function mutateRecords<T>(fn: (records: EligibilityAssessmentRecord[]) => { value: T; write: boolean }): Promise<T> {
  return enqueue(async () => {
    const data = await readRecordsFile();
    const { value, write } = fn(data.records);
    if (write) await writeRecordsFile(data);
    return value;
  });
}

export const newRecordId = () => `elg_${crypto.randomUUID()}`;

/** 'LB-ELG-<n>': 1001 for the first record, then one above the highest existing n. */
export function nextReferenceCode(records: EligibilityAssessmentRecord[]): string {
  let highest = 1000;
  for (const r of records) {
    const m = /^LB-ELG-(\d+)$/.exec(r.referenceCode || '');
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `LB-ELG-${highest + 1}`;
}
