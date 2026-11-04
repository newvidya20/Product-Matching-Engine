/**
 * Readers for the formats that are not PDFs, images or spreadsheets: Word (.docx) and plain text.
 * Also renders scanned PDF pages to PNG, so local OCR (ocr.ts) or a vision model can read a PDF that
 * has no text layer.
 */
import JSZip from 'jszip';
import { currentExtractionObserver } from './ocr.ts';
import { loadPdfjs } from './spreadsheet.ts';

/** A rendered scan is capped so one long file cannot exhaust memory or the model's input. */
export const MAX_RENDERED_PDF_PAGES = 10;
/** The preferred scale; renderScaleFor lowers it for large pages. */
const RENDER_SCALE = 2;

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16) || 32))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10) || 32));
}

/** Paragraphs and table rows become lines, table cells are separated by " | ". */
function wordXmlToLines(xml: string): string[] {
  const text = decodeXmlEntities(
    xml
      .replace(/<w:tab\s*\/>/gi, ' ')
      .replace(/<(w:br|w:cr)\s*\/?>/gi, '\n')
      .replace(/<\/w:tc>/gi, ' | ')
      .replace(/<\/(w:p|w:tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').replace(/(\s*\|\s*)+$/, '').trim())
    .filter(Boolean);
}

/** Body, headers and footers of a .docx, in reading order. Throws on a file that is not a Word document. */
export async function readDocxLines(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const targets = Object.keys(zip.files)
    .filter((name) => /^word\/(header\d*|document|footer\d*)\.xml$/i.test(name))
    .sort((a, b) => {
      const rank = (n: string) => (/header/i.test(n) ? 0 : /document/i.test(n) ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true });
    });
  if (!targets.some((name) => /document\.xml$/i.test(name))) throw new Error('not a Word document');
  const lines: string[] = [];
  for (const target of targets) lines.push(...wordXmlToLines(await zip.files[target].async('string')));
  return lines;
}

export function readPlainTextLines(bytes: Uint8Array): string[] {
  return new TextDecoder('utf-8')
    .decode(bytes)
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);
}

// ------------------------------------------------------------------ Rendering scanned PDF pages

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.min(max, Math.floor(value)) : fallback;
};

/**
 * Pixels per rendered page. A canvas holds 4 bytes a pixel, so 4 megapixels is about 16 MB, plus
 * the PNG. Without a cap a huge page at scale 2 can need hundreds of MB and kill a 512 MB instance.
 */
export const MAX_RENDER_PIXELS = envInt('DOCUMENT_AI_RENDER_MAX_PIXELS', 4_000_000, 250_000, 16_000_000);
/** Neither side of a canvas exceeds this, whatever the page's shape. */
const MAX_RENDER_SIDE = 8_000;
/** A page that takes longer than this to render is not waited for (Render free has a tenth of a CPU). */
export const RENDER_PAGE_TIMEOUT_MS = envInt('DOCUMENT_AI_RENDER_PAGE_TIMEOUT_MS', 60_000, 1_000, 300_000);
/** All pages of one document, not counting time queued for the renderer. */
export const RENDER_DOCUMENT_BUDGET_MS = envInt('DOCUMENT_AI_RENDER_DOCUMENT_BUDGET_MS', 150_000, 1_000, 600_000);
/** After a render is cancelled, how long to wait for it to stop before its canvas is freed. */
const CANCEL_SETTLE_MS = 2_000;

/**
 * The scale to render a page of `width` x `height` (PDF points, at scale 1): the preferred scale,
 * reduced so the canvas (each side rounded up) holds at most `maxPixels` pixels and neither side
 * exceeds MAX_RENDER_SIDE. Null for a page with no usable size.
 */
export function renderScaleFor(
  width: number,
  height: number,
  maxPixels: number = MAX_RENDER_PIXELS,
  preferredScale: number = RENDER_SCALE
): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (!(maxPixels >= 1) || !(preferredScale > 0)) return null;
  let scale = Math.min(
    preferredScale,
    Math.sqrt(maxPixels / (width * height)),
    MAX_RENDER_SIDE / width,
    MAX_RENDER_SIDE / height
  );
  const fits = (s: number) =>
    Math.ceil(width * s) * Math.ceil(height * s) <= maxPixels &&
    Math.ceil(width * s) <= MAX_RENDER_SIDE &&
    Math.ceil(height * s) <= MAX_RENDER_SIDE;
  // Rounding each side up can add a row and a column: step down until the canvas itself fits.
  for (let step = 0; step < 2_000 && scale > 0 && !fits(scale); step += 1) scale *= 0.995;
  return scale > 0 && Number.isFinite(scale) && fits(scale) ? scale : null;
}

const renderAbortError = () => new DOMException('Extraction was aborted.', 'AbortError');

