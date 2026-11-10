/**
 * Reader for the LoanBazaar "Business Credit Triangulation Report" (INTEGRATED CREDIT ANALYSIS).
 * It has a real text layer and prints, in fixed sections: the company snapshot (name, PAN, GSTIN),
 * a three-column yearly financial table (FY2024 / FY2025 / FY2026), GST turnover per financial year,
 * each promoter's CIBIL score, and the monthly EMI used for debt service.
 *
 * Never-guess rules:
 *  - only values printed plainly are read; `N/A` is absent (never 0), so CMR stays absent;
 *  - every yearly value carries its own period (FYyyyy = the year ending 31 March yyyy, so FY2025 is
 *    `FY 2024-25`), and the latest column is held below the auto-apply threshold because the report's
 *    newest year is provisional / unaudited: a person confirms it;
 *  - each promoter's score is its own candidate, subjectRef = the person's name; the headline
 *    "lowest of 3" figure is never emitted and scores are never averaged;
 *  - `Depreciation & Amortisation` is one combined figure, so it is NOT put in the depreciation field;
 *  - GST turnover is emitted only for a year with all 12 months covered (a 10/12 year is part-year);
 *  - the report's own DSCR and TOL/TNW are emitted as review-only STATED values, never computed.
 * Pure: no I/O, no clock, no logging.
 */
import type { RawField } from './prompt.ts';

const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();

/** One narrow detector: the report's title plus its Section 1 heading. */
export function isTriangulationReport(text: string): boolean {
  const head = text.slice(0, 20000);
  return (
    /business\s+credit\s+triangulation\s+report|integrated\s+credit\s+analysis/i.test(head.slice(0, 3000)) &&
    /section\s*1\s+company\s*&\s*credit\s+snapshot/i.test(head)
  );
}

/** Held below the 0.7 auto-apply threshold: the newest year is provisional, so a person confirms it. */
export const PROVISIONAL_CONFIDENCE = 0.65;

interface Line {
  text: string;
  page: number;
}

const AMOUNT = String.raw`(?:₹\s?-?[\d,]+(?:\.\d+)?|N\/A)`;
const AMOUNT_RE = new RegExp(AMOUNT, 'g');

/** The YEAR table's rows: label pattern (anchored) -> field. Depreciation & Amortisation is deliberately absent. */
const YEARLY_ROWS: ReadonlyArray<{ label: RegExp; fieldId: string }> = [
  { label: /^Revenue\s*\/\s*Turnover\b/i, fieldId: 'financialProfile.annualRevenue' },
  { label: /^EBITDA\b/i, fieldId: 'financialProfile.ebitda' },
  { label: /^EBIT\b(?!DA)/i, fieldId: 'financialProfile.ebit' },
  { label: /^Net\s+Profit\s*\/\s*PAT\b/i, fieldId: 'financialProfile.netProfitAfterTax' },
  { label: /^Interest\s*\/\s*Finance\s+Cost\b/i, fieldId: 'financialProfile.interestExpense' },
  { label: /^Net\s+Worth\b/i, fieldId: 'financialProfile.shareholdersEquity' },
  { label: /^Tangible\s+Net\s+Worth\b/i, fieldId: 'financialProfile.tangibleNetWorth' },
  { label: /^Total\s+Debt\b/i, fieldId: 'financialProfile.totalOutstandingBorrowings' },
  { label: /^Current\s+Assets\b/i, fieldId: 'financialProfile.currentAssets' },
  { label: /^Current\s+Liabilities\b/i, fieldId: 'financialProfile.currentLiabilities' },
  { label: /^Total\s+Outside\s+Liabilities\b/i, fieldId: 'financialProfile.totalOutsideLiabilities' },
];

const fyLabel = (endYear: number) => `FY ${endYear - 1}-${String(endYear % 100).padStart(2, '0')}`;

