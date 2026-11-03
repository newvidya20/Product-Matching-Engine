/**
 * Fictional fixtures for the formats added after the first set: Word, plain text, a scanned
 * (image-only) PDF and a ZIP holding all three. Every value is invented.
 * Regenerate with: node --import tsx tests/fixtures/generate-extra-fixtures.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const FIXED_DATE = new Date('2025-06-01T00:00:00Z');

const SANCTION_LINES = [
  'FICTIONAL SAMPLE - ILLUSTRATIVE DOCUMENT, NOT A REAL LOAN APPLICATION',
  'Loan Application Summary (FICTIONAL)',
  'Applicant: FICTIONAL SAMPLE TRADERS PRIVATE LIMITED',
  'Constitution: Private Limited Company',
  'Facility requested: Working capital term loan of Rs. 50,00,000',
  'Requested tenure: 36 months',
  'Purpose: Working capital for inventory',
];

const ITR_LINES = [
  'FICTIONAL SAMPLE - ILLUSTRATIVE DOCUMENT, NOT A REAL TAX RETURN',
  'Income Tax Return Acknowledgement (FICTIONAL)',
  'Name: FICTIONAL SAMPLE TRADERS PRIVATE LIMITED',
  'Assessment Year: 2025-26',
  'Gross total income: Rs. 32,20,000',
];

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function buildDocx(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const opts = { date: FIXED_DATE };
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    opts
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    opts
  );
  const body = lines.map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    opts
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A one-page PDF whose only content is a JPEG of the page: no text layer, like a scan. */
async function buildScannedPdf(lines: string[]): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const width = 1240;
  const height = 1754;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#111111';
  ctx.font = '34px sans-serif';
  lines.forEach((line, index) => ctx.fillText(line, 80, 140 + index * 64));
  const jpeg = canvas.toBuffer('image/jpeg');

  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
  const content = `q 595 0 0 842 0 0 cm /Im0 Do Q`;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
  add(
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        'latin1'
      ),
      jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ])
  );
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

const docx = await buildDocx(SANCTION_LINES);
const txt = Buffer.from(ITR_LINES.join('\n') + '\n', 'utf8');
const scan = await buildScannedPdf([
  'FICTIONAL SAMPLE - ILLUSTRATIVE SCAN, NOT A REAL DOCUMENT',
  'GST Annual Return Summary (FICTIONAL)',
  'Legal name: FICTIONAL SAMPLE TRADERS PRIVATE LIMITED',
  'Financial year: FY 2024-25',
  'Aggregate turnover as per return: Rs. 1,25,00,000.00',
]);

writeFileSync(DIR + 'FICTIONAL-loan-application.docx', docx);
writeFileSync(DIR + 'FICTIONAL-itr-acknowledgement.txt', txt);
writeFileSync(DIR + 'FICTIONAL-scanned-gst-return.pdf', scan);

const bundle = new JSZip();
bundle.file('borrower/FICTIONAL-loan-application.docx', docx, { date: FIXED_DATE });
bundle.file('borrower/FICTIONAL-itr-acknowledgement.txt', txt, { date: FIXED_DATE });
bundle.file('borrower/FICTIONAL-scanned-gst-return.pdf', scan, { date: FIXED_DATE });
bundle.file('__MACOSX/borrower/._FICTIONAL-loan-application.docx', 'junk', { date: FIXED_DATE });
bundle.file('borrower/notes.exe', 'not a document', { date: FIXED_DATE });
writeFileSync(DIR + 'FICTIONAL-borrower-documents.zip', await bundle.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('extra fixtures written');
