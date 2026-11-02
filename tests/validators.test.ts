/**
 * Validator tests. Contract: docs/contracts.md section 6. Imports the exact names the contract specifies.
 * Expected to fail to import until extraction-engineer's validators.ts lands on feature/document-ai.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentType } from '../src/types/documentAi.ts';
import {
  normalizeFinancialYear,
  parseDate,
  parseIndianAmount,
  parsePercent,
  validateGstin,
  validatePan,
} from '../server/documentAi/validators.ts';
import { TODAY, buildGstin, gstinCheckChar } from './helpers/documentAi.ts';

type AmountUnit = 'rupees' | 'thousand' | 'lakh' | 'crore' | 'million';

/** Narrows a Validated-style result to its ok branch, failing the test otherwise. */
function expectOk<T extends { ok: boolean }>(result: T): asserts result is Extract<T, { ok: true }> {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
}

function expectFail(result: { ok: boolean; code?: string }): void {
  assert.equal(result.ok, false, `expected failure, got ${JSON.stringify(result)}`);
  assert.equal(typeof result.code, 'string');
  assert.ok((result.code as string).length > 0);
}

function amount(
  raw: string,
  documentType: DocumentType = 'financial_statement',
  statedUnit: AmountUnit | null = null
) {
  return parseIndianAmount(raw, { documentType, statedUnit });
}

describe('validatePan (contract 6.1)', () => {
  it('accepts a well-formed fictional PAN', () => {
    const result = validatePan('ABCPE1234F');
    expectOk(result);
    assert.equal(result.value, 'ABCPE1234F');
  });

  it('upper-cases and strips spaces before checking', () => {
    const result = validatePan(' abcpe 1234f ');
    expectOk(result);
    assert.equal(result.value, 'ABCPE1234F');
  });

  it('accepts every holder-type character in the contract list', () => {
    for (const holder of 'ABCFGHJLPT') {
      const pan = `ABC${holder}E1234F`;
      const result = validatePan(pan);
      assert.equal(result.ok, true, `holder type ${holder} should be accepted`);
    }
  });

  it('rejects a fourth character outside the holder-type list', () => {
    for (const holder of ['D', 'E', 'K', 'M', 'X', 'Z', '1']) {
      expectFail(validatePan(`ABC${holder}E1234F`));
    }
  });

  it('rejects wrong length', () => {
    expectFail(validatePan('ABCPE1234'));
    expectFail(validatePan('ABCPE12345F'));
    expectFail(validatePan(''));
  });

  it('rejects wrong character classes', () => {
    expectFail(validatePan('1BCPE1234F')); // digit in the name block
    expectFail(validatePan('ABCP11234F')); // digit where the fifth letter belongs
    expectFail(validatePan('ABCPE123F4')); // letter inside the digit block
  });

  it('never throws on junk input', () => {
    for (const raw of ['', ' ', '\u0000', 'ABCPE1234F\n\n', '9'.repeat(500)]) {
      assert.doesNotThrow(() => validatePan(raw));
    }
  });
});

