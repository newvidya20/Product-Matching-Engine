/**
 * Readers for the formats that are not PDFs, images or spreadsheets: Word (.docx) and plain text.
 * Also renders scanned PDF pages to PNG, so a vision model can read a PDF that has no text layer.
 */
import JSZip from 'jszip';

/** A rendered scan is capped so one long file cannot exhaust memory or the model's input. */
export const MAX_RENDERED_PDF_PAGES = 10;
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

/**
 * Renders up to MAX_RENDERED_PDF_PAGES pages as PNG (base64). Used for scans, which have no text layer
 * for the server to read. Returns [] when rendering is not possible, so the caller fails cleanly.
 */
export async function renderPdfPagesToPng(bytes: Uint8Array, signal: AbortSignal): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 });
  const stop = () => void task.destroy().catch(() => undefined);
  signal.addEventListener('abort', stop, { once: true });
  try {
    const document = await task.promise;
    const factory = (document as unknown as {
      canvasFactory: { create(w: number, h: number): { canvas: { toBuffer(type: string): Buffer }; context: unknown } };
    }).canvasFactory;
    const images: string[] = [];
    const pageCount = Math.min(document.numPages, MAX_RENDERED_PDF_PAGES);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      if (signal.aborted) break;
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: context, viewport, canvas } as unknown as Parameters<typeof page.render>[0])
        .promise;
      images.push(canvas.toBuffer('image/png').toString('base64'));
      page.cleanup();
    }
    return images;
  } catch {
    return [];
  } finally {
    signal.removeEventListener('abort', stop);
    await task.destroy().catch(() => undefined);
  }
}
