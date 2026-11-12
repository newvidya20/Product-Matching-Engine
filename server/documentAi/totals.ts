import type {
  BankMonthlyTotal,
  DocumentExtractionResult,
  GstReturnPeriodTotal,
} from '../../src/types/documentAi.ts';
import type { BankAccountTotal, GstYearTotal, SessionTotals } from '../../src/types/totals.ts';

/** All sums are done in whole paise (integers) so repeated additions never drift. */
const toPaise = (n: number): number => Math.round(n * 100);
const fromPaise = (p: number): number => p / 100;

const isMonth = (m: unknown): m is string => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let m = first; m <= last && out.length < 600; m = nextMonth(m)) out.push(m);
  return out;
}

function debitsOf(row: BankMonthlyTotal): number | null {
  const d = (row as { totalDebits?: number | null }).totalDebits;
  return typeof d === 'number' && Number.isFinite(d) ? d : null;
}

interface AccountBucket {
  label: string;
  rows: BankMonthlyTotal[];
}

function summarizeBank(
  results: DocumentExtractionResult[],
  notes: string[]
): SessionTotals['bank'] {
  const buckets = new Map<string, AccountBucket>();
  for (const r of results) {
    if (!r.ok) continue;
    for (const row of r.bankMonthlyTotals ?? []) {
      if (!isMonth(row.month)) continue;
      const ref = row.subjectRef?.trim();
      const file = row.source?.fileName?.trim();
      const key = ref ? `ref:${ref}` : `doc:${r.documentId}`;
      let b = buckets.get(key);
      if (!b) {
        b = { label: ref || file || '', rows: [] };
        buckets.set(key, b);
      }
      b.rows.push(row);
    }
  }

  const accounts: BankAccountTotal[] = [];
  const countedSets: Set<string>[] = [];
  let n = 0;
  for (const b of buckets.values()) {
    n += 1;
    const label = b.label || `Account ${n}`;
    const byMonth = new Map<string, BankMonthlyTotal[]>();
    for (const row of b.rows) {
      const list = byMonth.get(row.month) ?? [];
      list.push(row);
      byMonth.set(row.month, list);
    }
    const seen = [...byMonth.keys()].sort();
    const counted: Array<{ month: string; credits: number; debits: number | null }> = [];
    const partialOnly: string[] = [];
    const conflicting: string[] = [];
    for (const month of seen) {
      const rows = byMonth.get(month)!;
      const full = rows.filter((r) => !r.partial && typeof r.totalCredits === 'number' && Number.isFinite(r.totalCredits));
      if (full.length === 0) {
        if (rows.some((r) => r.partial)) partialOnly.push(month);
        continue;
      }
      const credits = new Set(full.map((r) => toPaise(r.totalCredits as number)));
      if (credits.size > 1) {
        conflicting.push(month);
        continue;
      }
      const debitSet = new Set(full.map(debitsOf).filter((d): d is number => d !== null).map(toPaise));
      const debits = debitSet.size === 1 ? fromPaise([...debitSet][0]) : null;
      counted.push({ month, credits: fromPaise([...credits][0]), debits });
    }
    if (partialOnly.length) {
      notes.push(`${label}: ${partialOnly.join(', ')} ${partialOnly.length === 1 ? 'is' : 'are'} from a cut-off (partial) statement and not counted.`);
    }
    if (conflicting.length) {
      notes.push(`${label}: ${conflicting.join(', ')} ${conflicting.length === 1 ? 'is' : 'are'} read differently in two files, so not counted. Check the files.`);
    }
    const countedMonths = counted.map((c) => c.month);
    const first = seen[0] ?? null;
    const last = seen[seen.length - 1] ?? null;
    const missing = first && last ? monthsBetween(first, last).filter((m) => !countedMonths.includes(m)) : [];
    const creditsP = counted.reduce((s, c) => s + toPaise(c.credits), 0);
    const allDebits = counted.length > 0 && counted.every((c) => c.debits !== null);
    const debitsP = allDebits ? counted.reduce((s, c) => s + toPaise(c.debits as number), 0) : null;
    if (counted.length > 0 && !allDebits && counted.some((c) => c.debits !== null)) {
      notes.push(`${label}: debits were not read for every month, so no debit total is shown.`);
    }
    if (counted.length === 0) continue;
    accounts.push({
      label,
      monthsCovered: counted.length,
      firstMonth: countedMonths[0],
      lastMonth: countedMonths[countedMonths.length - 1],
      totalCredits: fromPaise(creditsP),
      totalDebits: debitsP === null ? null : fromPaise(debitsP),
      averageMonthlyCredits: fromPaise(Math.round(creditsP / counted.length)),
      missingMonths: missing,
    });
    countedSets.push(new Set(countedMonths));
  }

  if (accounts.length === 0) return { accounts: [], allAccounts: null };

  const unlabeled = [...buckets.keys()].filter((k) => k.startsWith('doc:')).length;
  if (accounts.length > 1 && unlabeled > 0) {
    const union = new Set<string>();
    let overlap = false;
    for (const s of countedSets) {
      for (const m of s) {
        if (union.has(m)) overlap = true;
        union.add(m);
      }
    }
    if (overlap) {
      notes.push('Some files have no account number and cover the same months. If they are one account, the "All accounts" total counts those months twice.');
    }
  }

  const unionMonths = new Set<string>();
  for (const s of countedSets) for (const m of s) unionMonths.add(m);
  const credP = accounts.reduce((s, a) => s + toPaise(a.totalCredits), 0);
  const debNull = accounts.some((a) => a.totalDebits === null);
  const debP = debNull ? null : accounts.reduce((s, a) => s + toPaise(a.totalDebits as number), 0);
  const sameMonths = countedSets.every((s) => s.size === countedSets[0].size && [...s].every((m) => countedSets[0].has(m)));
  return {
    accounts,
    allAccounts: {
      totalCredits: fromPaise(credP),
      totalDebits: debP === null ? null : fromPaise(debP),
      months: unionMonths.size,
      averageMonthlyCredits: sameMonths && unionMonths.size > 0 ? fromPaise(Math.round(credP / unionMonths.size)) : null,
    },
  };
}