/** One page renders at a time across the whole server, so parallel files cannot multiply canvas memory. */
let renderBusy = false;
const renderWaiting: Array<() => void> = [];

/** Takes the renderer, waiting in turn. Returns the time spent waiting. */
async function acquireRenderer(signal: AbortSignal): Promise<number> {
  if (signal.aborted) throw renderAbortError();
  if (!renderBusy) {
    renderBusy = true;
    return 0;
  }
  const started = Date.now();
  const observer = currentExtractionObserver();
  observer?.queueWaitStarted();
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = renderWaiting.indexOf(wake);
        if (index >= 0) renderWaiting.splice(index, 1);
        reject(renderAbortError());
      };
      // The renderer is handed over still marked busy, so nobody can take it in between.
      const wake = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      renderWaiting.push(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    observer?.queueWaitEnded();
  }
  return Date.now() - started;
}

function releaseRenderer(): void {
  const next = renderWaiting.shift();
  if (next) next();
  else renderBusy = false;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('render_timeout')), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

interface CanvasAndContext {
  canvas: { toBuffer(type: string): Buffer };
  context: unknown;
}
interface CanvasFactory {
  create(w: number, h: number): CanvasAndContext;
  destroy?(canvasAndContext: CanvasAndContext): void;
}

/**
 * Renders up to `maxPages` pages, from `firstPage` (1-based), as PNG bytes. Used for scans, which
 * have no text layer for the server to read: the images go to local OCR, or to a vision model as a
 * fallback. Image i is always page firstPage + i: rendering stops at the first page that fails or
 * times out, and returns the pages rendered before it ([] when none could be), so the caller fails
 * cleanly. A render that times out or is aborted is cancelled, and its canvas freed.
 */
export async function renderPdfPages(
  bytes: Uint8Array,
  signal: AbortSignal,
  maxPages: number = MAX_RENDERED_PDF_PAGES,
  firstPage = 1
): Promise<Buffer[]> {
  const pdfjs = await loadPdfjs(); // shared with the text reader: imported once per process
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 });
  const stop = () => void task.destroy().catch(() => undefined);
  signal.addEventListener('abort', stop, { once: true });
  const images: Buffer[] = [];
  try {
    const document = await withTimeout(task.promise, RENDER_PAGE_TIMEOUT_MS);
    const factory = (document as unknown as { canvasFactory: CanvasFactory }).canvasFactory;
    const start = Math.max(1, Math.floor(firstPage));
    const end = Math.min(document.numPages, start + Math.max(1, Math.floor(maxPages)) - 1);
    let deadline = Date.now() + RENDER_DOCUMENT_BUDGET_MS;
    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      if (signal.aborted) break;
      deadline += await acquireRenderer(signal); // time queued is not this document's work
      try {
        const timeoutMs = Math.min(RENDER_PAGE_TIMEOUT_MS, deadline - Date.now());
        if (timeoutMs <= 0) break;
        const image = await renderOnePage(document, pageNumber, factory, signal, timeoutMs);
        if (!image) break;
        images.push(image);
      } finally {
        releaseRenderer();
      }
    }
    return images;
  } catch {
    return images;
  } finally {
    signal.removeEventListener('abort', stop);
    await task.destroy().catch(() => undefined);
  }
}

type PdfDocument = Awaited<ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs').getDocument>['promise']>;

async function renderOnePage(
  document: PdfDocument,
  pageNumber: number,
  factory: CanvasFactory,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Buffer | null> {
  const started = Date.now();
  const page = await withTimeout(document.getPage(pageNumber), timeoutMs);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = renderScaleFor(base.width, base.height);
    if (scale === null) return null;
    const viewport = page.getViewport({ scale });
    const canvasAndContext = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    try {
      const render = page.render({
        canvasContext: canvasAndContext.context,
        viewport,
        canvas: canvasAndContext.canvas,
      } as unknown as Parameters<typeof page.render>[0]);
      const cancel = () => render.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await withTimeout(render.promise, timeoutMs - (Date.now() - started));
      } catch (error) {
        // Stop the work rather than leave it running: wait briefly for it to notice the cancel.
        render.cancel();
        await withTimeout(render.promise, CANCEL_SETTLE_MS).catch(() => undefined);
        throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
      return canvasAndContext.canvas.toBuffer('image/png');
    } finally {
      try {
        factory.destroy?.(canvasAndContext); // zero-sizes the canvas, freeing its pixels now
      } catch {
        // best effort
      }
    }
  } finally {
    page.cleanup();
  }
}

/** The rendered pages as base64, for a vision model. */
export async function renderPdfPagesToPng(bytes: Uint8Array, signal: AbortSignal): Promise<string[]> {
  return (await renderPdfPages(bytes, signal)).map((image) => image.toString('base64'));
}
