import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLenderSanction, rupeesExact } from '../server/documentAi/lenderSanction.ts';
import { parseIndianAmount, unitAgreesWithSnippet } from '../server/documentAi/validators.ts';

// Fictional letters only: 'Sample Bank Ltd' and invented figures.
const read = (...pages: string[][]) => readLenderSanction(pages, 0.9);
const field = (fields: ReturnType<typeof read>, id: string) => fields.filter((f) => f.fieldId === `financialProfile.${id}`);
const HEAD = ['SAMPLE BANK LTD', 'Dear Sir/Madam,'];

/** What the pipeline will do with the field: parse it and check the unit against the snippet. */
function pipelineValue(f: ReturnType<typeof read>[number]): number {
  const parsed = parseIndianAmount(f.rawValue, { statedUnit: f.statedUnit, documentType: 'existing_sanction_letter', amountNature: 'limit' });
  assert.ok(parsed.ok);
  assert.ok(
    unitAgreesWithSnippet({ rawValue: f.rawValue, inlineUnit: parsed.inlineUnit, statedUnit: f.statedUnit, snippet: f.snippet, creditMarker: false }),
    `unit must agree with snippet: ${f.snippet}`
  );
  return parsed.value;
}

test('exact crore / lakh conversion', () => {
  assert.equal(rupeesExact('13.00', 'crore'), '130000000');
  assert.equal(rupeesExact('5.40', 'crore'), '54000000');
  assert.equal(rupeesExact('2.5', 'lakh'), '250000');
  assert.equal(rupeesExact('1,30'.replace(',', ''), null), '130');
});

test('CC limit in crore words, with lender name and the prior limit ignored', () => {
  const out = field(
    read([
      ...HEAD,
      'Facility  Cash Credit Limit of Rs. 13.00 crore (Rupees Thirteen crore only)(Renewal &',
      'Enhanced from Rs. 10.00 Crore)',
      'Drawings subject to a maximum limit of Rs.13.00 Crore',
    ]),
    'ccOdSanctionedLimit'
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].rawValue, '13.00 crore');
  assert.equal(out[0].subjectRef, 'SAMPLE BANK LTD');
  assert.equal(out[0].page, 1);
  assert.equal(pipelineValue(out[0]), 130_000_000);
});

test('keeps the original behaviour: a labelled rupee limit', () => {
  const out = read(['Cash credit limit sanctioned Rs. 1,30,00,000/-']);
  assert.equal(out[0]?.rawValue, '1,30,00,000');
  assert.equal(pipelineValue(out[0]), 13_000_000);
  assert.deepEqual(read(['Repayment period limit Rs 5,00,000']), []);
  assert.deepEqual(read(['Overdraft limit Rs 50,000 lakhs']), []);
});

test('a lakh figure is converted exactly', () => {
  const out = read(['Overdraft Limit of Rs. 7.50 Lakhs']);
  assert.equal(out[0]?.rawValue, '7.50 lakh');
  assert.equal(pipelineValue(out[0]), 750_000);
});

test('enhancement line "from X to Y" is skipped', () => {
  assert.deepEqual(read(['CC limit enhanced from Rs 30,00,000 to Rs 50,00,000']), []);
  assert.deepEqual(read(['Cash Credit Limit enhanced from Rs. 3.00 crore to Rs. 5.00 crore']), []);
});

test('term loan: instalment amount printed on the line below its label', () => {
  const out = field(
    read([...HEAD, 'Type of facility', 'Business Loan', 'Installment amount', 'Rs.  1,74,553.00', 'Loan tenure (in months)', '36', 'Our monthly EMI is collected by NACH.']),
    'existingMonthlyEmi'
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].rawValue, '1,74,553.00');
  assert.equal(out[0].subjectRef, 'SAMPLE BANK LTD');
  assert.equal(pipelineValue(out[0]), 174_553);
});

test('term loan: "monthly / quarterly instalments of Rs X each" is monthly only when the dates prove it', () => {
  const lines = [
    'In 36 monthly / quarterly instalments of Rs. 3,41,666.67/- each, with the first instalment commencing',
    'on Dec 2026 and the last instalment falling due on Nov 2029.',
  ];
  const out = field(read(lines), 'existingMonthlyEmi');
  assert.equal(out.length, 1);
  assert.equal(out[0].rawValue, '3,41,666.67');
  assert.ok(out[0].confidence <= 0.8, 'derived frequency is held for review');
  // Same words, dates that do not prove monthly: refused.
  assert.deepEqual(
    read([lines[0], 'on Dec 2026 and the last instalment falling due on Sep 2035.']),
    []
  );
  assert.deepEqual(read([lines[0]]), []);
});

