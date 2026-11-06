/**
 * Credit bureau report reader (CIBIL consumer report, CIBIL commercial / company report), with no AI.
 *
 * Never-guess rules: a value is reported only when its label and figure are literally on the page.
 * A company report that says `No Rank Generated` gives no CMR rank. A consumer report belongs to a
 * person, so its score carries that person's name as subjectRef and its PAN is never read as the
 * company's. Pure: no I/O, no clock, no logging.
 */
import type { RawField } from './prompt.ts';

// ------------------------------------------------------------------ Fake-bold print-outs

/** A token (or its fused tail) that is one string written exactly four times: `712712712712`. */
const FOUR_TIMES = /(\S{2,}?)\1{3}/g;

function isGenuineRepeat(unit: string): boolean {
  if (/^\d+$/.test(unit)) return unit.length >= 3 && !/^(\d)\1+$/.test(unit);
  return /[A-Za-z]/.test(unit);
}

function collapseLine(line: string): string {
  // Whole line written four times, with spaces inside the unit.
  if (line.length >= 8 && line.length % 4 === 0) {
    const unit = line.slice(0, line.length / 4);
    if (unit.repeat(4) === line && isGenuineRepeat(unit.trim())) return unit.trim();
  }
  return line.replace(FOUR_TIMES, (match, unit: string) => (isGenuineRepeat(unit) ? unit : match));
}

/**
 * Some browsers print a bold word four times over (`CIBIL Score` -> `CIBIL ScoreCIBIL Score...`,
 * `712` -> `712712712712`). Applied only when the pattern is plainly present (5 or more hits in the
 * first pages), so a genuine figure is never collapsed in an ordinary document.
 */
export function collapseRepeatedGlyphs(pages: ReadonlyArray<readonly string[]>): string[][] {
  let hits = 0;
  for (const page of pages.slice(0, 3)) {
    for (const line of page) if (collapseLine(line) !== line) hits += 1;
  }
  if (hits < 5) return pages.map((page) => [...page]);
  return pages.map((page) => page.map((line) => collapseLine(line).replace(/\s+/g, ' ').trim()));
}

// ------------------------------------------------------------------ Helpers

const SNIPPET_MAX = 300;
type Located = { text: string; page: number };

function raw(
  fieldId: string,
  rawValue: string,
  line: Located,
  confidence: number,
  extra: Partial<RawField> = {}
): RawField {
  return {
    fieldId,
    rawValue,
    enumValue: null,
    page: line.page,
    sheetName: null,
    cellRef: null,
    snippet: line.text.slice(0, SNIPPET_MAX),
    confidence,
    statedUnit: null,
    unitText: null,
    period: null,
    subjectRef: null,
    ...extra,
  };
}

const PAN = /\b([A-Z]{5}\d{4}[A-Z])\b/;

// ------------------------------------------------------------------ Consumer report

