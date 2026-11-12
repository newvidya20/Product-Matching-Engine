/**
 * Lender repayment schedules read with no AI. Every fixture is fictional (Sample Finance Ltd, invented
 * amounts) and generated here from a real amortisation formula, so the expected figures are computed
 * independently of the reader.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleAmount, parseScheduleDate, readRepaymentSchedule } from '../server/documentAi/repaymentSchedule.ts';

const TODAY = '2026-11-10';
const EMI = 41000;

interface Sched {
  serial: number;
  due: Date;
  opening: number;
  emi: number;
  principal: number;
  interest: number;
  closing: number;
}

/** Monthly schedule, first instalment 5 Jan 2026, due on the 5th, whole-rupee rows; the last row clears the balance. */
function build(months = 24, startOpening = 900000): Sched[] {
  const rows: Sched[] = [];
  let opening = startOpening;
  for (let i = 1; i <= months; i += 1) {
    const interest = Math.round((opening * 0.15) / 12);
    const principal = i === months ? opening : EMI - interest;
    rows.push({
      serial: i,
      due: new Date(Date.UTC(2026, i - 1, 5)),
      opening,
      emi: principal + interest,
      principal,
      interest,
      closing: opening - principal,
    });
    opening -= principal;
  }
  return rows;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const dMonY = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
const indian = (n: number) => {
  const s = String(n);
  if (s.length <= 3) return s;
  return `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`;
};
const western = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const HEADER = [
  'Sample Finance Ltd',
  'REPAYMENT SCHEDULE',
  'Inst. No | Due Date | Opening Balance | Instalment | Principal | Interest | Closing Balance',
];

function page(rows: Sched[], fmt: (n: number) => string, date = dmy, header = HEADER): string[] {
  return [
    ...header,
    ...rows.map(
      (r) => `${r.serial} ${date(r.due)} ${fmt(r.opening)} ${fmt(r.emi)} ${fmt(r.principal)} ${fmt(r.interest)} ${fmt(r.closing)}`
    ),
  ];
}

/** Principal due 11 Nov 2026 .. 10 Nov 2027, i.e. instalments due 5 Dec 2026 .. 5 Nov 2027. */
const expectedAnnual = (rows: Sched[]) =>
  rows
    .filter((r) => {
      const iso = r.due.toISOString().slice(0, 10);
      return iso > TODAY && iso <= '2027-11-10';
    })
    .reduce((s, r) => s + r.principal, 0);

type Fields = ReturnType<typeof readRepaymentSchedule>;
const byId = (fields: Fields, id: string) => fields.find((f) => f.fieldId === `financialProfile.${id}`);

describe('repayment schedule reader', () => {
  it('reads the regular EMI and the next 12 months principal exactly', () => {
    const rows = build();
    const fields = readRepaymentSchedule([page(rows, indian)], 0.9, TODAY);
    const emi = byId(fields, 'existingMonthlyEmi');
    const annual = byId(fields, 'annualScheduledPrincipalRepayments');
    assert.equal(emi?.rawValue, indian(EMI));
    assert.equal(emi?.period, null);
    assert.equal(emi?.subjectRef, 'Sample Finance Ltd');
    assert.equal(emi?.page, 1);
    assert.equal(annual?.rawValue, String(expectedAnnual(rows)));
    assert.equal(annual?.reconciled, true);
    assert.equal(annual?.period, null);
    assert.equal(fields.length, 2);
  });

  it('is not fooled by an odd final instalment', () => {
    const rows = build();
    assert.notEqual(rows[23].emi, EMI);
    const emi = byId(readRepaymentSchedule([page(rows, western, dMonY)], 0.9, TODAY), 'existingMonthlyEmi');
    assert.equal(emi?.rawValue, western(EMI));
  });

  it('parses grouping variants and date formats exactly', () => {
    assert.equal(parseScheduleAmount('1,23,456.78'), 12345678);
    assert.equal(parseScheduleAmount('3,093,239.00'), 309323900);
    assert.equal(parseScheduleAmount('156132'), 15613200);
    assert.equal(parseScheduleAmount('2,629378.00'), null);
    assert.equal(parseScheduleAmount('3.59100'), null);
    assert.equal(parseScheduleDate('2/12/25')?.iso, '2025-12-02');
    assert.equal(parseScheduleDate('03-Feb-2026')?.iso, '2026-02-03');
    assert.equal(parseScheduleDate('31-02-2026'), null);
    const rows = build();
    for (const [fmt, date] of [[indian, dmy], [western, dMonY], [String, dmy]] as const) {
      const annual = byId(readRepaymentSchedule([page(rows, fmt, date)], 0.9, TODAY), 'annualScheduledPrincipalRepayments');
      assert.equal(annual?.rawValue, String(expectedAnnual(rows)));
    }
  });

  it('works from one token per line, with pipes, and across two pages', () => {
    const rows = build();
    const tokens = (rs: Sched[]) =>
      rs.flatMap((r) => [r.serial, dmy(r.due), r.opening, r.emi, r.principal, r.interest, r.closing].map(String));
    const fields = readRepaymentSchedule([[...HEADER, ...tokens(rows.slice(0, 12))], tokens(rows.slice(12))], 0.9, TODAY);
    assert.equal(byId(fields, 'annualScheduledPrincipalRepayments')?.rawValue, String(expectedAnnual(rows)));
    const piped = rows.map(
      (r) =>
        `| ${r.serial} | ${dmy(r.due)} | ${indian(r.opening)} | ${indian(r.emi)} | ${indian(r.principal)} | ${indian(r.interest)} | ${indian(r.closing)} |`
    );
    assert.equal(byId(readRepaymentSchedule([[...HEADER, ...piped]], 0.9, TODAY), 'existingMonthlyEmi')?.rawValue, indian(EMI));
  });

  it('reads a table with no closing column, tied by the next opening balance', () => {
    const rows = build();
    const lines = rows.map(
      (r) =>
        `${r.serial} ${dMonY(r.due)} ${western(r.opening)}.00 ${western(r.emi)}.00 ${western(r.principal)}.00 ${western(r.interest)}.00 15.50 / 30`
    );
    const fields = readRepaymentSchedule(
      [['Repayment Schedule', 'Instl. # Due Date Opening Balance Installment Principal Interest', ...lines]],
      0.9,
      TODAY
    );
    assert.equal(byId(fields, 'existingMonthlyEmi')?.rawValue, `${western(EMI)}.00`);
    assert.equal(byId(fields, 'annualScheduledPrincipalRepayments')?.rawValue, String(expectedAnnual(rows)));
  });

  it('drops a corrupted row and tolerates a garbled header; withholds the sum when a dropped row was in the window', () => {
    const rows = build();
    const garbled = ['SI#| Dusbae | neiment | Pn ere ER', 'Installment Plan; Equated Installments'];
    // corrupt row 3 (already past): the sum is still exact
    const past = page(rows, indian, dmy, garbled);
    past[garbled.length + 2] = past[garbled.length + 2].replace(indian(rows[2].principal), '9,99,999');
    const ok = readRepaymentSchedule([past], 0.9, TODAY);
    assert.equal(byId(ok, 'existingMonthlyEmi')?.rawValue, indian(EMI));
    assert.equal(byId(ok, 'annualScheduledPrincipalRepayments')?.rawValue, String(expectedAnnual(rows)));
    // corrupt row 15 (in the window): it is dropped, so a partial sum is NOT emitted
    const live = page(rows, indian);
    const at = HEADER.length + 14;
    live[at] = live[at].replace(indian(rows[14].interest), indian(rows[14].interest + 5000));
    const out = readRepaymentSchedule([live], 0.9, TODAY);
    assert.equal(byId(out, 'existingMonthlyEmi')?.rawValue, indian(EMI));
    assert.equal(byId(out, 'annualScheduledPrincipalRepayments'), undefined);
  });

  it('emits the EMI but not the annual principal when only 8 future months are shown', () => {
    const rows = build().slice(0, 19); // last row 5 Jul 2027, balance still open
    const fields = readRepaymentSchedule([page(rows, indian)], 0.9, TODAY);
    assert.equal(byId(fields, 'existingMonthlyEmi')?.rawValue, indian(EMI));
    assert.equal(byId(fields, 'annualScheduledPrincipalRepayments'), undefined);
  });

  it('accepts a loan that provably ends inside the window', () => {
    const rows = build(16, 580000);
    assert.equal(rows[15].closing, 0);
    const annual = byId(readRepaymentSchedule([page(rows, indian)], 0.9, TODAY), 'annualScheduledPrincipalRepayments');
    assert.equal(annual?.rawValue, String(expectedAnnual(rows)));
  });

  it('reads the OCR-style pattern: merged serial and date, a dropped comma, noise lines', () => {
    const rows = build();
    const lines = page(rows, indian, dMonY);
    const merged = HEADER.length + 7;
    lines[merged] = lines[merged].replace(/^(\d+) /, '$1');
    const comma = HEADER.length + 9;
    lines[comma] = lines[comma].replace(/(\d),(\d{3})\b/, '$1$2');
    const fields = readRepaymentSchedule([['Page 1', ...lines, 'Sample Finance | 12 | .. x']], 0.8, TODAY);
    assert.equal(byId(fields, 'existingMonthlyEmi')?.rawValue, indian(EMI));
    // rows 8 and 10 are lost; both are in the past, so the window is intact and the sum is exact
    assert.equal(byId(fields, 'annualScheduledPrincipalRepayments')?.rawValue, String(expectedAnnual(rows)));
  });

  it('emits nothing for non-schedule text or inconsistent tables', () => {
    assert.deepEqual(readRepaymentSchedule([['Sanction letter', 'Cash Credit limit Rs. 50,00,000', 'Date 05/01/2026']], 0.9, TODAY), []);
    assert.deepEqual(readRepaymentSchedule([], 0.9, TODAY), []);
    const skewed = build().slice(0, 12).map((r) => ({ ...r, principal: r.principal + 7000 }));
    assert.deepEqual(readRepaymentSchedule([page(skewed, indian)], 0.9, TODAY), []);
    assert.deepEqual(readRepaymentSchedule([page(build().slice(0, 2), indian)], 0.9, TODAY), []);
  });
});