function summarizeGst(results: DocumentExtractionResult[], notes: string[]): GstYearTotal[] {
  const groups = new Map<string, { fy: string; gstin: string | null; periods: GstReturnPeriodTotal[] }>();
  for (const r of results) {
    if (!r.ok) continue;
    for (const p of r.gstReturnPeriods ?? []) {
      const months = (p.months ?? []).filter(isMonth);
      if (months.length === 0 || !p.financialYear) continue;
      const key = `${p.gstin ?? ''}|${p.financialYear}`;
      const g = groups.get(key) ?? { fy: p.financialYear, gstin: p.gstin ?? null, periods: [] };
      g.periods.push({ ...p, months });
      groups.set(key, g);
    }
  }
  const out: GstYearTotal[] = [];
  for (const g of groups.values()) {
    const tag = `GST ${g.fy}${g.gstin ? ` (${g.gstin})` : ''}`;
    const kept: GstReturnPeriodTotal[] = [];
    const used = new Set<string>();
    const dropped = new Set<string>();
    for (const p of g.periods) {
      const overlapping = kept.filter((k) => k.months.some((m) => p.months.includes(m)));
      if (overlapping.length === 0) {
        kept.push(p);
        p.months.forEach((m) => used.add(m));
        continue;
      }
      const same = overlapping.length === 1 && overlapping[0].months.length === p.months.length &&
        overlapping[0].months.every((m) => p.months.includes(m));
      const equal = same &&
        toPaise(overlapping[0].outwardTaxable) === toPaise(p.outwardTaxable) &&
        toPaise(overlapping[0].zeroRated) === toPaise(p.zeroRated) &&
        toPaise(overlapping[0].nilExempt) === toPaise(p.nilExempt);
      if (!equal) {
        for (const m of p.months) dropped.add(m);
      }
    }
    if (dropped.size) {
      notes.push(`${tag}: ${[...dropped].sort().join(', ')} appear in more than one return with different figures, so the later return was not added. Check the files.`);
    }
    if (kept.length === 0) continue;
    const months = [...used].sort();
    const sum = (f: (p: GstReturnPeriodTotal) => number) => fromPaise(kept.reduce((s, p) => s + toPaise(f(p)), 0));
    const outwardTaxable = sum((p) => p.outwardTaxable);
    const zeroRated = sum((p) => p.zeroRated);
    const nilExempt = sum((p) => p.nilExempt);
    const total = fromPaise(toPaise(outwardTaxable) + toPaise(zeroRated) + toPaise(nilExempt));
    const partYear = months.length < 12;
    if (partYear) notes.push(`${tag}: only ${months.length} of 12 months were read, so this is a part-year total.`);
    out.push({
      financialYear: g.fy,
      gstin: g.gstin,
      monthsCovered: months.length,
      monthsExpected: 12,
      months,
      outwardTaxable,
      zeroRated,
      nilExempt,
      total,
      partYear,
    });
  }
  return out.sort((a, b) => a.financialYear.localeCompare(b.financialYear) || (a.gstin ?? '').localeCompare(b.gstin ?? ''));
}

/** Whole-period totals of what the session's readable documents say. Never fills a gap or averages across one. */
export function summarizeSessionTotals(results: DocumentExtractionResult[]): SessionTotals {
  const notes: string[] = [];
  const gst = summarizeGst(results, notes);
  const bank = summarizeBank(results, notes);
  return { gst, bank, notes };
}
