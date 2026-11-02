/**
 * Validator tests. Contract: docs/contracts.md section 6. Imports the exact names the contract specifies.
 * Expected to fail to import until extraction-engineer's validators.ts lands on feature/document-ai.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentType } from '../src/types/documentAi.ts';
import { getFieldDefinition } from '../src/documentAi/fieldMap.ts';
import {
  backoffDelayMs,
  callWithRetry,
  classifyProviderError,
  ExtractionError,
  GEMINI_HTTP_OPTIONS,
} from '../server/documentAi/gemini.ts';
import { buildExtractionInstruction, EXTRACTION_SCHEMA, parseExtractionResponse } from '../server/documentAi/prompt.ts';
import {
  createSourceVerifier,
  findEnumEvidence,
  hasForeignUnit,
  hasLossWording,
  hasNegativeFigure,
  positiveValueDoubted,
  hasPartYearWording,
  normalizeFinancialYear,
  normalizePeriod,
  parseDate,
  parseIndianAmount,
  parsePercent,
  rawValueInSnippet,
  unitAgreesWithSnippet,
  unitTextSupports,
  validateGstin,
  validatePan,
  type SourceQuery,
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

describe('parseIndianAmount: Cr beside a limit (contract 6.3 step 3)', () => {
  const limit = (raw: string) =>
    parseIndianAmount(raw, { documentType: 'bank_statement', amountNature: 'limit' });

  it('reads Cr as crore on a limit, even on a bank statement', () => {
    const result = okOrThrow(limit('2.5 Cr'));
    assert.equal(result.value, 25000000);
    assert.equal(result.inlineUnit, 'crore');
    assert.equal(result.ambiguousUnit, false);
  });

  it('keeps the credit marker for balances and transactions on the same statement', () => {
    const result = okOrThrow(amount('2.5 Cr', 'bank_statement'));
    assert.equal(result.value, 2.5);
    assert.equal(result.inlineUnit, null);
  });

  it('flags a limit too large for Cr to be crore, as it may be a credit marker', () => {
    const result = okOrThrow(limit('50,00,000.00 Cr'));
    assert.equal(result.ambiguousUnit, true);
  });

  it('wires ccOdSanctionedLimit as the limit, and utilisation as a balance', () => {
    assert.equal(getFieldDefinition('financialProfile.ccOdSanctionedLimit')?.amountNature, 'limit');
    assert.equal(getFieldDefinition('financialProfile.ccOdUtilisation')?.amountNature, undefined);
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

  it('does not flag a figure of 1,000 or more with no unit outside financial statements', () => {
    assert.equal(okOrThrow(amount('2,000', 'loan_application')).ambiguousUnit, false);
  });

  it('flags a financial statement figure below 1,00,000 with no stated unit', () => {
    assert.equal(okOrThrow(amount('2,000', 'financial_statement')).ambiguousUnit, true);
    assert.equal(okOrThrow(amount('99,999', 'financial_statement')).ambiguousUnit, true);
    assert.equal(okOrThrow(amount('1,00,000', 'financial_statement')).ambiguousUnit, false);
  });

  it('clears that flag once a unit is stated, inline or by header, and for zero', () => {
    assert.equal(okOrThrow(amount('2,000', 'financial_statement', 'rupees')).ambiguousUnit, false);
    assert.equal(okOrThrow(amount('12.5 lakh', 'financial_statement')).ambiguousUnit, false);
    assert.equal(okOrThrow(amount('0', 'financial_statement')).ambiguousUnit, false);
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

describe('unit evidence (contract 6.3)', () => {
  const agrees = (rawValue: string, snippet: string, statedUnit: AmountUnit | null = null, creditMarker = false) => {
    const parsed = okOrThrow(parseIndianAmount(rawValue, {
      documentType: creditMarker ? 'bank_statement' : 'financial_statement',
      statedUnit,
    }));
    return unitAgreesWithSnippet({ rawValue, inlineUnit: parsed.inlineUnit, statedUnit, snippet, creditMarker });
  };

  it('fails 1.25 Cr against a snippet printing 1.25 Lakh', () => {
    assert.equal(agrees('1.25 Cr', 'Turnover 1.25 Lakh'), false);
    assert.equal(agrees('1.25 Cr', 'Turnover 1.25 Cr'), true);
  });

  it('fails a unit word the snippet does not show, and passes one in a header within it', () => {
    assert.equal(agrees('1.25 Cr', 'Turnover 1.25'), false);
    assert.equal(agrees('1.25 Cr', 'Rs. in crore: Turnover 1.25'), true);
    assert.equal(agrees('1.25 Cr', 'Rs. in lakhs: Turnover 1.25'), false);
  });

  it('fails a rawValue that dropped the unit printed beside it', () => {
    assert.equal(agrees('50', 'Requested Rs 50 lakh'), false);
  });

  it('fails a stated unit contradicted by the unit beside the figure', () => {
    assert.equal(agrees('12.50', 'Revenue 12.50 Cr', 'lakh'), false);
    assert.equal(agrees('12.50', 'Revenue 12.50', 'lakh'), true);
  });

  it('does not read a bank credit marker as a unit', () => {
    assert.equal(agrees('1,23,456.00 Cr', 'Closing balance 1,23,456.00 Cr', null, true), true);
  });

  it("fails a header the value was not scaled by, at any size", () => {
    assert.equal(agrees('12,50,000', "(Rs. in '000) Revenue 12,50,000"), false);
    assert.equal(agrees('12,50,000', "(Rs. ’000) Revenue 12,50,000"), false);
    assert.equal(agrees('12,50,000', 'Figures in lakhs: Revenue 12,50,000'), false);
    assert.equal(agrees('12,50,000', "(Rs. in '000) Revenue 12,50,000", 'thousand'), true);
    assert.equal(agrees('1.25 Cr', 'Rs. in lakhs: Turnover 1.25 Cr'), false);
    assert.equal(agrees('12.50', 'Rs. in crores: Revenue 12.50', 'lakh'), false);
  });

  it('reads the row text and the unit text as well as the snippet', () => {
    const base = { rawValue: '12,50,000', inlineUnit: null, statedUnit: null, snippet: 'Revenue 12,50,000', creditMarker: false };
    assert.equal(unitAgreesWithSnippet(base), true);
    assert.equal(unitAgreesWithSnippet({ ...base, rowText: 'Revenue (Rs. in lakhs)' }), false);
    assert.equal(unitAgreesWithSnippet({ ...base, unitText: "Rs. '000" }), false);
    assert.equal(unitAgreesWithSnippet({ ...base, rowText: null, unitText: null }), true);
  });

  it('does not take a unit that belongs to one figure for a header', () => {
    assert.equal(agrees('12,50,000', 'Rs. 12,50,000 (Rupees Twelve Lakh Fifty Thousand only)'), true);
    assert.equal(agrees('12,50,000', 'Rs. 12,50,000 against a limit of 50 lakh'), true);
    assert.equal(agrees('1,23,456.00 Cr', 'Dr/Cr Closing balance 1,23,456.00 Cr', null, true), true);
    assert.equal(agrees('1,23,456', 'Revenue 1,23,456, FY 2024-25'), true);
  });

  it('requires unit text that says the same as the stated unit', () => {
    assert.equal(unitTextSupports('lakh', '(Rs. in lakhs)'), true);
    assert.equal(unitTextSupports('lakh', 'Rs. in Lacs'), true);
    assert.equal(unitTextSupports('thousand', "Rs. '000"), true);
    assert.equal(unitTextSupports('thousand', 'Rs. ’000'), true);
    assert.equal(unitTextSupports('rupees', 'Amounts in ₹'), true);
    assert.equal(unitTextSupports('crore', '(Rs. in lakhs)'), false);
    assert.equal(unitTextSupports('rupees', '(Rs. in lakhs)'), false);
    assert.equal(unitTextSupports('lakh', null), false);
    assert.equal(unitTextSupports('lakh', 'See note 4'), false);
  });

  it('spots non-INR units without tripping on Indian abbreviations', () => {
    assert.equal(hasForeignUnit('Amounts in USD thousands'), true);
    assert.equal(hasForeignUnit('Figures in US Dollars'), true);
    assert.equal(hasForeignUnit('Amount € 500'), true);
    assert.equal(hasForeignUnit('(Rs. in lakhs)'), false);
    assert.equal(hasForeignUnit('Aud. report, Sar Traders'), false);
  });
});

describe('snippet tokens keep the decimal point (contract 4.2)', () => {
  it('does not find 1.25 in 12.5', () => {
    assert.equal(rawValueInSnippet('1.25', 'Revenue 12.5', 'number'), false);
    assert.equal(rawValueInSnippet('12.50', 'Revenue 12.5', 'number'), true);
    assert.equal(rawValueInSnippet('1,250.00', 'Revenue 1250', 'number'), true);
  });
});

describe('loss wording (contract 4.2)', () => {
  it('finds loss, deficit, negative and similar', () => {
    for (const text of ['Loss for the year', 'Net losses', 'Deficit', 'negative net worth', 'Shortfall']) {
      assert.equal(hasLossWording(text), true, text);
    }
    assert.equal(hasLossWording('Profit / (Loss) after tax'), false);
    assert.equal(hasLossWording('(Loss)/Profit before tax'), false);
  });

  it('finds a figure printed bracketed or minus-signed, and nothing else', () => {
    for (const text of ['(12.50)', '( 12,50,000 )', '(Rs. 12.50)', '(12.50 Cr)', '-1250000', '- 12.50', '12.50-', '₹ -5', '8.40 (.50)', 'Rs.-12']) {
      assert.equal(hasNegativeFigure(text), true, text);
    }
    for (const text of ['(Loss)', 'Profit / (Loss) 12.50', '12,500/-', 'FY 2024-25', '2024 - 25', '31-03-2025', 'A-12', "(Rs. in '000)", 'Nil -']) {
      assert.equal(hasNegativeFigure(text), false, text);
    }
  });

  it('exempts the neutral label only while no figure beside it is negative', () => {
    assert.equal(positiveValueDoubted('Profit / (Loss) after tax 8.40', null), false);
    assert.equal(positiveValueDoubted('Profit / (Loss) after tax (12.50) 8.40', null), true);
    assert.equal(positiveValueDoubted('Profit / (Loss) after tax 8.40', 'negative_in_row'), true);
    assert.equal(positiveValueDoubted('Net profit 8.40', 'negative_in_row'), false);
    assert.equal(positiveValueDoubted('Net profit 8.40', 'negative_figure'), true);
    assert.equal(positiveValueDoubted('Net profit (12) 8.40', null), false);
    assert.equal(positiveValueDoubted('Loss for the year 8.40', null), true);
    // The pattern is global: a second call on the same text must see it too.
    assert.equal(positiveValueDoubted('Profit / (Loss) (1.00)', null), true);
    assert.equal(positiveValueDoubted('Profit / (Loss) (1.00)', null), true);
  });

  it('ignores the name of the statement, and plain profit rows', () => {
    assert.equal(hasLossWording('Statement of Profit and Loss: Profit after tax'), false);
    assert.equal(hasLossWording('Profit & Loss Account: Net profit'), false);
    assert.equal(hasLossWording('Glossary of profit after tax'), false);
  });
});

describe('part-year periods (contract 4.3)', () => {
  it('finds part-year wording', () => {
    for (const text of [
      'Six months ended 30 September 2024',
      '9 months ended 31 December 2024',
      'Half year ended',
      'Q2 FY 2024-25',
      'H1 FY25',
      'YTD revenue',
      'Quarter ended 31 March 2025',
      'Period ended 30 June 2024',
      'April to September 2024',
    ]) {
      assert.equal(hasPartYearWording(text), true, text);
    }
  });

  it('leaves full-year wording alone', () => {
    for (const text of ['Year ended 31 March 2025', '12 months ended 31 March 2025', 'Revenue from operations', 'April to March']) {
      assert.equal(hasPartYearWording(text), false, text);
    }
  });

  it('never turns part-year period text into a financial year label', () => {
    for (const raw of ['Six months ended 31 March 2025', '01/04/2024 to 30/09/2024', 'Q4 FY 2024-25', 'Quarter ended 31 March 2025']) {
      assert.equal(normalizePeriod(raw, TODAY), null, raw);
    }
    assert.equal(normalizePeriod('30/09/2024', TODAY), '2024-09-30');
    assert.equal(normalizePeriod('31/03/2025', TODAY), 'FY 2024-25');
  });
});

describe('enum evidence (contract 4.2)', () => {
  const entityType = getFieldDefinition('entityType')!;

  it('matches keywords per option, through the usual name normalisation', () => {
    assert.ok(findEnumEvidence(entityType, 'private_limited', 'Sample Traders Pvt. Ltd.').length > 0);
    assert.ok(findEnumEvidence(entityType, 'llp', 'Limited Liability Partnership Agreement').length > 0);
    assert.equal(findEnumEvidence(entityType, 'public_limited', 'Sample Traders Pvt. Ltd.').length, 0);
  });

  it('does not take a limited liability partnership as a partnership', () => {
    assert.equal(findEnumEvidence(entityType, 'partnership', 'Limited Liability Partnership').length, 0);
    assert.ok(findEnumEvidence(entityType, 'partnership', 'Partnership Deed').length > 0);
  });

  it('does not take unaudited as audited', () => {
    const dataSource = getFieldDefinition('financialProfile.dataSource')!;
    assert.equal(findEnumEvidence(dataSource, 'audited', 'Unaudited accounts').length, 0);
    assert.equal(findEnumEvidence(dataSource, 'audited', 'Un-audited accounts').length, 0);
    assert.ok(findEnumEvidence(dataSource, 'audited', 'Audited accounts').length > 0);
  });
});

describe('source verifier (contract 4.2, 12)', () => {
  const query = (overrides: Partial<SourceQuery>): SourceQuery => ({
    valueType: 'number',
    rawValue: '12,50,000',
    value: 1250000,
    snippet: 'Revenue 12,50,000',
    unitText: null,
    sheetName: null,
    cellRef: null,
    inlineUnit: null,
    creditMarker: false,
    evidence: [],
    wantRowLabel: false,
    ...overrides,
  });

  describe('cells', () => {
    const verify = createSourceVerifier({
      kind: 'cells',
      rows: [
        { sheetName: 'P&L', cells: [{ ref: 'A2', text: 'Revenue' }, { ref: 'B2', text: '1250000' }] },
        { sheetName: 'P&L', cells: [{ ref: 'A3', text: 'Loss for the year' }, { ref: 'B3', text: '300000' }] },
        { sheetName: 'P&L', cells: [{ ref: 'A1', text: '(Rs. in lakhs)' }, { ref: 'B1', text: '2.5 Lakh' }] },
      ],
    });

    it('finds the raw value in a parsed cell, whatever its grouping', () => {
      assert.equal(verify(query({})).check, 'verified');
    });

    it('fails a value in no cell, whatever the snippet says', () => {
      assert.equal(verify(query({ rawValue: '99,00,000', snippet: 'Revenue 99,00,000' })).check, 'failed');
    });

    it('prefers the cited cell, and still needs the value somewhere visible', () => {
      assert.equal(verify(query({ cellRef: 'B2' })).check, 'verified');
      assert.equal(verify(query({ cellRef: 'B3' })).check, 'verified');
      assert.equal(verify(query({ rawValue: '99,00,000', cellRef: 'B2' })).check, 'failed');
    });

    it('returns the row of the value, so a label the model left out still counts', () => {
      const finding = verify(query({ rawValue: '3,00,000', snippet: '3,00,000', wantRowLabel: true }));
      assert.match(finding.rowLabel ?? '', /Loss for the year/);
    });

    it('reads the sign of the cell holding the value, and of the rest of its row', () => {
      const signed = createSourceVerifier({
        kind: 'cells',
        rows: [{ sheetName: 'P&L', cells: [{ ref: 'A5', text: 'Profit / (Loss)' }, { ref: 'B5', text: '-1250000' }, { ref: 'C5', text: '840000' }] }],
      });
      const atValue = signed(query({ rawValue: '12,50,000', wantRowLabel: true }));
      assert.equal(atValue.sourceSign, 'negative_figure');
      assert.match(atValue.rowLabel ?? '', /-1250000/);
      const besideValue = signed(query({ rawValue: '8,40,000', snippet: '8,40,000', wantRowLabel: true }));
      assert.equal(besideValue.sourceSign, 'negative_in_row');
      assert.equal(verify(query({ wantRowLabel: true })).sourceSign, null);
    });

    it('checks unit text against the cells', () => {
      assert.equal(verify(query({ unitText: 'Rs. in lakhs' })).check, 'verified');
      assert.equal(verify(query({ unitText: 'Rs. in crores' })).check, 'failed');
    });

    it('fails a unit that differs from the unit in the cell', () => {
      assert.equal(verify(query({ rawValue: '2.5 Cr', inlineUnit: 'crore' })).check, 'failed');
      assert.equal(verify(query({ rawValue: '2.5 Lakh', inlineUnit: 'lakh' })).check, 'verified');
    });

    it('checks strings, and matches a normalised date', () => {
      const dates = createSourceVerifier({ kind: 'cells', rows: [{ sheetName: 'S', cells: [{ ref: 'A1', text: '2019-04-01' }] }] });
      assert.equal(dates(query({ valueType: 'string', rawValue: '01/04/2019', value: '2019-04-01' })).check, 'verified');
      assert.equal(dates(query({ valueType: 'string', rawValue: 'Invented Ltd', value: 'Invented Ltd' })).check, 'failed');
    });

    it('checks enum evidence against the cells', () => {
      assert.equal(verify(query({ valueType: 'enum', value: 'llp', evidence: ['llp'] })).check, 'failed');
      assert.equal(verify(query({ valueType: 'enum', value: 'llp', evidence: ['revenue'] })).check, 'verified');
    });
  });

  describe('PDF text layer', () => {
    const verify = createSourceVerifier({
      kind: 'pdf',
      lines: ['ABC TRADERS PRIVATE', 'LIMITED', 'Rs. in lakhs', 'Revenue from operations 12,50,000', 'Loss for the year 3,00,000', 'Turnover 2.5 Lakh'],
    });

    it('verifies when the digits of the snippet are all in the text', () => {
      assert.equal(verify(query({})).check, 'verified');
    });

    it('fails an invented snippet, even when rawValue is real', () => {
      assert.equal(verify(query({ snippet: 'Revenue 12,50,000 FY 1999' })).check, 'failed');
      assert.equal(verify(query({ rawValue: '77,00,000', snippet: 'Revenue 77,00,000' })).check, 'failed');
    });

    it('verifies strings across a line break, and fails an invented name', () => {
      const name = (rawValue: string) => query({ valueType: 'string', rawValue, value: rawValue, snippet: rawValue });
      assert.equal(verify(name('ABC Traders Private Limited')).check, 'verified');
      assert.equal(verify(name('XYZ Traders Private Limited')).check, 'failed');
    });

    it('verifies unit text the same way', () => {
      assert.equal(verify(query({ unitText: 'Rs. in lakhs' })).check, 'verified');
      assert.equal(verify(query({ unitText: 'Rs. in crores' })).check, 'failed');
    });

    it('fails a unit that differs from the one printed beside the figure', () => {
      assert.equal(verify(query({ rawValue: '2.5 Cr', snippet: '2.5 Cr', inlineUnit: 'crore' })).check, 'failed');
      assert.equal(verify(query({ rawValue: '2.5 Lakh', snippet: '2.5 Lakh', inlineUnit: 'lakh' })).check, 'verified');
    });

    it('reports a negative figure on the printed line', () => {
      const signed = createSourceVerifier({ kind: 'pdf', lines: ['Profit / (Loss) after tax (12.50) 8.40', 'Revenue 90.25'] });
      const finding = signed(query({ rawValue: '8.40', snippet: '8.40', wantRowLabel: true }));
      assert.equal(finding.sourceSign, 'negative_in_row');
      assert.equal(signed(query({ rawValue: '90.25', snippet: '90.25', wantRowLabel: true })).sourceSign, null);
    });

    it('checks a large document without rescanning it per candidate', () => {
      const lines = Array.from({ length: 20_000 }, (_, n) => `Row ${n} amount ${n + 100000}`);
      const large = createSourceVerifier({ kind: 'pdf', lines });
      for (let n = 0; n < 20_000; n += 1) {
        const rawValue = String(n + 100000);
        assert.equal(large(query({ rawValue, snippet: rawValue })).check, 'verified');
      }
    });

    it('returns the printed line as the row label', () => {
      const finding = verify(query({ rawValue: '3,00,000', snippet: '3,00,000', wantRowLabel: true }));
      assert.match(finding.rowLabel ?? '', /Loss for the year/);
    });
  });

  it('has nothing to check for a scan or an image', () => {
    assert.equal(createSourceVerifier({ kind: 'no_text' })(query({})).check, 'no_text');
  });

  it('fails closed on a PDF the parser could not read', () => {
    assert.equal(createSourceVerifier({ kind: 'unreadable' })(query({})).check, 'failed');
  });
});

describe('prompt rules', () => {
  const instruction = buildExtractionInstruction('financial_statement');

  it('asks for the unit header verbatim, in the schema as well', () => {
    assert.match(instruction, /unitText is that header quoted verbatim/);
    const items = EXTRACTION_SCHEMA.properties?.fields.items;
    assert.ok(items?.properties?.unitText);
    assert.ok(EXTRACTION_SCHEMA.properties?.bankMonthlyTotals.items?.properties?.unitText);
  });

  it('states the loss and part-year rules', () => {
    assert.match(instruction, /Never present a loss as a profit/);
    assert.match(instruction, /never label it FY/);
  });

  it('reads unitText from a response', () => {
    const parsed = parseExtractionResponse(JSON.stringify({
      readable: true,
      suspiciousInstructions: false,
      fields: [{ fieldId: 'x', rawValue: '1', confidence: 0.9, snippet: '1', unitText: '(Rs. in lakhs)' }],
      bankMonthlyTotals: [],
    }));
    assert.equal(parsed?.fields[0]?.unitText, '(Rs. in lakhs)');
  });
});

describe('Gemini retries (contract 2)', () => {
  const apiError = (status: number) => Object.assign(new Error('provider text'), { status });
  const noWait = async () => {};

  it('makes the SDK do no retries of its own', () => {
    assert.equal(GEMINI_HTTP_OPTIONS.retryOptions.attempts, 1);
  });

  it('caps backoff, grows it exponentially, and jitters it', () => {
    assert.deepEqual([1, 2, 3, 4, 9].map((n) => backoffDelayMs(n, () => 0)), [1000, 2000, 4000, 4000, 4000]);
    assert.deepEqual([1, 2, 3, 4].map((n) => backoffDelayMs(n, () => 1)), [2000, 4000, 8000, 8000]);
  });

  it('retries 429 and 503 until one succeeds, waiting between attempts', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await callWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw apiError(429);
        if (calls === 2) throw apiError(503);
        return 'ok';
      },
      new AbortController().signal,
      { sleep: async (delay) => void delays.push(delay), random: () => 0 }
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [1000, 2000]);
  });

  it('gives up with llm_rate_limited, a retryable code, and no provider text', async () => {
    let calls = 0;
    await assert.rejects(
      callWithRetry(async () => { calls += 1; throw apiError(503); }, new AbortController().signal, { sleep: noWait }),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionError);
        assert.equal(error.code, 'llm_rate_limited');
        assert.doesNotMatch(error.message, /provider text/);
        return true;
      }
    );
    assert.equal(calls, 4);
  });

  it('does not retry an error a retry cannot fix', async () => {
    let calls = 0;
    await assert.rejects(
      callWithRetry(async () => { calls += 1; throw apiError(401); }, new AbortController().signal, { sleep: noWait }),
      (error: unknown) => error instanceof ExtractionError && error.code === 'llm_not_configured'
    );
    assert.equal(calls, 1);
  });

  it('times out an attempt that hangs and ignores its signal, then retries it', async () => {
    let calls = 0;
    const result = await callWithRetry(
      (attemptSignal) => {
        calls += 1;
        assert.equal(attemptSignal.aborted, false);
        return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('ok');
      },
      new AbortController().signal,
      { attemptTimeoutMs: 5, sleep: noWait }
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });

  it('reports repeated hangs as llm_timeout, a retryable code', async () => {
    await assert.rejects(
      callWithRetry(() => new Promise<string>(() => {}), new AbortController().signal, {
        attemptTimeoutMs: 5,
        sleep: noWait,
        maxAttempts: 2,
      }),
      (error: unknown) => error instanceof ExtractionError && error.code === 'llm_timeout'
    );
  });

  it('classifies a provider 504 as llm_timeout, and retries it', async () => {
    assert.equal(classifyProviderError(apiError(504)), 'llm_timeout');
    let calls = 0;
    await callWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw apiError(504);
        return 'ok';
      },
      new AbortController().signal,
      { sleep: noWait }
    );
    assert.equal(calls, 2);
  });

  it('rejects at once with an AbortError when the job aborts mid-attempt, and does not retry', async () => {
    const controller = new AbortController();
    let calls = 0;
    const running = callWithRetry(() => {
      calls += 1;
      return new Promise<string>(() => {});
    }, controller.signal);
    controller.abort();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(calls, 1);
  });

  it('stops waiting for a retry when the job aborts', async () => {
    const controller = new AbortController();
    const running = callWithRetry(async () => { throw apiError(503); }, controller.signal, {
      sleep: (_delay, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError')));
          controller.abort();
        }),
    });
    await assert.rejects(running, { name: 'AbortError' });
  });

  it('does not start when the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(callWithRetry(async () => { calls += 1; return 'x'; }, controller.signal), { name: 'AbortError' });
    assert.equal(calls, 0);
  });
});

/** Narrows an ok result for assertions, failing the test with the code if the validator rejected it. */
function okOrThrow<R extends { ok: boolean }>(result: R): Extract<R, { ok: true }> {
  expectOk(result);
  return result as Extract<R, { ok: true }>;
}