function readConsumer(lines: Located[], confidence: number): RawField[] {
  const fields: RawField[] = [];
  const nameLine = lines.slice(0, 40).find((l) => /^hello,?\s+/i.test(l.text));
  const name = nameLine?.text.replace(/^hello,?\s+/i, '').replace(/\s+(?:mrs?|ms|miss|shri|smt)\.?$/i, '').trim() ?? null;
  const subjectRef = name && /[A-Za-z]{2}/.test(name) && name.length <= 80 ? name : null;

  const scoreLine = lines.slice(0, 40).find((l) => /your\s+cibil\s+score\s+is\s+\d{3}\b/i.test(l.text));
  if (scoreLine) {
    const m = scoreLine.text.match(/score\s+is\s+(\d{3})\b/i);
    const score = m ? Number(m[1]) : NaN;
    if (score >= 300 && score <= 900) {
      fields.push(raw('financialProfile.personalCibilScore', String(score), scoreLine, confidence, { subjectRef }));
    }
    const d = scoreLine.text.match(/as\s+of\s+date\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (d) fields.push(raw('financialProfile.personalCreditReportDate', d[1], scoreLine, confidence, { subjectRef }));
  }

  // Overdue: only stated per-account `Amount Overdue` figures; any positive one is reported.
  let overdueTotal = 0;
  let overdueAccounts = 0;
  let first: Located | null = null;
  for (const l of lines) {
    const m = l.text.match(/^amount\s+overdue\s+₹\s*([\d,]+)\s*$/i);
    if (!m) continue;
    const v = Number(m[1].replace(/,/g, ''));
    if (v > 0) {
      overdueTotal += v;
      overdueAccounts += 1;
      first ??= l;
    }
  }
  if (first && overdueTotal > 0) {
    fields.push(
      raw(
        'financialProfile.delinquencies',
        `Amount overdue reported on ${overdueAccounts} account(s), total ${overdueTotal.toLocaleString('en-IN')} rupees`,
        first,
        confidence,
        { subjectRef, reconciled: true }
      )
    );
  }
  return fields;
}

// ------------------------------------------------------------------ Commercial report

function readCommercial(lines: Located[], confidence: number): RawField[] {
  const fields: RawField[] = [];
  const head = lines.slice(0, 400);

  const titleLine = head.find((l) => /\|\s*report\s+order\s+number/i.test(l.text));
  const company = titleLine?.text.split('|')[0].trim();
  if (titleLine && company && company.length >= 3 && company.length <= 120) {
    fields.push(raw('applicantLabel', company, titleLine, confidence));
  }

  const panIdx = head.findIndex((l) => /^pan\s+number$/i.test(l.text));
  const panLine = panIdx >= 0 ? head.slice(panIdx, panIdx + 4).find((l) => /^[A-Z]{5}\d{4}[A-Z]$/.test(l.text)) : undefined;
  if (panLine) fields.push(raw('identity.pan', panLine.text.match(PAN)![1], panLine, confidence));

  // The company profile prints `DATE OF INCORPORATION` as a label and the date on the line below.
  const doiLabel = head.findIndex((l) => /date\s+of\s+incorporation/i.test(l.text));
  const doiLine = doiLabel >= 0 ? head.slice(doiLabel, doiLabel + 4).find((l) => /\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}/.test(l.text)) : undefined;
  const doi = doiLine?.text.match(/(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})/);
  if (doiLine && doi) fields.push(raw('identity.dateOfEstablishment', doi[1], doiLine, confidence));

  // CMR rank: only a printed 1-10 rank. `No Rank Generated` leaves it missing.
  const rankIdx = lines.findIndex((l) => /^your\s+cibil\s+rank$/i.test(l.text));
  if (rankIdx >= 0) {
    const window = lines.slice(rankIdx + 1, rankIdx + 6);
    const noRank = window.some((l) => /no\s+rank\s+generated/i.test(l.text));
    const numeric = window.find((l) => /^(?:10|[1-9])$/.test(l.text));
    if (!noRank && numeric) fields.push(raw('financialProfile.commercialCmrRank', numeric.text, numeric, confidence));
  }

  const exposure = lines.slice(0, 200).find((l) => /entity\s+exposure\s*:\s*₹\s*[\d.,]+\s*(?:cr|lac|lakh)/i.test(l.text));
  const ex = exposure?.text.match(/entity\s+exposure\s*:\s*₹\s*([\d.,]+)\s*(cr|lac|lakh)/i);
  if (exposure && ex) {
    const unit = /^cr/i.test(ex[2]) ? 'crore' : 'lakh';
    fields.push(
      raw('financialProfile.existingCorporateBorrowingExposure', ex[1].replace(/,/g, ''), exposure, confidence, {
        statedUnit: unit,
        unitText: ex[2],
      })
    );
  }

  const dishonoured = head.find((l) => /^\d+\s+dishonou?red\s+cheques?$/i.test(l.text));
  if (dishonoured) {
    fields.push(raw('financialProfile.delinquencies', `${dishonoured.text} reported`, dishonoured, confidence));
  }

  // A company credit report in hand is the evidence the enum asks for.
  const statusLine = head.find((l) => /company\s+credit\s+report/i.test(l.text));
  if (statusLine) {
    fields.push(raw('financialProfile.commercialCreditReportStatus', 'available', statusLine, confidence, { enumValue: 'available' }));
  }
  return fields;
}

// ------------------------------------------------------------------ Entry point

export function readCreditReport(
  pages: ReadonlyArray<readonly string[]>,
  confidence: number
): { fields: RawField[]; kind: 'cibil_consumer' | 'cmr_commercial' | null } {
  const collapsed = collapseRepeatedGlyphs(pages);
  const lines: Located[] = collapsed.flatMap((page, index) =>
    page.map((text) => ({ text: text.replace(/\s+/g, ' ').trim(), page: index + 1 })).filter((l) => l.text)
  );
  const head = lines.slice(0, 120).map((l) => l.text).join('\n');
  if (/company\s+credit\s+report|report\s+order\s+number/i.test(head) && /cibil\s+rank/i.test(head)) {
    return { fields: readCommercial(lines, confidence), kind: 'cmr_commercial' };
  }
  if (/your\s+cibil\s+score\s+is\s+\d{3}/i.test(head)) {
    return { fields: readConsumer(lines, confidence), kind: 'cibil_consumer' };
  }
  return { fields: [], kind: null };
}
