/**
 * Upload validation (docs/contracts.md section 7.3). Kind comes from magic bytes only.
 */
import JSZip from 'jszip';
import { DOCUMENT_AI_LIMITS } from '../../src/types/documentAi.ts';
import type { AcceptedFileKind } from '../../src/types/documentAi.ts';

export type FileValidation =
  | { ok: true; kind: AcceptedFileKind }
  | { ok: false; status: 415; code: 'unsupported_type' | 'type_mismatch'; message: string };

const EXTENSIONS: Record<string, AcceptedFileKind> = {
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
  xlsx: 'xlsx',
  csv: 'csv',
};

const fail = (code: 'unsupported_type' | 'type_mismatch', message: string): FileValidation => ({
  ok: false,
  status: 415,
  code,
  message,
});

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false;
  return sig.every((v, i) => b[offset + i] === v);
}

function hasPdfHeader(b: Uint8Array): boolean {
  const limit = Math.min(b.length, 1024 + 5);
  for (let i = 0; i + 5 <= limit; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return true;
  }
  return false;
}

function isCsv(b: Uint8Array): boolean {
  const head = b.subarray(0, 64 * 1024);
  if (head.includes(0)) return false;
  try {
    // fatal: true throws on invalid UTF-8. A multi-byte char cut at the 64 KB edge is tolerated by stream mode.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Inflates one entry, counting real bytes. Resolves the count, or null as soon as `budget` is exceeded. */
function inflatedSize(entry: JSZip.JSZipObject, budget: number): Promise<number | null> {
  return new Promise((resolve) => {
    let total = 0;
    let settled = false;
    const stream = entry.nodeStream('nodebuffer');
    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > budget) {
        stream.pause();
        stream.removeAllListeners('data');
        (stream as unknown as { destroy?: () => void }).destroy?.();
        done(null);
      }
    });
    stream.on('end', () => done(total));
    stream.on('error', () => done(null));
  });
}

async function isSafeXlsx(b: Uint8Array): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(b);
    if (!zip.file('[Content_Types].xml') || !zip.file('xl/workbook.xml')) return false;
    // Declared sizes are attacker-controlled, so the cap is enforced on bytes actually inflated.
    let remaining = DOCUMENT_AI_LIMITS.maxXlsxUncompressedBytes;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const size = await inflatedSize(entry, remaining);
      if (size === null) return false;
      remaining -= size;
    }
    return true;
  } catch {
    return false;
  }
}

export async function validateUpload(fileName: string, bytes: Uint8Array): Promise<FileValidation> {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';

  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    return fail('unsupported_type', 'Older Excel (.xls) and encrypted Office files are not supported. Please save as .xlsx and upload again.');
  }
  const expected = EXTENSIONS[ext];
  if (!expected) {
    return fail('unsupported_type', 'This file type is not supported. Upload PDF, XLSX, CSV, PNG, JPG or WEBP.');
  }

  let detected: AcceptedFileKind | null = null;
  if (hasPdfHeader(bytes)) detected = 'pdf';
  else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) detected = 'png';
  else if (startsWith(bytes, [0xff, 0xd8, 0xff])) detected = 'jpeg';
  else if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) detected = 'webp';
  else if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) detected = 'xlsx';
  else if (expected === 'csv' && isCsv(bytes)) detected = 'csv';

  if (detected !== expected) {
    return fail('type_mismatch', 'The file contents do not match its extension.');
  }
  if (detected === 'xlsx' && !(await isSafeXlsx(bytes))) {
    return fail('unsupported_type', 'This is not a valid .xlsx workbook, or it is too large when unpacked.');
  }
  return { ok: true, kind: detected };
}
