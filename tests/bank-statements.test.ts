import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bankMonthsFromStatement, parseBankStatement, parseMoney, summariseMonths } from '../server/documentAi/bankStatements.ts';

// All figures below are invented.
const SBI_STYLE = [
  'Account Number : 00000012345678901',
  'Account Statement from 1 Mar 2026 to 31 Mar 2026',
  'Balance as on 1 Mar 2026 : -1,00,000.00',
  'Txn Date Value Date Description Ref No./Cheque Branch Debit Credit Balance',
  '01/03/2026 01/03/2026 WITHDRAWAL TRANSFER 1053 20,000.00 -1,20,000.00',
  'INT TRF FRM TO',
  '02/03/2026 02/03/2026 BY TRANSFER RTGS 4430 5,00,000.00 3,80,000.00',
  '15/03/2026 15/03/2026 BY TRANSFER NEFT 4430 1,50,000.50 5,30,000.50',
];

const AXIS_STYLE = [
  'Statement of Axis Bank Account No : 917000000000001 for the period ( From : 01/02/2026 To : 28/02/2026 )',
  'Opening Balance: INR -,70,000.00',
  'BRN-TD/1/17-03- 5,000.00 -,65,000.00 MIDC, MUMBAI [MH] (395)',
  '1 02/02/2026 02/02/2026',
  'Loan Account Payments For : 4,000.00 -,69,000.00 MIDC, MUMBAI [MH] (2470)',
  '2 05/02/2026 31/01/2026',
  '8 TRANSACTION TOTAL DR/CR',
  '4,000.00 5,000.00 MIDC, MUMBAI [MH]',
  'Closing Balance: INR -,69,000.00',
];

describe('bank statement reader', () => {
  it('parses Indian and unusual money tokens', () => {
    assert.equal(parseMoney('1,04,25,314.80'), 10425314.8);
    assert.equal(parseMoney('-,71,90,244.17'), -7190244.17);
    assert.equal(parseMoney('.95'), 0.95);
    assert.equal(parseMoney('12'), null);
  });

  it('decides credit or debit by the running balance and reconciles', () => {
    const s = parseBankStatement([SBI_STYLE]);
    assert.equal(s.transactions.length, 3);
    assert.deepEqual(s.transactions.map((t) => [t.credit, t.debit]), [[0, 20000], [500000, 0], [150000.5, 0]]);
    assert.equal(s.reconciled, true);
    assert.deepEqual(summariseMonths(s).map((m) => [m.month, m.credits]), [['2026-03', 650000.5]]);
  });

  it('takes the date from the serial line when the amounts line has none, and checks the printed totals', () => {
    const s = parseBankStatement([AXIS_STYLE]);
    assert.equal(s.printedTotals?.credit, 5000);
    assert.equal(s.transactions.length, 2);
    assert.equal(s.reconciled, true);
    const { months } = bankMonthsFromStatement([AXIS_STYLE], 0.9);
    assert.equal(months[0].month, '2026-02');
    assert.equal(months[0].totalCredits, '5000.00');
    assert.equal(months[0].closingBalance, null, 'an overdrawn closing balance is not a banking balance');
    assert.equal(months[0].reconciled, true);
  });

  it('refuses a row that does not follow the balance', () => {
    const broken = [...SBI_STYLE.slice(0, 5), '02/03/2026 02/03/2026 BY TRANSFER RTGS 4430 5,00,000.00 9,99,999.00'];
    const s = parseBankStatement([broken]);
    assert.equal(s.transactions.length, 1);
  });

  it('marks a capped statement partial', () => {
    const lines = [...SBI_STYLE, 'The number of transactions in this statement exceeds 299 entries. You can view the remaining transactions in the Pending Statement'];
    const { months } = bankMonthsFromStatement([lines], 0.9);
    assert.equal(months[0].partial, true);
  });

  it('emits totalDebits to the paisa only when the rows are proved', () => {
    const proved = bankMonthsFromStatement([SBI_STYLE], 0.9);
    assert.equal(proved.statement.reconciled, true);
    const debitSum = proved.statement.transactions.reduce((a, t) => a + Math.round(t.debit * 100), 0) / 100;
    assert.equal(proved.months[0].totalDebits, debitSum.toFixed(2));
    assert.equal(proved.months[0].totalDebits, '20000.00');
    assert.equal(proved.months[0].totalCredits, '650000.50', 'credits unchanged');

    const broken = AXIS_STYLE.map((l) => (l === '4,000.00 5,000.00 MIDC, MUMBAI [MH]' ? '4,000.00 9,000.00 MIDC, MUMBAI [MH]' : l));
    const unproved = bankMonthsFromStatement([broken], 0.9);
    assert.equal(unproved.statement.reconciled, false);
    for (const m of unproved.months) assert.equal(m.totalDebits, null);
  });
});
