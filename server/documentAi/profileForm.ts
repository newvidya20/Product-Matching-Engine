/**
 * Reader for a borrower intake profile: the app's own form printed as `Label | Value` rows
 * (`Annual Revenue (INR)  96000000`, `Legal Entity Structure  Private Limited Company`). Labels are
 * the form's own labels, so each row maps straight to its field. A label may wrap onto a second line
 * (`Average Debtor / Receivable Cycle` / `(Days)` / `60`) and a value may run over several lines.
 * Nothing is guessed: an enum is set only when the value text names exactly one option.
 * Pure: no I/O, no clock, no logging.
 */
import { DIRECT_FIELDS, getFieldDefinition, type FieldDefinition } from '../../src/documentAi/fieldMap.ts';
import type { RawField } from './prompt.ts';

/** Labels the printed form uses for a field that the field map labels differently. */
const ALIASES: ReadonlyArray<{ label: string; fieldId: string }> = [
  { label: 'Existing Monthly EMI', fieldId: 'financialProfile.existingMonthlyEmi' },
  { label: "Shareholders' Equity", fieldId: 'financialProfile.shareholdersEquity' },
  // The form's GST row is the source of the GST compliance status (the form field mirrors it).
  { label: 'GST / Tax Registration Compliant', fieldId: 'financialProfile.gstComplianceStatus' },
  // The printed DSCR is shown for review only (the app computes its own).
  { label: 'Debt Service Coverage (DSCR)', fieldId: 'review.statedDscr' },
  // A bureau score of unstated kind: its own candidate, never merged into Personal CIBIL.
  // Skipped (the label only ends the row before it) while the field map has no such field.
  { label: 'Credit Bureau Score (CIBIL / Commercial)', fieldId: 'review.bureauScore' },
];

const STOP_LABELS = [
  'Internal Employee Notes',
  'Assigned LoanBazaar Employee',
  'Branch / Advisory Desk',
  'Label as Fictional Demo Record',
  'Debt Service Coverage (DSCR)',
  'Credit Bureau Score (CIBIL / Commercial)',
  'Annual Turnover / Income',
  'Profitability Track Record',
  'GST / Tax Registration Compliant',
];

const norm = (text: string) => text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Entry {
  /** Null for a label the form prints but never takes from a document (it only ends the row before it). */
  definition: FieldDefinition | null;
  label: string;
  pattern: RegExp;
}

function buildEntries(): Entry[] {
  const out: Entry[] = [];
  const add = (definition: FieldDefinition | null, label: string) => {
    // Words may be split over lines; a unit suffix like (INR) may follow the label.
    const words = norm(label).split(' ').map(esc).join(String.raw`\s+`);
    out.push({
      definition,
      label,
      pattern: new RegExp(String.raw`^\s*${words}(?:\s*\(\s*INR\s*\))?\s*(?::|\s|$)`, 'i'),
    });
  };
  const byId = new Map(DIRECT_FIELDS.map((d) => [d.fieldId, d]));
  for (const definition of DIRECT_FIELDS) add(definition, definition.label);
  for (const alias of ALIASES) {
    const definition = byId.get(alias.fieldId);
    if (definition) add(definition, alias.label);
  }
  for (const label of STOP_LABELS) add(null, label);
  // Longest label first, so a long label is not taken for a shorter one that starts it.
  return out.sort((a, b) => b.label.length - a.label.length);
}

let ENTRIES: Entry[] | null = null;

interface Row {
  entry: Entry;
  /** Index of the label's first line. */
  start: number;
  /** Index of the first line after the label, and the text on the label's own line after it. */
  lineIndex: number;
  inline: string;
  page: number;
}

/** Matches a label starting at line `i`, which may continue on the next lines. */
function matchAt(
  entry: Entry,
  lines: ReadonlyArray<{ text: string }>,
  i: number
): { used: number; rest: string } | null {
  for (let take = 1; take <= 3 && i + take <= lines.length; take += 1) {
    const joined = lines
      .slice(i, i + take)
      .map((l) => l.text)
      .join('\n');
    const match = entry.pattern.exec(joined);
    if (!match) continue;
    // A longer take only counts when the label really runs over onto its last line.
    if (take > 1 && !match[0].includes('\n')) continue;
    const rest = joined.slice(match[0].length).replace(/^\s*:?\s*/, '');
    return { used: take, rest: rest.replace(/\n/g, ' ').trim() };
  }
  return null;
}

const MONEY = /^-?\d[\d,]*(?:\.\d+)?$/;