describe('validateGstin (contract 6.2)', () => {
  it('accepts the contract test vectors', () => {
    expectOk(validateGstin('27AAPFU0939F1ZV'));
    expectOk(validateGstin('29AAGCB7383J1Z4'));
  });

  it('rejects the contract checksum vector', () => {
    expectFail(validateGstin('27ABCDE1234F1Z5'));
  });

  it('rejects a single wrong check character', () => {
    expectFail(validateGstin('27AAPFU0939F1ZW'));
  });

  it('upper-cases and strips spaces before checking', () => {
    const lower = validateGstin('27aapfu0939f1zv');
    expectOk(lower);
    assert.equal(lower.value, '27AAPFU0939F1ZV');

    const spaced = validateGstin('27 AAPFU0939F 1ZV');
    expectOk(spaced);
    assert.equal(spaced.value, '27AAPFU0939F1ZV');
  });

  it('accepts state codes 01 to 38, 97 and 99', () => {
    for (const state of ['01', '19', '27', '38', '97', '99']) {
      const result = validateGstin(buildGstin(state, 'AAPFU0939F'));
      assert.equal(result.ok, true, `state ${state} should be accepted`);
    }
  });

  it('rejects state codes outside the allowed set', () => {
    for (const state of ['00', '39', '96']) {
      expectFail(validateGstin(buildGstin(state, 'AAPFU0939F')));
    }
  });

  it('requires the characters at positions 3 to 12 to pass the PAN check', () => {
    // 'AAKZU0939F' has a fourth character (Z) outside the holder-type list.
    expectFail(validateGstin(buildGstin('27', 'AAKZU0939F')));
  });

  it('requires Z at position 14 (index 13), even when the check character is correct', () => {
    const body = '27AAPFU0939F1A';
    expectFail(validateGstin(`${body}${gstinCheckChar(body)}`));
  });

  it('requires entity character 1 to 9 or A to Z, not 0', () => {
    expectFail(validateGstin(buildGstin('27', 'AAPFU0939F', '0')));
  });

  it('rejects wrong length and empty input', () => {
    expectFail(validateGstin('27AAPFU0939F1Z'));
    expectFail(validateGstin('27AAPFU0939F1ZVV'));
    expectFail(validateGstin(''));
  });

  it('never throws on junk input', () => {
    for (const raw of ['', '      ', '27', '\u0000'.repeat(15), 'Z'.repeat(400)]) {
      assert.doesNotThrow(() => validateGstin(raw));
    }
  });
});

describe('parseIndianAmount: symbols, signs and suffixes (contract 6.3)', () => {
  it('matches the contract table', () => {
    const cases: Array<[string, DocumentType, AmountUnit | null, number]> = [
      ['₹12,50,000/-', 'financial_statement', null, 1250000],
      ['Rs. 1.25 Cr', 'financial_statement', null, 12500000],
      ['12.5 lakh', 'financial_statement', null, 1250000],
      ['(12.50)', 'financial_statement', 'lakh', -1250000],
      ['1,250.00', 'financial_statement', 'thousand', 1250000],
      ['1,23,456.00 Cr', 'bank_statement', null, 123456],
      ['5,000.00 Dr', 'bank_statement', null, -5000],
      ['0', 'financial_statement', null, 0],
      ['0.00', 'financial_statement', null, 0],
    ];
    for (const [raw, documentType, unit, expected] of cases) {
      const result = amount(raw, documentType, unit);
      expectOk(result);
      assert.equal(result.value, expected, `parsing ${raw}`);
    }
  });

  it('strips the rupee sign, Rs, Rs., INR, Re. and /- in any case', () => {
    expectOk(amount('INR 50,000'));
    expectOk(amount('rs. 1,000'));
    assert.equal(okOrThrow(amount('Rs 500/-')).value, 500);
    assert.equal(okOrThrow(amount('Re. 500')).value, 500);
    assert.equal(okOrThrow(amount('₹ 1,00,00,000')).value, 10000000);
  });

  it('treats blank, dash and Nil as failures for the model to omit', () => {
    expectFail(amount(''));
    expectFail(amount('-'));
    expectFail(amount('Nil'));
  });

  it('rejects non-INR currency marks with code non_inr_currency', () => {
    for (const raw of ['USD 5,000', '$5,000', 'EUR 1,000']) {
      const result = amount(raw);
      assert.equal(result.ok, false, `${raw} should fail`);
      if (!result.ok) assert.equal(result.code, 'non_inr_currency');
    }
  });
});

describe('parseIndianAmount: negatives (contract 6.3 step 2)', () => {
  it('reads (x), -x and x- as negative', () => {
    assert.equal(okOrThrow(amount('(1,234)')).value, -1234);
    assert.equal(okOrThrow(amount('-1,234')).value, -1234);
    assert.equal(okOrThrow(amount('1,234-')).value, -1234);
  });

  it('reads a trailing Dr as negative only in bank_statement', () => {
    assert.equal(okOrThrow(amount('5,000.00 Dr', 'bank_statement')).value, -5000);
    const elsewhere = amount('5,000 Dr', 'financial_statement');
    assert.ok(!elsewhere.ok || elsewhere.value >= 0, 'Dr outside bank_statement must not be negative');
  });
});

