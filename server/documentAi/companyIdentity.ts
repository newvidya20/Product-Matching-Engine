/**
 * Company identity facts that are printed in a fixed, checkable form:
 * - the CIN (`U17299MH2010PLC208010`) carries the company class in its 3-letter ownership code
 *   (PLC public limited, PTC private limited, OPC one-person company) and the year of incorporation;
 * - an incorporation date written as `Incorporation Date 22/09/2010`, `Date of Incorporation: 22 Sep 2010`
 *   or `The Company was incorporated on September 22, 2010`.
 * Nothing is guessed: a value is returned only when the printed text states it.
 * Pure: no I/O, no clock, no logging.
 */
import type { RawField } from './prompt.ts';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;

const CIN = /\b([LU])(\d{5})([A-Z]{2})((?:19|20)\d{2})(PLC|PTC|OPC|GOI|NPL|FLC|FTC|GAP|ULL|ULT|SGC)(\d{6})\b/;

const ENTITY_BY_CODE: Record<string, { value: 'public_limited' | 'private_limited'; words: string }> = {
  PLC: { value: 'public_limited', words: 'public limited company' },
  PTC: { value: 'private_limited', words: 'private limited company' },
  OPC: { value: 'private_limited', words: 'private limited company (one person company)' },
};

const DATE_NUMERIC = String.raw`(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})`;
const DATE_DMY = String.raw`(\d{1,2})(?:st|nd|rd|th)?[\s-]+(${MONTH})\.?,?[\s-]+(\d{4})`;
const DATE_MDY = String.raw`(${MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})`;

const iso = (y: number, m: number, d: number): string | null =>
  y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : null;

const monthOf = (word: string): number => MONTHS[word.slice(0, 3).toLowerCase()];

/** First date written right after `lead` in `text`, as YYYY-MM-DD. */
function dateAfter(text: string, lead: RegExp): string | null {
  const m = lead.exec(text);
  if (!m) return null;
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
  const numeric = tail.match(new RegExp(String.raw`^\s*[:\-–]?\s*${DATE_NUMERIC}`));
  if (numeric) return iso(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  const dmy = tail.match(new RegExp(String.raw`^\s*[:\-–]?\s*${DATE_DMY}`, 'i'));
  if (dmy) return iso(Number(dmy[3]), monthOf(dmy[2]), Number(dmy[1]));
  const mdy = tail.match(new RegExp(String.raw`^\s*[:\-–]?\s*${DATE_MDY}`, 'i'));
  if (mdy) return iso(Number(mdy[3]), monthOf(mdy[1]), Number(mdy[2]));
  return null;
}

const DATE_LEADS: readonly RegExp[] = [
  /date\s+of\s+incorporation/i,
  /incorporation\s+date/i,
  /(?:company|firm|llp)\s+was\s+(?:incorporated|registered|formed)\s+on/i,
  /was\s+incorporated\s+on/i,
];

export function readCompanyIdentity(pages: ReadonlyArray<readonly string[]>, confidence: number): RawField[] {
  const out: RawField[] = [];
  const lines = pages.flatMap((page, index) => page.map((text) => ({ text: text.replace(/\s+/g, ' ').trim(), page: index + 1 })));
  const location = (page: number, snippet: string) => ({ page, sheetName: null, cellRef: null, snippet: snippet.slice(0, 300) });
  const blank = { statedUnit: null, unitText: null, period: null, subjectRef: null } as const;

  // Only the opening pages: a later CIN may belong to a holding company or subsidiary.
  for (const { text, page } of lines.filter((l) => l.page <= 3).slice(0, 400)) {
    const cin = text.match(CIN);
    if (!cin) continue;
    const entity = ENTITY_BY_CODE[cin[5]];
    if (entity) {
      out.push({
        fieldId: 'entityType',
        rawValue: entity.value,
        enumValue: entity.value,
        ...blank,
        ...location(page, `CIN ${cin[0]}: ownership code ${cin[5]} = ${entity.words}`),
        confidence,
        reconciled: true,
      });
    }
    break;
  }

  for (const { text, page } of lines.filter((l) => l.page <= 5)) {
    for (const lead of DATE_LEADS) {
      const date = dateAfter(text, lead);
      if (!date) continue;
      out.push({
        fieldId: 'identity.dateOfEstablishment',
        rawValue: date,
        enumValue: null,
        ...blank,
        ...location(page, text),
        confidence,
        reconciled: true,
      });
      return out;
    }
  }
  return out;
}