function pickEnum(definition: FieldDefinition, text: string): string | null {
  const value = norm(text).toLowerCase();
  if (!value) return null;
  const options = definition.allowedValues;
  const exact = options.filter((o) => o.toLowerCase() === value || o.toLowerCase().replace(/_/g, ' ') === value);
  if (exact.length === 1) return exact[0];
  const hits = new Set<string>();
  for (const option of options) {
    const phrases = definition.enumEvidence?.[option]?.any ?? [];
    const spelled = option.replace(/_/g, ' ').toLowerCase();
    const named = value.includes(spelled) || phrases.some((p) => value.includes(p.toLowerCase()));
    const blocked = (definition.enumEvidence?.[option]?.none ?? []).some((p) => value.includes(p.toLowerCase()));
    if (named && !blocked) hits.add(option);
  }
  if (hits.size === 1) return [...hits][0];
  // `compliant` also sits inside `not compliant`: keep the longer one when both are named.
  if (hits.size === 2) {
    const [a, b] = [...hits].sort((x, y) => y.length - x.length);
    if (a.replace(/_/g, ' ').includes(b.replace(/_/g, ' '))) return a;
  }
  // Yes / No style fields.
  if (options.includes('yes') && options.includes('no')) {
    if (/^(?:yes|available|collateral available)\b/.test(value)) return 'yes';
    if (/^(?:no|not available|none)\b/.test(value)) return 'no';
  }
  return null;
}

export function readProfileForm(pages: ReadonlyArray<readonly string[]>, confidence: number): RawField[] {
  ENTRIES ??= buildEntries();
  const entries = ENTRIES;
  const lines = pages.flatMap((page, pageIndex) =>
    page.map((text) => ({ text: text.replace(/\s+/g, ' ').trim(), page: pageIndex + 1 })).filter((l) => l.text)
  );

  // Find the rows: at each line, the first (longest) label that matches.
  const rows: Row[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const entry of entries) {
      const hit = matchAt(entry, lines, i);
      if (!hit) continue;
      rows.push({ entry, start: i, lineIndex: i + hit.used, inline: hit.rest, page: lines[i].page });
      i += hit.used - 1;
      break;
    }
  }
  // A profile prints many of the form's labels; a document mentioning one or two is not one.
  if (rows.length < 5) return [];

  const out: RawField[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const { definition } = row.entry;
    if (!definition || seen.has(definition.fieldId)) return;
    const nextRowStart = rows[index + 1]?.start ?? lines.length; // where the next label begins
    // The value: on the label's line, else the following line(s) up to the next label.
    let valueText = row.inline;
    const quoted: string[] = [lines[row.lineIndex - 1]?.text ?? ''];
    if (!valueText) {
      const following: string[] = [];
      for (let j = row.lineIndex; j < Math.min(nextRowStart, row.lineIndex + 4, lines.length); j += 1) {
        if (/^\(.*\)$/.test(lines[j].text)) continue; // a wrapped unit such as (Days)
        following.push(lines[j].text);
        quoted.push(lines[j].text);
        if (definition.valueType !== 'string') break;
      }
      valueText = following.join(' ').trim();
    } else if (definition.valueType === 'string') {
      // A long text value wraps onto the lines before the next label.
      for (let j = row.lineIndex; j < Math.min(nextRowStart, row.lineIndex + 3, lines.length); j += 1) {
        valueText = `${valueText} ${lines[j].text}`;
        quoted.push(lines[j].text);
      }
    }
    valueText = norm(valueText);
    if (!valueText || /^[-–—]$/.test(valueText)) return;
    const base = {
      page: row.page,
      sheetName: null,
      cellRef: null,
      snippet: norm(`${row.entry.label} ${valueText}`).slice(0, 300),
      confidence,
      statedUnit: null,
      unitText: null,
      period: null,
      subjectRef: null,
    };
    if (definition.valueType === 'number') {
      const figure = valueText.replace(/\s*\/-$/, '').replace(/^(?:rs\.?|inr|₹)\s*/i, '');
      if (!MONEY.test(figure)) return;
      seen.add(definition.fieldId);
      out.push({ ...base, fieldId: definition.fieldId, rawValue: figure, enumValue: null });
    } else if (definition.valueType === 'enum') {
      const option = pickEnum(definition, valueText);
      if (!option) return;
      seen.add(definition.fieldId);
      out.push({ ...base, fieldId: definition.fieldId, rawValue: valueText, enumValue: option });
    } else {
      let text = valueText;
      if (definition.fieldId === 'financialProfile.financialYearLabel') text = text.replace(/\s*\([^)]*\)\s*$/, '');
      if (text.length < 2 || text.length > 400) return;
      seen.add(definition.fieldId);
      out.push({ ...base, fieldId: definition.fieldId, rawValue: text, enumValue: null });
    }
  });
  // The profile states its own financial year: its yearly figures belong to that year.
  const year = out.find((f) => f.fieldId === 'financialProfile.financialYearLabel')?.rawValue ?? null;
  if (year) {
    for (const field of out) {
      if (field.fieldId !== 'financialProfile.financialYearLabel' && getFieldDefinition(field.fieldId)?.periodScoped) {
        field.period = year;
      }
    }
  }
  return out;
}