export function readTriangulationReport(pages: ReadonlyArray<readonly string[]>, confidence: number): RawField[] {
  const lines: Line[] = pages.flatMap((page, index) =>
    page.map((text) => ({ text: clean(text), page: index + 1 })).filter((l) => l.text)
  );
  const full = lines.map((l) => l.text).join('\n');
  if (!isTriangulationReport(full)) return [];

  const out: RawField[] = [];
  const base = { sheetName: null, cellRef: null, enumValue: null, statedUnit: null, unitText: null } as const;
  const add = (
    fieldId: string,
    rawValue: string,
    where: { page: number },
    snippet: string,
    extra: { period?: string | null; subjectRef?: string | null; confidence?: number } = {}
  ) => {
    out.push({
      ...base,
      fieldId,
      rawValue,
      page: where.page,
      snippet: clean(snippet).slice(0, 300),
      confidence: extra.confidence ?? confidence,
      period: extra.period ?? null,
      subjectRef: extra.subjectRef ?? null,
    });
  };
  const indexOf = (re: RegExp, from = 0, to = lines.length) => {
    for (let i = from; i < to; i += 1) if (re.test(lines[i].text)) return i;
    return -1;
  };

  // ---- Section 1: identity ----
  const s1 = indexOf(/^SECTION\s*1$/i);
  const s2 = indexOf(/^SECTION\s*[2-9]\b/i, s1 + 1);
  if (s1 >= 0) {
    const end = s2 > s1 ? s2 : Math.min(lines.length, s1 + 60);
    const valueAfter = (label: RegExp, value: RegExp): { text: string; line: Line } | null => {
      const at = indexOf(label, s1, end);
      if (at < 0) return null;
      for (let j = at + 1; j < Math.min(end, at + 4); j += 1) {
        if (/^Source:/i.test(lines[j].text)) continue;
        const m = lines[j].text.match(value);
        return m ? { text: m[1], line: lines[j] } : null;
      }
      return null;
    };
    const name = valueAfter(/^Company Name$/i, /^(.{3,150}?)\s+AVAILABLE$/);
    if (name) add('applicantLabel', name.text, name.line, `Company Name ${name.line.text}`);
    const pan = valueAfter(/^PAN$/i, /^([A-Z]{5}\d{4}[A-Z])\s+AVAILABLE$/);
    if (pan) add('identity.pan', pan.text, pan.line, `PAN ${pan.line.text}`);
    // Recorded as printed: the GSTIN checksum is checked by validation, never corrected here.
    const gstin = valueAfter(/^GSTIN$/i, /^([0-9]{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3})\s+AVAILABLE$/);
    if (gstin) add('identity.gstin', gstin.text, gstin.line, `GSTIN ${gstin.line.text}`);
  }

  // ---- The report's own stated ratios (policy table): review only, "provisional" as printed ----
  const stated = (label: RegExp, fieldId: string) => {
    for (const l of lines) {
      const m = l.text.match(label);
      if (m) return add(fieldId, m[1], l, l.text);
    }
  };
  stated(/^TOL\s*\/\s*TNW\s+Ratio\b.*?(\d+(?:\.\d+)?x\s*\(provisional\))/i, 'review.statedTolTnw');
  stated(/^DSCR\b.*?(\d+(?:\.\d+)?x\s*\(provisional\))/i, 'review.statedDscr');

  // ---- Section 3: the yearly table ----
  const s3 = indexOf(/^SECTION\s*3$/i);
  if (s3 >= 0) {
    const s4 = indexOf(/^SECTION\s*[4-9]\b/i, s3 + 1);
    const end = s4 > s3 ? s4 : lines.length;
    let years: number[] = [];
    for (let i = s3; i < end; i += 1) {
      if (/^Financial Metric\b/i.test(lines[i].text)) {
        const header = lines.slice(i, i + 3).map((l) => l.text).join(' ');
        const found = [...header.matchAll(/\bFY\s?(\d{4})\b/g)].map((m) => Number(m[1]));
        if (found.length >= 2) years = found;
        continue;
      }
      if (years.length === 0) continue;
      const row = YEARLY_ROWS.find((r) => r.label.test(lines[i].text));
      if (!row) continue;
      // Values on the label's line; a wrapped row continues on lines that hold only values.
      let text = lines[i].text;
      for (let j = i + 1; j < Math.min(end, i + 4) && (text.match(AMOUNT_RE)?.length ?? 0) < years.length; j += 1) {
        if (!new RegExp(`^(?:${AMOUNT}\\s*)+$`).test(lines[j].text)) break;
        text = `${text} ${lines[j].text}`;
      }
      const cells = text.match(AMOUNT_RE) ?? [];
      if (cells.length !== years.length) continue;
      cells.forEach((cell, column) => {
        if (/^N\/A$/.test(cell)) return; // not stated: stays absent, never 0
        const figure = cell.replace(/^₹\s?/, '');
        const latest = column === years.length - 1;
        add(row.fieldId, figure, lines[i], text, {
          period: fyLabel(years[column]),
          confidence: latest ? Math.min(confidence, PROVISIONAL_CONFIDENCE) : confidence,
        });
      });
    }
  }

  // ---- Section 4: GST turnover per financial year (only a fully covered year) ----
  const gstFrom = indexOf(/^GST Turnover by Financial Year\b/i);
  if (gstFrom >= 0) {
    for (let i = gstFrom; i < Math.min(lines.length, gstFrom + 14); i += 1) {
      const m = lines[i].text.match(/^FY\s?(\d{4})-(\d{2})\s+(\d+)\/(\d+)\s+\d+\/\d+\s+₹\s?([\d,]+(?:\.\d+)?)/i);
      if (!m || m[3] !== '12' || m[4] !== '12') continue;
      add('financialProfile.gstAnnualTurnover', m[5], lines[i], lines[i].text, { period: `FY ${m[1]}-${m[2]}` });
    }
  }

  // ---- Section 6: each promoter's own CIBIL score ----
  const names: string[] = [];
  const scoreAt = indexOf(/^Cibil Score\s+\d{3}(?:\s+\d{3})*$/i);
  const eachAt = indexOf(/^CIBIL Score of Each Promoter/i);
  if (eachAt >= 0 && scoreAt > eachAt) {
    const block = lines.slice(eachAt + 1, scoreAt).map((l) => l.text).join(' ');
    for (const m of block.matchAll(/([A-Z][A-Z .'-]*?[A-Z])\s*-\s*\d{2}-\d{2}-\d{4}\.pdf/g)) names.push(clean(m[1]));
    const scores = [...lines[scoreAt].text.matchAll(/\b(\d{3})\b/g)].map((m) => m[1]);
    if (names.length > 0 && names.length === scores.length) {
      scores.forEach((score, i) => {
        const value = Number(score);
        if (value < 300 || value > 900) return;
        add(
          'financialProfile.personalCibilScore',
          score,
          lines[scoreAt],
          `CIBIL Score of Each Promoter: ${names[i]} Cibil Score ${score}`,
          { subjectRef: names[i] }
        );
      });
    }
  }

  // ---- Monthly EMI used for debt service ----
  const emiAt = indexOf(/^Monthly EMI used for debt service$/i);
  if (emiAt >= 0) {
    for (let j = emiAt + 1; j < Math.min(lines.length, emiAt + 4); j += 1) {
      const m = lines[j].text.match(/^₹\s?([\d,]+(?:\.\d+)?)\s+AVAILABLE$/i);
      if (m) {
        add('financialProfile.existingMonthlyEmi', m[1], lines[j], `Monthly EMI used for debt service ${lines[j].text}`);
        break;
      }
    }
  }
  return out;
}
