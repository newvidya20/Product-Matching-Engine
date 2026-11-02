/**
 * Generates the Document AI test fixtures in this folder.
 *
 * Every name, number and identifier is fictional. File names carry FICTIONAL, and the documents say so.
 * Output is deterministic (no clock, fixed zip timestamps), so re-running produces identical bytes.
 *
 * Run from the repository root:
 *   node --import tsx tests/fixtures/generate-fixtures.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { buildGstin } from '../helpers/documentAi.ts';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXED_DATE = new Date(0);

// ------------------------------------------------------------------ PDF

function pdfEscape(text: string): string {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new Error(`fixture text must be printable ASCII: ${text}`);
  }
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function contentStream(lines: string[]): string {
  const ops = ['BT', '/F1 10 Tf', '12 TL', '50 740 Td'];
  lines.forEach((line, index) => {
    ops.push(index === 0 ? `(${pdfEscape(line)}) Tj` : `T* (${pdfEscape(line)}) Tj`);
  });
  ops.push('ET');
  return ops.join('\n');
}

/** Hand-built single-font PDF with a correct cross-reference table. Text is plain, not compressed. */
function buildPdf(title: string, pages: string[][]): Buffer {
  const objects: Record<number, string> = {};
  const kids = pages.map((_, index) => `${5 + 2 * index} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [ ${kids} ] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[4] = `<< /Title (${pdfEscape(title)}) /Producer (FICTIONAL fixture generator) >>`;
  pages.forEach((lines, index) => {
    const pageNumber = 5 + 2 * index;
    const contentNumber = 6 + 2 * index;
    const stream = contentStream(lines);
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`;
    objects[contentNumber] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  const total = Object.keys(objects).length;
  let body = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  for (let n = 1; n <= total; n += 1) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n += 1) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// ------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function buildPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = y * stride + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type RGB
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A plain placeholder PAN card: coloured band, photo box, and text-like bars. No legible text.
 * The holder is FICTIONAL SAMPLE PERSON, PAN ABCPE1234F, which is not written into the image.
 */
function panCardPixel(x: number, y: number): [number, number, number] {
  const inRect = (x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
  if (!inRect(10, 10, 470, 290)) return [236, 242, 250]; // background outside the card
  if (inRect(10, 10, 470, 60)) return [25, 70, 140]; // header band
  if (inRect(30, 90, 150, 210)) return [190, 190, 190]; // photo box
  if (inRect(170, 90, 450, 110) || inRect(170, 130, 400, 150) || inRect(170, 170, 350, 190)) return [120, 120, 120];
  if (inRect(30, 240, 450, 262)) return [220, 235, 220]; // PAN field
  return [255, 255, 255];
}

// ------------------------------------------------------------------ XLSX

type Cell = string | number | null;

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnLetter(index: number): string {
  if (index > 25) throw new Error('fixture sheets use at most 26 columns');
  return String.fromCharCode(65 + index);
}

function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((cells, rowIndex) => {
      const cellXml = cells
        .map((value, columnIndex) => {
          const ref = `${columnLetter(columnIndex)}${rowIndex + 1}`;
          if (value === null) return '';
          if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cellXml}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

async function buildXlsx(sheets: Array<{ name: string; rows: Cell[][] }>): Promise<Buffer> {
  const zip = new JSZip();
  const sheetEntries = sheets
    .map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  const sheetOverrides = sheets
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ` +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    )
    .join('');
  const sheetRelationships = sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        `Target="worksheets/sheet${index + 1}.xml"/>`
    )
    .join('');

  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheetOverrides +
      '</Types>',
    { date: FIXED_DATE }
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      'Target="xl/workbook.xml"/>' +
      '</Relationships>',
    { date: FIXED_DATE }
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${sheetEntries}</sheets></workbook>`,
    { date: FIXED_DATE }
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheetRelationships +
      '</Relationships>',
    { date: FIXED_DATE }
  );
  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows), { date: FIXED_DATE });
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ------------------------------------------------------------------ Content

const COMPANY_PAN = 'AFCCT1234Z';
const COMPANY_GSTIN = buildGstin('27', COMPANY_PAN);

const GST_RETURN_LINES = [
  'FICTIONAL SAMPLE - ILLUSTRATIVE DOCUMENT, NOT A REAL GST RETURN',
  '',
  'GST Annual Return Summary (FICTIONAL)',
  'Legal name: FICTIONAL SAMPLE TRADERS PRIVATE LIMITED',
  `GSTIN: ${COMPANY_GSTIN}`,
  'Financial year: FY 2024-25',
  'Filing period: 01 April 2024 to 31 March 2025',
  'Aggregate turnover as per return: Rs. 1,25,00,000.00',
  'Taxable value of outward supplies: Rs. 1,18,40,000.00',
  'Tax paid in cash (IGST + CGST + SGST): Rs. 21,31,200.00',
  'Return status: Filed',
  'Date of GST registration: 01/07/2019',
];

const BANK_STATEMENT_LINES = [
  'FICTIONAL SAMPLE BANK - ILLUSTRATIVE STATEMENT, NOT A REAL BANK',
  '',
  'Account holder: FICTIONAL SAMPLE TRADERS PRIVATE LIMITED',
  'Account number: XXXXXX4321',
  'Statement period: 01-05-2025 to 31-05-2025',
  'Opening balance: 2,35,000.00 Cr',
  '',
  'Date        Narration                          Debit           Credit          Balance',
  '02-05-2025  NEFT CR FICTIONAL CLIENT A                         85,000.00 Cr    3,20,000.00 Cr',
  '09-05-2025  CHQ DEP FICTIONAL CLIENT B                         40,000.00 Cr    3,60,000.00 Cr',
  '14-05-2025  UPI DR FICTIONAL SUPPLIER X        1,25,000.00 Dr                  2,35,000.00 Cr',
  '22-05-2025  NEFT CR FICTIONAL CLIENT C                        1,15,000.00 Cr   3,50,000.00 Cr',
  '28-05-2025  EMI DR FICTIONAL LENDER            1,55,000.00 Dr                  1,95,000.00 Cr',
  '',
  'Total credits: 2,40,000.00 Cr',
  'Total debits: 2,80,000.00 Dr',
  'Closing balance: 1,95,000.00 Cr',
];

const BALANCE_SHEET_ROWS: Cell[][] = [
  ['FICTIONAL SAMPLE TRADERS PRIVATE LIMITED - Balance sheet (illustrative, INR)'],
  [],
  ['Particulars', 'As at 31-Mar-2025'],
  ['Total assets', 48000000],
  ['Current assets', 31000000],
  ['Total outside liabilities', 29000000],
  ['Current liabilities', 12000000],
  ['Tangible net worth', 19000000],
  ["Shareholders' equity", 19000000],
];

const PROFIT_AND_LOSS_ROWS: Cell[][] = [
  ['FICTIONAL SAMPLE TRADERS PRIVATE LIMITED - Profit and loss (illustrative, INR)'],
  [],
  ['Particulars', 'FY 2024-25', 'FY 2023-24'],
  ['Revenue from operations', 125000000, 100000000],
  ['EBITDA', 14000000, 11000000],
  ['Depreciation', -4500000, -4000000],
  ['Interest expense', -6000000, -5000000],
  ['Tax expense', -280000, -150000],
  ['Profit after tax', 3220000, 1850000],
];

// ------------------------------------------------------------------ Main

async function main(): Promise<void> {
  const outputs: Array<[string, Buffer]> = [
    ['FICTIONAL-gst-return-fy2024-25.pdf', buildPdf('FICTIONAL GST return summary', [GST_RETURN_LINES])],
    ['FICTIONAL-bank-statement-may-2025.pdf', buildPdf('FICTIONAL bank statement', [BANK_STATEMENT_LINES])],
    [
      'FICTIONAL-balance-sheet-fy2024-25.xlsx',
      await buildXlsx([
        { name: 'Balance Sheet', rows: BALANCE_SHEET_ROWS },
        { name: 'Profit and Loss', rows: PROFIT_AND_LOSS_ROWS },
      ]),
    ],
    ['FICTIONAL-pan-card.png', buildPng(480, 300, panCardPixel)],
  ];

  for (const [name, bytes] of outputs) {
    writeFileSync(join(OUT_DIR, name), bytes);
    process.stdout.write(`wrote ${name} (${bytes.length} bytes)\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`fixture generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
