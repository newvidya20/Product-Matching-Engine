/**
 * XLSX and CSV reading for Document AI. Uses JSZip directly, because the parser in
 * server/pdfExtractionService.ts is private and drops sheet names and cell references.
 * Throws on a corrupt file with JSZip's own text: pipeline.ts maps that to a code and drops it.
 */
import JSZip from 'jszip';
import { DOCUMENT_AI_LIMITS, type SpreadsheetPreview } from '../../src/types/documentAi.ts';

export interface SheetCell {
  /** 'B12' for XLSX, 'row:12' for CSV. */
  ref: string;
  /** 0-based. */
  column: number;
  text: string;
}

export interface SheetRow {
  /** 1-based, as the file numbers it. */
  rowNumber: number;
  cells: SheetCell[];
}

export interface ParsedSheet {
  name: string;
  hidden: boolean;
  rows: SheetRow[];
}

export interface ParsedSpreadsheet {
  kind: 'xlsx' | 'csv';
  sheets: ParsedSheet[];
}

/** Same ceiling as the existing extraction service. */
export const MAX_PROMPT_TEXT_CHARS = 180_000;

// ----------------------------------------------------------------- XML helpers

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function codePointToText(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
}

/** One pass, so `&amp;lt;` stays the literal text `&lt;`. */
function decodeXmlEntities(raw: string): string {
  return raw.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (_, hex, dec, named) => {
    if (hex) return codePointToText(parseInt(hex, 16));
    if (dec) return codePointToText(parseInt(dec, 10));
    return XML_ENTITIES[named];
  });
}

function readAttributes(attributeText: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of attributeText.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

/** Text runs of a shared string or inline string. Phonetic hints are not cell text. */
function readRichText(xml: string): string {
  const withoutPhonetics = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let text = '';
  for (const match of withoutPhonetics.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)) {
    text += decodeXmlEntities(match[1]);
  }
  return text;
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function columnLetters(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

// ------------------------------------------------------------------- Workbook

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormatCode(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dy]/i.test(stripped);
}

/** Style index to "this cell shows a date". */
function readDateStyles(stylesXml: string): boolean[] {
  const customDates = new Set<number>();
  for (const match of stylesXml.matchAll(/<(?:\w+:)?numFmt\b([^>]*?)\/?>/g)) {
    const attributes = readAttributes(match[1]);
    if (isDateFormatCode(attributes.formatCode ?? '')) customDates.add(Number(attributes.numFmtId));
  }
  const cellXfs = stylesXml.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/);
  if (!cellXfs) return [];
  return [...cellXfs[1].matchAll(/<(?:\w+:)?xf\b([^>]*?)\/?>/g)].map((match) => {
    const id = Number(readAttributes(match[1]).numFmtId ?? 0);
    return BUILTIN_DATE_FORMATS.has(id) || customDates.has(id);
  });
}

function serialToIsoDate(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const days = Math.floor(serial) + (date1904 ? 1462 : 0);
  return new Date(Date.UTC(1899, 11, 30) + days * 86_400_000).toISOString().slice(0, 10);
}

/** `1.25E7` and binary noise such as `1250000.0000000002` are not what the sheet displays. */
function formatNumericCell(raw: string): string {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? String(Number(parsed.toFixed(6))) : raw;
}

interface WorkbookContext {
  sharedStrings: string[];
  dateStyles: boolean[];
  date1904: boolean;
}

function readCellText(attributes: Record<string, string>, inner: string, ctx: WorkbookContext): string {
  const type = attributes.t ?? 'n';
  if (type === 'inlineStr') return readRichText(inner);
  const valueMatch = inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
  if (!valueMatch) return '';
  const raw = decodeXmlEntities(valueMatch[1]).trim();
  switch (type) {
    case 's':
      return ctx.sharedStrings[Number(raw)] ?? '';
    case 'str':
      return raw;
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    case 'e':
      return '';
    default:
      if (ctx.dateStyles[Number(attributes.s ?? -1)]) {
        const date = serialToIsoDate(Number(raw), ctx.date1904);
        if (date) return date;
      }
      return formatNumericCell(raw);
  }
}

function readSheetRows(xml: string, ctx: WorkbookContext): SheetRow[] {
  const rows: SheetRow[] = [];
  // Empty elements are self-closing. A `<c[\s>]...</c>` match would swallow the next cell.
  const rowPattern = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
  const cellPattern = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  let previousRow = 0;
  for (const rowMatch of xml.matchAll(rowPattern)) {
    const rowNumber = Number(readAttributes(rowMatch[1]).r) || previousRow + 1;
    previousRow = rowNumber;
    if (!rowMatch[2]) continue;
    const cells: SheetCell[] = [];
    let nextColumn = 0;
    for (const cellMatch of rowMatch[2].matchAll(cellPattern)) {
      const attributes = readAttributes(cellMatch[1]);
      const letters = attributes.r?.match(/^([A-Z]{1,3})\d+$/)?.[1];
      const column = letters ? columnIndex(letters) : nextColumn;
      nextColumn = column + 1;
      const text = cellMatch[2] ? readCellText(attributes, cellMatch[2], ctx).trim() : '';
      if (text) cells.push({ ref: `${columnLetters(column)}${rowNumber}`, column, text });
    }
    if (cells.length > 0) rows.push({ rowNumber, cells });
  }
  return rows;
}

function resolveSheetPath(target: string): string {
  return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
}