describe('parseIndianAmount: credit marker and crore (contract 6.3 step 3)', () => {
  it('strips a trailing Cr in bank_statement with no multiplier', () => {
    assert.equal(okOrThrow(amount('1,23,456.00 Cr', 'bank_statement')).value, 123456);
  });

  it('reads Cr, Crs, Crore and Crores as crore elsewhere', () => {
    assert.equal(okOrThrow(amount('1.25 Cr')).value, 12500000);
    assert.equal(okOrThrow(amount('1.5 Crs')).value, 15000000);
    assert.equal(okOrThrow(amount('4 Crore')).value, 40000000);
    assert.equal(okOrThrow(amount('3 Crores')).value, 30000000);
  });
});

describe('parseIndianAmount: inline units (contract 6.3 step 4)', () => {
  it('reads lakh, lac, lakhs and lacs as 1e5', () => {
    assert.equal(okOrThrow(amount('12.5 lakh')).value, 1250000);
    assert.equal(okOrThrow(amount('2 Lac')).value, 200000);
    assert.equal(okOrThrow(amount('2 Lakhs')).value, 200000);
    assert.equal(okOrThrow(amount('2 Lacs')).value, 200000);
  });

  it('reads mn and million as 1e6, and k and thousand as 1e3', () => {
    assert.equal(okOrThrow(amount('7 Mn')).value, 7000000);
    assert.equal(okOrThrow(amount('7 Million')).value, 7000000);
    assert.equal(okOrThrow(amount('8 K')).value, 8000);
    assert.equal(okOrThrow(amount('8 Thousand')).value, 8000);
  });
});

describe('parseIndianAmount: digits and grouping (contract 6.3 step 5)', () => {
  it('accepts Indian and western grouping', () => {
    assert.equal(okOrThrow(amount('12,50,000')).value, 1250000);
    assert.equal(okOrThrow(amount('1,250,000')).value, 1250000);
    assert.equal(okOrThrow(amount('1,25,00,000')).value, 12500000);
  });

  it('rejects multiple decimal points, a comma decimal, ranges and words', () => {
    expectFail(amount('1.250.000'));
    expectFail(amount('12,5'));
    expectFail(amount('10-20'));
    expectFail(amount('twelve lakh'));
  });

  it('never throws on junk input', () => {
    for (const raw of ['', ' ', '₹', 'Rs.', '(', ')', '--', '1e5', 'NaN', 'Infinity', '9'.repeat(400)]) {
      assert.doesNotThrow(() => amount(raw));
    }
  });
});

describe('parseIndianAmount: stated units and ambiguity (contract 6.3 steps 6 to 8)', () => {
  it('applies a statedUnit when there is no inline unit', () => {
    assert.equal(okOrThrow(amount('1,250.00', 'financial_statement', 'thousand')).value, 1250000);
  });

  it('lets an inline unit beat the stated unit and flags ambiguousUnit when they differ', () => {
    const result = okOrThrow(amount('2 lakh', 'financial_statement', 'crore'));
    assert.equal(result.value, 200000);
    assert.equal(result.ambiguousUnit, true);
  });

  it('does not flag ambiguity when the inline unit matches the stated unit', () => {
    const result = okOrThrow(amount('2 lakh', 'financial_statement', 'lakh'));
    assert.equal(result.value, 200000);
    assert.equal(result.ambiguousUnit, false);
  });

  it('flags a figure below 1,000 with decimals and no unit at all', () => {
    const result = okOrThrow(amount('0.5', 'financial_statement'));
    assert.equal(result.value, 0.5);
    assert.equal(result.ambiguousUnit, true);
    assert.equal(okOrThrow(amount('999.5', 'financial_statement')).ambiguousUnit, true);
  });

  it('does not flag small decimals in bank_statement or gst_return', () => {
    assert.equal(okOrThrow(amount('0.50', 'bank_statement')).ambiguousUnit, false);
    assert.equal(okOrThrow(amount('0.50', 'gst_return')).ambiguousUnit, false);
  });

  it('does not flag a figure of 1,000 or more with no unit', () => {
    assert.equal(okOrThrow(amount('2,000', 'financial_statement')).ambiguousUnit, false);
  });

  it('rounds to 2 decimal places', () => {
    assert.equal(okOrThrow(amount('1.23456789 lakh')).value, 123456.79);
  });
});