test('term loan: quarterly, approximate, total and first-EMI figures are not read', () => {
  assert.deepEqual(read(['Repayable in 12 quarterly instalments of Rs. 4,00,000 each']), []);
  assert.deepEqual(read(['Instalment amount', 'As per the repayment schedule']), []);
  assert.deepEqual(read(['Monthly EMI approx Rs. 55,000']), []);
  assert.deepEqual(read(['Broken period interest adjusted in First EMI Rs. 27,986.12', 'Monthly instalments']), []);
});

test('term loan: "Amount of each EPI" with the frequency on the next line, and a repeated equal figure', () => {
  const page = ['Amount of each EPI (in Rupees) and', 'nos. of EPIs (e.g. no. of EMIs in case of monthly instalments)', 'Monthly', 'INR 74,333', '36'];
  const out = field(read(page, ['c. Amount of each EPI / EMI', 'Rs. 74,333/-']), 'existingMonthlyEmi');
  assert.equal(out.length, 1);
  assert.equal(pipelineValue(out[0]), 74_333);
  // Two different instalment amounts in one letter: none.
  assert.deepEqual(field(read(page, ['Amount of each EPI / EMI', 'Rs. 80,000/-']), 'existingMonthlyEmi'), []);
});

test('multi-facility table: the PROPOSED column, never the existing one', () => {
  const table = [
    'Rs. in Crs',
    'S  FACILITY  EXISTING LIMIT  PROPOSED',
    'L  LIMIT',
    'a Cash Credit  5.40  6.25',
    'b EPC/PCFC/PSC/FBD(Within overall CC limit)  (5.40)  (6.25)',
    'c Stand-by Line of Credit (SLC)  0.75  0.75',
    'd Working Capital Term Loan  0.00  1.23',
    'Total of Fund Based Limits  6.15  8.23',
  ];
  const out = field(read([...HEAD, ...table]), 'ccOdSanctionedLimit');
  assert.equal(out.length, 1);
  assert.equal(out[0].rawValue, '6.25 crore');
  assert.equal(pipelineValue(out[0]), 62_500_000);
  // Header names only an existing column: nothing sanctioned is stated.
  assert.deepEqual(read(['Rs. in Crs', 'FACILITY  EXISTING LIMIT', 'a Cash Credit  5.40']), []);
  // No unit header: refuse.
  assert.deepEqual(read(table.slice(1)), []);
  // Proposed limit of zero (facility closed): nothing.
  assert.deepEqual(read(['Rs. in Crs', 'FACILITY  EXISTING LIMIT  PROPOSED', 'a Cash Credit  5.40  0.00']), []);
  // Wrong number of figures in the row: refuse.
  assert.deepEqual(read(['Rs. in Crs', 'FACILITY  EXISTING LIMIT  PROPOSED', 'a Cash Credit  5.40']), []);
});

test('conflicting figures for the same label: none', () => {
  assert.deepEqual(read(['Cash Credit Limit of Rs. 5.00 crore', 'Overdraft Limit of Rs. 3.00 crore']), []);
  assert.deepEqual(read(['Cash credit limit sanctioned Rs. 50,00,000', 'CC limit Rs. 60,00,000']), []);
  // The same figure in two spellings is not a conflict.
  assert.equal(read(['Cash Credit Limit of Rs. 5.00 crore', 'Cash credit limit sanctioned Rs. 5,00,00,000'])[0]?.fieldId, 'financialProfile.ccOdSanctionedLimit');
});

test("another lender's limit quoted in the security clause does not conflict with the headline limit", () => {
  const out = read([
    'Facility  Cash Credit Limit of Rs. 13.00 crore (Renewal)',
    'Primary security pari-passu with (Working Capital limit Rs.4.40 Crore) & Other Bank (Working Capital limit Rs.5.40 crore).',
  ]);
  assert.equal(out[0]?.rawValue, '13.00 crore');
});

test('OCR noise: Rs without a full stop and period-for-comma grouping', () => {
  assert.equal(read(['Cash Credit Limit of Rs 13.00 crores'])[0]?.rawValue, '13.00 crore');
  assert.equal(read(['Cash credit limit sanctioned Rs. 1.30.00.000/-'])[0]?.rawValue, '13000000');
  // Figures that cannot be read with certainty are refused, not repaired.
  assert.deepEqual(read(['Cash credit limit sanctioned Rs. 5.000']), []);
  assert.deepEqual(read(['Repayable in 36 monthly instalments of Rs. 3.41,666.67/- each']), []);
  assert.deepEqual(read(['Cash credit limit sanctioned Rs. 1,30,0']), []);
});

test('a repayment schedule page is not read for instalments', () => {
  const rows = Array.from({ length: 8 }, (_, i) => `0${i + 1}/0${(i % 9) + 1}/2026`);
  assert.deepEqual(read(['Monthly EMI Rs. 10,000 each', ...rows]), []);
});

test('unrelated text yields nothing', () => {
  assert.deepEqual(read(['Dear Sir,', 'Please find the invoice for the goods supplied.', 'Rs. 12,500 is payable by 30 June.']), []);
  assert.deepEqual(readLenderSanction([], 0.9), []);
});
