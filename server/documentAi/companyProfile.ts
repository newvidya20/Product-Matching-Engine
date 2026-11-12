/**
 * Reader for a narrative company profile / corporate presentation (Word or PDF).
 * It states "Sales for the last 3 Financial Years" followed by "Financial Year 21 - 22" and "105 Crore" lines.
 * Never-guess rules: only a year label directly followed by an amount WITH its unit (Crore / Lakh / Cr / Lacs /
 * a rupee amount) is read; the year is the one printed (21-22, 2021-22, FY 2021-22 all mean FY 2021-22) and a
 * label with no amount after it is skipped. These are the company's own sales claims, not audited figures, so
 * they are held below the auto-apply threshold and a person confirms them. Pure: no I/O, no clock.
 */
import type { RawField } from './prompt.ts';

export const CLAIM_CONFIDENCE = 0.6;
// Table cells of a Word file arrive as "| 105 Crore |"; the pipes are layout, not content.
const clean = (text: string) => text.normalize('NFKC').replace(/^\s*\|+|\|+\s*$/g, '').replace(/\s+/g, ' ').trim();

const YEAR_LABEL = /^(?:financial\s+year|f\.?\s?y\.?|year)\s*:?\s*(?:20)?(\d{2})\s*[-–—\/]\s*(?:20)?(\d{2})$/i;
const AMOUNT_WITH_UNIT = /^(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)\s*(crores?|cr\.?|lakhs?|lacs?|lac)\b\.?$/i;

export function readCompanyProfile(pages: ReadonlyArray<readonly string[]>, confidence: number): RawField[] {
  const lines: Array<{ text: string; page: number }> = [];
  pages.forEach((page, index) => {
    for (const raw of page) {
      const text = clean(raw);
      if (text) lines.push({ text, page: index + 1 });
    }
  });
  // Only a profile that talks about sales / turnover by year.
  if (!lines.some((l) => /\b(?:sales|turn\s?over|revenue)\b/i.test(l.text) && /financial\s+years?|F\.?Y\.?/i.test(l.text))) return [];

  const out: RawField[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length - 1; i += 1) {
    const label = YEAR_LABEL.exec(lines[i].text);
    if (!label) continue;
    const start = Number(label[1]);
    const end = Number(label[2]);
    if (end !== (start + 1) % 100) continue; // "21 - 22" yes, "21 - 25" no
    const amount = AMOUNT_WITH_UNIT.exec(lines[i + 1].text);
    if (!amount) continue;
    const period = `FY 20${String(start).padStart(2, '0')}-${String(end).padStart(2, '0')}`;
    if (seen.has(period)) continue; // two different statements of one year are not guessed between
    seen.add(period);
    out.push({
      fieldId: 'financialProfile.annualRevenue',
      rawValue: `${amount[1]} ${amount[2].toLowerCase().startsWith('l') ? 'lakh' : 'crore'}`,
      enumValue: null,
      statedUnit: null,
      unitText: null,
      confidence: Math.min(confidence, CLAIM_CONFIDENCE),
      period,
      subjectRef: null,
      page: lines[i].page,
      sheetName: null,
      cellRef: null,
      snippet: `${lines[i].text} ${lines[i + 1].text}`.slice(0, 300),
    });
  }
  return out;
}