async function parseXlsx(bytes: Uint8Array): Promise<ParsedSpreadsheet> {
  const zip = await JSZip.loadAsync(bytes);
  const readPart = (name: string) => zip.file(name)?.async('string') ?? Promise.resolve('');

  const workbookXml = await readPart('xl/workbook.xml');
  const relationships = new Map<string, string>();
  for (const match of (await readPart('xl/_rels/workbook.xml.rels')).matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const attributes = readAttributes(match[1]);
    if (attributes.Id && attributes.Target) relationships.set(attributes.Id, attributes.Target);
  }

  const sharedStringsXml = await readPart('xl/sharedStrings.xml');
  const ctx: WorkbookContext = {
    sharedStrings: [...sharedStringsXml.matchAll(/<(?:\w+:)?si\b(?:[^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)].map(
      (match) => (match[1] ? readRichText(match[1]) : '')
    ),
    dateStyles: readDateStyles(await readPart('xl/styles.xml')),
    date1904: /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/.test(workbookXml),
  };

  const sheets: ParsedSheet[] = [];
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const attributes = readAttributes(match[1]);
    const target = relationships.get(attributes['r:id'] ?? '');
    if (!target) continue;
    const xml = await readPart(resolveSheetPath(target));
    sheets.push({
      name: attributes.name ?? 'Sheet',
      hidden: attributes.state === 'hidden' || attributes.state === 'veryHidden',
      rows: readSheetRows(xml, ctx),
    });
  }
  return { kind: 'xlsx', sheets };
}

// ------------------------------------------------------------------------ CSV

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((delimiter) => ({
    delimiter,
    count: firstLine.split(delimiter).length - 1,
  }));
  return counts.reduce((best, entry) => (entry.count > best.count ? entry : best)).delimiter;
}

function parseCsvRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  const endRecord = () => {
    record.push(field);
    records.push(record);
    record = [];
    field = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      endRecord();
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

function parseCsv(bytes: Uint8Array): ParsedSpreadsheet {
  // TextDecoder drops a leading BOM by default.
  const text = new TextDecoder('utf-8').decode(bytes);
  const rows: SheetRow[] = [];
  parseCsvRecords(text, detectDelimiter(text)).forEach((record, index) => {
    const rowNumber = index + 1;
    const cells = record
      .map((value, column) => ({ ref: `row:${rowNumber}`, column, text: value.trim() }))
      .filter((cell) => cell.text);
    if (cells.length > 0) rows.push({ rowNumber, cells });
  });
  return { kind: 'csv', sheets: [{ name: 'CSV', hidden: false, rows }] };
}

export async function parseSpreadsheet(bytes: Uint8Array, kind: 'xlsx' | 'csv'): Promise<ParsedSpreadsheet> {
  return kind === 'xlsx' ? parseXlsx(bytes) : parseCsv(bytes);
}

// ------------------------------------------------------------------ Rendering

function renderSheet(sheet: ParsedSheet, kind: 'xlsx' | 'csv'): string {
  const lines = sheet.rows.map((row) =>
    kind === 'csv'
      ? `row:${row.rowNumber} | ${row.cells.map((cell) => cell.text).join(' | ')}`
      : row.cells.map((cell) => `${cell.ref}: ${cell.text}`).join(' | ')
  );
  return kind === 'csv' ? lines.join('\n') : `[Sheet: ${sheet.name}]\n${lines.join('\n')}`;
}

export interface SpreadsheetText {
  /** Visible sheets only, capped. Hidden sheets feed nothing a reviewer cannot see on the page. */
  promptText: string;
  /** Every sheet, hidden included, uncapped. For the injection scan only. */
  scanText: string;
  visibleSheetNames: string[];
}

export function renderSpreadsheetText(parsed: ParsedSpreadsheet): SpreadsheetText {
  const visible = parsed.sheets.filter((sheet) => !sheet.hidden && sheet.rows.length > 0);
  return {
    promptText: visible
      .map((sheet) => renderSheet(sheet, parsed.kind))
      .join('\n\n')
      .slice(0, MAX_PROMPT_TEXT_CHARS),
    scanText: parsed.sheets.map((sheet) => renderSheet(sheet, parsed.kind)).join('\n\n'),
    visibleSheetNames: visible.map((sheet) => sheet.name),
  };
}

/** Rows and columns keep their real positions, so a cellRef from Review can be found by eye. */
export function buildSpreadsheetPreview(parsed: ParsedSpreadsheet): SpreadsheetPreview {
  const { previewMaxRows, previewMaxColumns } = DOCUMENT_AI_LIMITS;
  return {
    sheets: parsed.sheets.map((sheet) => {
      const lastRow = sheet.rows.at(-1)?.rowNumber ?? 0;
      const lastColumn = Math.max(-1, ...sheet.rows.flatMap((row) => row.cells.map((cell) => cell.column)));
      const width = Math.min(lastColumn + 1, previewMaxColumns);
      const rows = Array.from({ length: Math.min(lastRow, previewMaxRows) }, () =>
        new Array<string>(width).fill('')
      );
      for (const row of sheet.rows) {
        if (row.rowNumber > previewMaxRows) break;
        for (const cell of row.cells) {
          if (cell.column < width) rows[row.rowNumber - 1][cell.column] = cell.text;
        }
      }
      return {
        name: sheet.name,
        rows,
        truncated: lastRow > previewMaxRows || lastColumn + 1 > previewMaxColumns,
      };
    }),
  };
}
