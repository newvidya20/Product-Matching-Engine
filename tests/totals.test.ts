import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSessionTotals } from '../server/documentAi/totals.ts';

const src = (fileName: string) => ({ documentId: 'd', fileName }) as never;
const row = (month: string, credits: number | null, extra: Record<string, unknown> = {}) =>
  ({ month, totalCredits: credits, closingBalance: null, confidence: 0.9, subjectRef: 'ACC1', source: src('a.pdf'), ...extra }) as never;
const bank = (id: string, rows: unknown[]) => ({ ok: true, documentId: id, bankMonthlyTotals: rows, fields: [] }) as never;
const gstP = (months: string[], taxable: number, extra: Record<string, unknown> = {}) =>
  ({ form: 'GSTR-3B', financialYear: 'FY 2025-26', months, outwardTaxable: taxable, zeroRated: 0, nilExempt: 0, nonGst: null, gstin: null, confidence: 0.9, source: src('g.pdf'), ...extra }) as never;
const gst = (id: string, periods: unknown[]) => ({ ok: true, documentId: id, bankMonthlyTotals: [], gstReturnPeriods: periods, fields: [] }) as never;

test('same month in two files of one account counts once', () => {
  const t = summarizeSessionTotals([bank('1', [row('2025-04', 100), row('2025-05', 200)]), bank('2', [row('2025-05', 200), row('2025-06', 300)])]);
  assert.equal(t.bank.accounts.length, 1);
  assert.equal(t.bank.accounts[0].totalCredits, 600);
  assert.equal(t.bank.accounts[0].monthsCovered, 3);
});

test('a conflicting month is excluded and noted', () => {
  const t = summarizeSessionTotals([bank('1', [row('2025-04', 100), row('2025-05', 200)]), bank('2', [row('2025-05', 250)])]);
  assert.equal(t.bank.accounts[0].totalCredits, 100);
  assert.deepEqual(t.bank.accounts[0].missingMonths, ['2025-05']);
  assert.ok(t.notes.some((n) => n.includes('2025-05')));
});

test('partial rows are never counted but noted; a full row wins', () => {
  const t = summarizeSessionTotals([bank('1', [row('2025-04', 100, { partial: true }), row('2025-05', 50, { partial: true })]), bank('2', [row('2025-04', 120)])]);
  assert.equal(t.bank.accounts[0].totalCredits, 120);
  assert.ok(t.notes.some((n) => n.includes('2025-05') && n.includes('partial')));
});

test('null debits stay null and debits sum when all read', () => {
  const a = summarizeSessionTotals([bank('1', [row('2025-04', 100)])]);
  assert.equal(a.bank.accounts[0].totalDebits, null);
  assert.equal(a.bank.allAccounts?.totalDebits, null);
  const b = summarizeSessionTotals([bank('1', [row('2025-04', 100, { totalDebits: 40 }), row('2025-05', 100, { totalDebits: 0.1 })])]);
  assert.equal(b.bank.accounts[0].totalDebits, 40.1);
});

test('paise sums are exact', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`2025-${String(i + 1).padStart(2, '0')}`, 0.1));
  const t = summarizeSessionTotals([bank('1', rows)]);
  assert.equal(t.bank.accounts[0].totalCredits, 1);
});

test('GST part year is flagged and a repeated return is not double counted', () => {
  const months = ['2025-04', '2025-05', '2025-06'];
  const t = summarizeSessionTotals([gst('1', [gstP(['2025-04'], 1000.1), gstP(['2025-05'], 2000.2)]), gst('2', [gstP(['2025-04'], 1000.1), gstP(months.slice(2), 0.3)])]);
  assert.equal(t.gst.length, 1);
  assert.equal(t.gst[0].monthsCovered, 3);
  assert.equal(t.gst[0].total, 3000.6);
  assert.equal(t.gst[0].partYear, true);
});

test('GST same month with different figures is not added twice', () => {
  const t = summarizeSessionTotals([gst('1', [gstP(['2025-04'], 100)]), gst('2', [gstP(['2025-04'], 999)])]);
  assert.equal(t.gst[0].total, 100);
  assert.ok(t.notes.some((n) => n.includes('2025-04')));
});

test('failed results and empty input give nothing', () => {
  const t = summarizeSessionTotals([{ ok: false, documentId: 'x', errorCode: 'internal_error' } as never]);
  assert.deepEqual(t, { gst: [], bank: { accounts: [], allAccounts: null }, notes: [] });
});
