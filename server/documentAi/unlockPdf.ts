/**
 * Removes the password from a PDF so every reader in the pipeline (text layer, page rendering, OCR, the
 * model upload) can open it unchanged. qpdf runs as WebAssembly, so there is no native binary to install
 * on Render.
 *
 * The password is used for this one call only: it is never stored, never logged, and never part of an
 * error message. A wrong password and an engine failure return fixed codes, nothing from the file.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

export type UnlockResult = { ok: true; bytes: Buffer } | { ok: false; reason: 'wrong_password' | 'unsupported' | 'engine_failed' };

interface QpdfInstance {
  callMain: (args: string[]) => number;
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    unlink: (path: string) => void;
  };
}
type QpdfFactory = (options: Record<string, unknown>) => Promise<QpdfInstance>;

const require = createRequire(import.meta.url);
let wasmBinary: Buffer | null = null;
let factory: QpdfFactory | null = null;

function load(): { create: QpdfFactory; wasm: Buffer } {
  if (!factory || !wasmBinary) {
    const entry = require.resolve('@neslinesli93/qpdf-wasm');
    factory = require('@neslinesli93/qpdf-wasm') as QpdfFactory;
    wasmBinary = fs.readFileSync(entry.replace(/qpdf\.js$/, 'qpdf.wasm'));
  }
  return { create: factory, wasm: wasmBinary };
}

/** Longest password accepted (PDF allows 127 bytes for the older schemes, 127 UTF-8 bytes for AES-256). */
export const MAX_PDF_PASSWORD_LENGTH = 256;

export async function unlockPdf(bytes: Uint8Array, password: string): Promise<UnlockResult> {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PDF_PASSWORD_LENGTH) {
    return { ok: false, reason: 'wrong_password' };
  }
  let message = '';
  try {
    const { create, wasm } = load();
    // Each Emscripten instance adds process-wide 'uncaughtException' / 'unhandledRejection' handlers. Left in place they
    // pile up in a long-running server and change how it reports errors, so the ones this call adds are removed again.
    const exitCodeBefore = process.exitCode;
    const seen = {
      uncaughtException: new Set<unknown>(process.listeners('uncaughtException')),
      unhandledRejection: new Set<unknown>(process.listeners('unhandledRejection')),
    };
    const dropAddedListeners = () => {
      for (const l of process.listeners('uncaughtException')) if (!seen.uncaughtException.has(l)) process.removeListener('uncaughtException', l);
      for (const l of process.listeners('unhandledRejection')) if (!seen.unhandledRejection.has(l)) process.removeListener('unhandledRejection', l);
      // qpdf's exit status (2 for a wrong password) must not become the server process's exit code.
      process.exitCode = exitCodeBefore;
    };
    // A fresh instance per call: the module keeps its virtual file system and its memory between runs.
    const qpdf = await create({
      wasmBinary: wasm,
      noInitialRun: true,
      print: () => undefined,
      printErr: (line: string) => {
        message += `${line}\n`; // inspected below, never logged or returned
      },
    });
    let code: number;
    try {
      qpdf.FS.writeFile('/in.pdf', bytes);
      try {
        code = qpdf.callMain([`--password=${password}`, '--decrypt', '/in.pdf', '/out.pdf']);
      } catch (error) {
        code = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 99;
      }
    } finally {
      dropAddedListeners();
    }
    let out: Uint8Array | null = null;
    try {
      out = qpdf.FS.readFile('/out.pdf');
    } catch {
      out = null;
    }
    if (code <= 3 && code !== 2 && out && out.byteLength > 0) return { ok: true, bytes: Buffer.from(out) }; // 3 = warnings only
    // qpdf prints "invalid password" to the process's stderr in Node (not through printErr), so the exit code decides:
    // 2 = error. On a file that carries an /Encrypt entry the error is, in practice, the password.
    if (/not supported|unsupported|unknown encryption|security handler/i.test(message)) return { ok: false, reason: 'unsupported' };
    if (code === 2 && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes('/Encrypt')) return { ok: false, reason: 'wrong_password' };
    return { ok: false, reason: 'engine_failed' };
  } catch {
    return { ok: false, reason: 'engine_failed' };
  }
}
