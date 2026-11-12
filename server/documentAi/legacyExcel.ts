/**
 * Old Excel (.xls, BIFF8) files are converted to .xlsx at upload, so everything after that (validation,
 * storage, preview, readers) treats them as ordinary workbooks. Values only: formulas, macros and
 * links are dropped, and the size of what is read is capped.
 */
import * as XLSX from 'xlsx';

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];
const MAX_ROWS = 20000;

export function looksLikeLegacyXls(name: string, bytes: Uint8Array): boolean {
  // Any file called .xls: real BIFF (OLE) ones, and the very common "xls" that is really HTML, XML or an .xlsx.
  return /\.xls$/i.test(name);
}

/** Returns the file unchanged unless it is a real .xls; then the .xlsx equivalent, or null if unreadable. */
export function normalizeLegacyExcel(
  name: string,
  bytes: Buffer
): { name: string; bytes: Buffer } | null | 'unchanged' {
  if (!looksLikeLegacyXls(name, bytes)) return 'unchanged';
  try {
    // Must be a genuine OLE container with a workbook stream (its name is stored in UTF-16 in the directory).
    const isOle = OLE_MAGIC.every((v, i) => bytes[i] === v);
    if (isOle && !bytes.includes(Buffer.from('Workbook', 'utf16le')) && !bytes.includes(Buffer.from('Book', 'utf16le'))) return null;
    if (!isOle && bytes.subarray(0, 8192).includes(0) && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null; // binary junk
    const book = XLSX.read(bytes, { type: 'buffer', cellFormula: false, cellHTML: false, sheetRows: MAX_ROWS, bookVBA: false });
    if (!book.SheetNames.some((n) => book.Sheets[n]?.['!ref'])) return null;
    const out = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    return { name: name.replace(/\.xls$/i, '.xlsx'), bytes: out };
  } catch {
    return null;
  }
}