describe('parseDate (contract 6.4)', () => {
  it('normalises every accepted form to YYYY-MM-DD', () => {
    const forms = ['31/03/2025', '31-03-2025', '31.03.2025', '31-Mar-2025', '31 March 2025', '2025-03-31'];
    for (const raw of forms) {
      const result = parseDate(raw, { today: TODAY });
      expectOk(result);
      assert.equal(result.value, '2025-03-31', `parsing ${raw}`);
    }
  });

  it('reads numeric forms day first', () => {
    assert.equal(okOrThrow(parseDate('04/05/2025', { today: TODAY })).value, '2025-05-04');
    assert.equal(okOrThrow(parseDate('02/11/2026', { today: TODAY })).value, '2026-11-02');
  });

  it('rejects impossible dates, including leap-year misses', () => {
    expectFail(parseDate('31/02/2024', { today: TODAY }));
    expectFail(parseDate('29/02/2023', { today: TODAY }));
    assert.equal(okOrThrow(parseDate('29/02/2024', { today: TODAY })).value, '2024-02-29');
  });

  it('rejects two-digit years, month 13 and prose', () => {
    expectFail(parseDate('31/03/25', { today: TODAY }));
    expectFail(parseDate('31-13-2025', { today: TODAY }));
    expectFail(parseDate('last year', { today: TODAY }));
  });

  it('rejects future dates unless allowFuture', () => {
    expectFail(parseDate('01/01/2027', { today: TODAY }));
    assert.equal(okOrThrow(parseDate('01/01/2027', { today: TODAY, allowFuture: true })).value, '2027-01-01');
  });
});

describe('normalizeFinancialYear (contract 6.4)', () => {
  it('normalises the accepted FY forms to FY 2024-25', () => {
    const forms = ['FY 2024-25', 'F.Y. 2024-2025', '2024-25', 'Year ended 31 March 2025'];
    for (const raw of forms) {
      const result = normalizeFinancialYear(raw);
      expectOk(result);
      assert.equal(result.value, 'FY 2024-25', `parsing ${raw}`);
    }
  });

  it('shifts an assessment year back one: AY 2025-26 is FY 2024-25', () => {
    const result = normalizeFinancialYear('AY 2025-26');
    expectOk(result);
    assert.equal(result.value, 'FY 2024-25');
  });

  it('requires the second year to be the first plus one', () => {
    expectFail(normalizeFinancialYear('FY 2024-26'));
    expectFail(normalizeFinancialYear('FY 2024-2027'));
  });

  it('rejects a single year and prose', () => {
    expectFail(normalizeFinancialYear('FY 2024'));
    expectFail(normalizeFinancialYear('hello'));
  });
});

describe('parsePercent', () => {
  it('reads percentages as numbers', () => {
    assert.equal(okOrThrow(parsePercent('18%')).value, 18);
    assert.equal(okOrThrow(parsePercent('18.5 %')).value, 18.5);
    assert.equal(okOrThrow(parsePercent('0%')).value, 0);
  });

  it('rejects non-numeric input', () => {
    expectFail(parsePercent('abc'));
    expectFail(parsePercent(''));
  });
});

/** Narrows an ok result for assertions, failing the test with the code if the validator rejected it. */
function okOrThrow<R extends { ok: boolean }>(result: R): Extract<R, { ok: true }> {
  expectOk(result);
  return result as Extract<R, { ok: true }>;
}
