/**
 * FICTIONAL GSTR-3B and ITR-V documents that mimic the portal's printed layout, built in memory for
 * tests. No real return, name, GSTIN, PAN or ARN is used: every value here is invented, and the
 * GSTINs come from fictional PANs with a computed check character.
 *
 * Nothing is written to disk by default. Run from the repository root to write sample files:
 *   node --import tsx tests/fixtures/generate-gstr3b-fixtures.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGstin } from '../helpers/documentAi.ts';

export const FICTIONAL_PAN = 'AAACZ9999Q';
export const FICTIONAL_GSTIN = buildGstin('27', FICTIONAL_PAN);
export const OTHER_FICTIONAL_GSTIN = buildGstin('24', 'AAFCY8888K');

export interface Gstr3bSpec {
  /** `2025-26` */
  year: string;
  /** `April`, or a quarter such as `Apr-Jun`. */
  period: string;
  /** Table 3.1 total taxable values as printed; null leaves the row out. */
  a: string | null;
  b: string | null;
  c: string | null;
  d?: string;
  e?: string | null;
  gstin?: string;
  /** Print row (a)'s label on two lines, figures on the first (the portal's usual wrap). */
  wrapA?: 'figures_first' | 'figures_second';
}

/** The text lines of a GSTR-3B in the portal's layout, page by page. */
export function gstr3bLines(spec: Gstr3bSpec): string[][] {
  const rows: string[] = [];
  if (spec.a !== null) {
    if (spec.wrapA === 'figures_second') {
      rows.push('(a) Outward taxable supplies (other than zero rated, nil rated and', `exempted) ${spec.a} 1800.00 900.00 900.00 0.00`);
    } else {
      rows.push(`(a) Outward taxable supplies (other than zero rated, nil rated ${spec.a} 1800.00 900.00 900.00 0.00`, 'and exempted)');
    }
  }
  if (spec.b !== null) rows.push(`(b) Outward taxable supplies (zero rated) ${spec.b} 0.00 - - 0.00`);
  if (spec.c !== null) rows.push(`(c ) Other outward supplies (nil rated, exempted) ${spec.c} - - - -`);
  rows.push(`(d) Inward supplies (liable to reverse charge) ${spec.d ?? '5000.00'} 900.00 0.00 0.00 0.00`);
  if (spec.e !== null) rows.push(`(e) Non-GST outward supplies ${spec.e ?? '0.00'} - - - -`);
  return [
    [
      'Form GSTR-3B',
      '[See rule 61(5)]',
      `Year ${spec.year}`,
      `Period ${spec.period}`,
      `GSTIN of the supplier ${spec.gstin ?? FICTIONAL_GSTIN}`,
      '2(a). Legal name of the registered person FICTIONAL ZETA TEXTILES PRIVATE LIMITED',
      '2(b). Trade name, if any FICTIONAL ZETA TEXTILES',
      '2(c). ARN AA000000000000F',
      '(Amount in Rs. for all tables)',
      '3.1 Details of Outward supplies and inward supplies liable to reverse charge',
      'Nature of Supplies Total taxable Integrated Central tax State/UT Cess',
      'value tax tax',
      ...rows,
      '3.1.1 Details of Supplies notified under section 9(5) of the CGST Act',
      '(i) Taxable supplies on which electronic commerce operator pays tax 0.00 0.00 0.00 0.00 0.00',
      'FILED',
    ],
    ['4. Eligible ITC', 'C. Net ITC available (A-B) 1200.00 600.00 600.00 0.00', '6.1 Payment of tax', 'FILED'],
  ];
}

/** An ITR-V in the e-filing layout. */
export function itrAcknowledgementLines(): string[][] {
  return [
    [
      'Acknowledgement Number:000000000000000 Date of filing : 01-Oct-2025',
      'INDIAN INCOME TAX RETURN ACKNOWLEDGEMENT',
      'Assessment Year',
      '2025-26',
      `PAN ${FICTIONAL_PAN}`,
      'Name FICTIONAL ZETA TEXTILES PRIVATE LIMITED',
      'Status 7-Private company Form Number ITR-6',
      'Total Income 1 12,34,000',
      'Net tax payable 4 3,10,000',
    ],
  ];
}

function pdfEscape(text: string): string {
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error(`fixture text must be printable ASCII: ${text}`);
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Hand-built single-font PDF, one text line per row, with a correct cross-reference table. */
export function buildTextPdf(pages: string[][]): Buffer {
  const objects: Record<number, string> = {};
  const kids = pages.map((_, index) => `${4 + 2 * index} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [ ${kids} ] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, index) => {
    const ops = ['BT', '/F1 9 Tf', '12 TL', '30 760 Td'];
    lines.forEach((line, i) => ops.push(i === 0 ? `(${pdfEscape(line)}) Tj` : `T* (${pdfEscape(line)}) Tj`));
    ops.push('ET');
    const stream = ops.join('\n');
    objects[4 + 2 * index] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * index} 0 R >>`;
    objects[5 + 2 * index] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  const total = Object.keys(objects).length;
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n <= total; n += 1) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n += 1) body += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export const MONTHS_OF_FY = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = dirname(fileURLToPath(import.meta.url));
  writeFileSync(
    join(out, 'FICTIONAL-gstr3b-april-2025.pdf'),
    buildTextPdf(gstr3bLines({ year: '2025-26', period: 'April', a: '100000.00', b: '0.00', c: '2500.50' }))
  );
}
