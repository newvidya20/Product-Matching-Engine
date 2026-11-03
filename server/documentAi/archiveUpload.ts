/**
 * Large uploads. The request body is streamed straight to a temp file (never held in memory), and a
 * ZIP is then read from that file one entry at a time, so a multi-GB archive fits in a small instance.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Request } from 'express';
import yauzl from 'yauzl';
import { DOCUMENT_AI_LIMITS } from '../../src/types/documentAi.ts';
import { getRoot } from './store.ts';

/** Whole upload (a ZIP or a single file). DOCUMENT_AI_MAX_UPLOAD_MB overrides it. */
export function maxUploadBytes(): number {
  const mb = Number(process.env.DOCUMENT_AI_MAX_UPLOAD_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DOCUMENT_AI_LIMITS.maxUploadBytes / (1024 * 1024)) * 1024 * 1024;
}

export class UploadTooLargeError extends Error {
  constructor() {
    super('upload too large');
    this.name = 'UploadTooLargeError';
  }
}

/** Streams the request body to a new temp file, stopping as soon as it passes `limit` bytes. */
export async function receiveToTempFile(req: Request, limit: number): Promise<{ filePath: string; bytes: number }> {
  const dir = path.join(getRoot(), 'tmp');
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `upload-${crypto.randomUUID()}`);
  const out = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
  let bytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        req.unpipe(out);
        req.resume();
        out.destroy();
        reject(error);
      };
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) fail(new UploadTooLargeError());
      });
      req.on('aborted', () => fail(new Error('client aborted')));
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => resolve());
      req.pipe(out);
    });
    return { filePath, bytes };
  } catch (error) {
    await fsp.rm(filePath, { force: true });
    throw error;
  }
}

/** Folder noise that is never a document: macOS resource forks, hidden files, thumbnails. */
const JUNK_ENTRY = /(^|\/)(__MACOSX|\.[^/]*|Thumbs\.db|desktop\.ini)(\/|$)/i;

export interface ZipFileEntry {
  name: string;
  bytes: Buffer;
}

export type ZipEntryOutcome = { skipped: string } | void;

/**
 * Calls `onEntry` for each file in the ZIP at `filePath`, one at a time, in archive order. Folders are
 * flattened; junk, nested ZIPs and files over the per-file limit are reported through `onSkip`. Entry
 * bytes are counted as they inflate, so a declared size cannot hide a ZIP bomb.
 */
export function forEachZipEntry(
  filePath: string,
  onEntry: (entry: ZipFileEntry) => Promise<void>,
  onSkip: (fileName: string, reason: string) => void
): Promise<{ files: number }> {
  const perFileLimit = DOCUMENT_AI_LIMITS.maxFileBytes;
  const maxEntries = DOCUMENT_AI_LIMITS.maxFilesPerSession;
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(new Error('This ZIP file could not be opened. It may be damaged or password protected.'));
        return;
      }
      let files = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        if (error) reject(error);
        else resolve({ files });
      };
      zip.on('error', () => finish(new Error('This ZIP file is damaged and could not be read completely.')));
      zip.on('end', () => finish());
      zip.on('entry', (entry: yauzl.Entry) => {
        const fullName = entry.fileName;
        const name = fullName.split('/').pop() || fullName;
        const next = () => zip.readEntry();
        if (/\/$/.test(fullName) || JUNK_ENTRY.test(fullName)) return next();
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          onSkip(name, 'This file is password protected inside the ZIP.');
          return next();
        }
        if (/\.zip$/i.test(name)) {
          onSkip(name, 'ZIP files inside a ZIP are not unpacked. Upload it separately.');
          return next();
        }
        if (files >= maxEntries) {
          onSkip(name, `Only the first ${maxEntries} files are read for one assessment.`);
          return next();
        }
        if (entry.uncompressedSize > perFileLimit) {
          onSkip(name, `Larger than the ${perFileLimit / (1024 * 1024)} MB limit for one document.`);
          return next();
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            onSkip(name, 'This file could not be unpacked.');
            return next();
          }
          const chunks: Buffer[] = [];
          let total = 0;
          let tooBig = false;
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > perFileLimit) {
              tooBig = true;
              stream.destroy();
              return;
            }
            chunks.push(chunk);
          });
          const done = () => {
            if (tooBig) {
              onSkip(name, `Larger than the ${perFileLimit / (1024 * 1024)} MB limit for one document.`);
              return next();
            }
            files += 1;
            onEntry({ name, bytes: Buffer.concat(chunks) }).then(next, (error: Error) => finish(error));
          };
          stream.on('end', done);
          stream.on('close', () => {
            if (tooBig) done();
          });
          stream.on('error', () => {
            if (tooBig) return;
            onSkip(name, 'This file could not be unpacked.');
            next();
          });
        });
      });
      zip.readEntry();
    });
  });
}
