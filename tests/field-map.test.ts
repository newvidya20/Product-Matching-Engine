/**
 * Field map integrity. Contract: docs/contracts.md sections 3, 4.2, 4.5 to 4.7 and 6.
 * Runs against src/documentAi/fieldMap.ts, which is on this branch, so these tests can run now.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DOCUMENT_TYPES, type DocumentType } from '../src/types/documentAi.ts';
import {
  DIRECT_FIELDS,
  FIELD_DEFINITIONS,
  FIELD_MAP,
  FINANCIAL_FIELDS_NEEDING_INPUT,
  FUNDING_PURPOSE_VALUES,
  REQUIRED_FIELDS,
  dynamicFieldsForPurpose,
  directFieldsForDocumentType,
  getFieldDefinition,
  parseNumericInput,
  toFormValue,
  type FieldDefinition,
} from '../src/documentAi/fieldMap.ts';

const KNOWN_DERIVATIONS = [
  'vintage_from_establishment_date',
  'profitability_from_pat',
  'average_monthly_from_bank_table',
  'gst_compliance_mirror',
];

const fid = (definition: FieldDefinition) => definition.fieldId;

function byId(fieldId: string): FieldDefinition {
  const definition = getFieldDefinition(fieldId);
  assert.ok(definition, `expected ${fieldId} in the field map`);
  return definition;
}

describe('field IDs and lookup', () => {
  it('has unique field IDs', () => {
    const ids = FIELD_DEFINITIONS.map(fid);
    assert.equal(new Set(ids).size, ids.length, 'duplicate field IDs');
  });

  it('indexes every definition in FIELD_MAP and getFieldDefinition', () => {
    assert.equal(Object.keys(FIELD_MAP).length, FIELD_DEFINITIONS.length);
    for (const definition of FIELD_DEFINITIONS) {
      assert.equal(getFieldDefinition(definition.fieldId), definition);
    }
  });

  it('does not resolve prototype keys as fields', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(getFieldDefinition(key), undefined, `${key} must not resolve`);
    }
  });

  it('keeps FIELD_MAP frozen', () => {
    assert.ok(Object.isFrozen(FIELD_MAP));
  });

  it('gives every field a valid section, a label, and a well-formed ID', () => {
    for (const definition of FIELD_DEFINITIONS) {
      assert.ok(['01', '02', '03', '04', '05'].includes(definition.section), definition.fieldId);
      assert.ok(definition.label.trim().length > 0, `${definition.fieldId} has no label`);
      assert.match(definition.fieldId, /^[A-Za-z][A-Za-z0-9_.]*$/, `${definition.fieldId} is not a valid ID`);
    }
  });

  it('has unique form targets, so two fields never write the same form key', () => {
    const keys = FIELD_DEFINITIONS.filter((d) => d.target.kind === 'form').map((d) => d.target.key);
    assert.equal(new Set(keys).size, keys.length, 'duplicate form target keys');
  });

  it('names financial targets after their key: financialProfile.<key>', () => {
    for (const definition of FIELD_DEFINITIONS.filter((d) => d.target.kind === 'financial')) {
      const key = definition.target.kind === 'financial' ? definition.target.key : '';
      assert.equal(definition.fieldId, `financialProfile.${key}`, definition.fieldId);
    }
  });

  it('names dynamic answers after their purpose and key', () => {
    for (const definition of FIELD_DEFINITIONS.filter((d) => d.target.kind === 'dynamic')) {
      if (definition.target.kind !== 'dynamic') continue;
      const { purpose, key } = definition.target;
      assert.equal(definition.fieldId, `dynamicPurposeAnswers.${purpose}.${key}`);
    }
  });

  it('has dynamic questions for every funding purpose', () => {
    for (const purpose of FUNDING_PURPOSE_VALUES) {
      assert.ok(dynamicFieldsForPurpose(purpose).length > 0, `no dynamic fields for ${purpose}`);
    }
  });
});

describe('document types', () => {
  it('has unique document types', () => {
    assert.equal(new Set(DOCUMENT_TYPES).size, DOCUMENT_TYPES.length);
  });

  it('lists only valid document types as sources', () => {
    for (const definition of FIELD_DEFINITIONS) {
      for (const source of definition.sourceDocumentTypes) {
        assert.ok(
          (DOCUMENT_TYPES as readonly string[]).includes(source),
          `${definition.fieldId} lists unknown document type ${source}`
        );
      }
    }
  });

  it('never takes bank statement credits as turnover (contract 4.4)', () => {
    for (const fieldId of ['financialProfile.annualRevenue', 'annualTurnoverOrIncome', 'financialProfile.gstAnnualTurnover']) {
      assert.ok(!byId(fieldId).sourceDocumentTypes.includes('bank_statement'), `${fieldId} must not use bank_statement`);
    }
  });

  it('never takes a CMA projection as a historical figure (contract 4.4)', () => {
    for (const definition of FIELD_DEFINITIONS.filter((d) => d.fieldId.startsWith('financialProfile.'))) {
      assert.ok(
        !definition.sourceDocumentTypes.includes('cma_projection'),
        `${definition.fieldId} must not use cma_projection`
      );
    }
  });

  it('never lets an existing sanction letter supply requestedAmount (contract 4.2)', () => {
    assert.ok(!byId('requestedAmount').sourceDocumentTypes.includes('existing_sanction_letter'));
  });

  it('keeps the explicit-request fields to a borrower request, never inferred sources (contract 4.2)', () => {
    const inferenceOnly: DocumentType[] = [
      'existing_sanction_letter',
      'bank_statement',
      'gst_return',
      'gst_certificate',
      'financial_statement',
      'itr',
      'pan_card',
    ];
    const explicit = FIELD_DEFINITIONS.filter((d) => d.policy === 'explicit_request');
    assert.ok(explicit.length > 0);
    for (const definition of explicit) {
      for (const banned of inferenceOnly) {
        assert.ok(
          !definition.sourceDocumentTypes.includes(banned),
          `${definition.fieldId} is explicit_request but lists ${banned}`
        );
      }
    }
  });

  it('marks exactly the contract explicit_request fields outside the dynamic group', () => {
    const outsideDynamic = FIELD_DEFINITIONS.filter((d) => d.policy === 'explicit_request' && d.target.kind !== 'dynamic')
      .map(fid)
      .sort();
    assert.deepEqual(outsideDynamic, ['fundingPurpose', 'requestedAmount', 'requestedTenureMonths', 'statedPurpose']);
  });

  it('maps only the document types each field can use in directFieldsForDocumentType', () => {
    for (const documentType of DOCUMENT_TYPES) {
      for (const definition of directFieldsForDocumentType(documentType)) {
        assert.ok(definition.sourceDocumentTypes.includes(documentType));
        assert.equal(definition.extractionMode, 'direct');
      }
    }
  });
});

describe('extraction modes and non-extractable fields (contract 4.2, section 4.5)', () => {
  it('marks a field non-extractable exactly when its mode is none', () => {
    for (const definition of FIELD_DEFINITIONS) {
      assert.equal(definition.extractable, definition.extractionMode !== 'none', definition.fieldId);
    }
  });

  it('gives every non-extractable field a reason and no document sources', () => {
    const nonExtractable = FIELD_DEFINITIONS.filter((d) => !d.extractable);
    assert.ok(nonExtractable.length > 0);
    for (const definition of nonExtractable) {
      assert.equal(definition.extractionMode, 'none', definition.fieldId);
      assert.ok(definition.notExtractableReason && definition.notExtractableReason.trim().length > 0, `${definition.fieldId} has no reason`);
      assert.deepEqual(definition.sourceDocumentTypes, [], `${definition.fieldId} must have no sources`);
    }
  });

  it('marks the internal and user-owned fields non-extractable', () => {
    for (const fieldId of [
      'assignedOfficer',
      'branchOrDesk',
      'isFictionalDemo',
      'currency',
      'advisorNotes',
      'customAttributes',
    ]) {
      const definition = byId(fieldId);
      assert.equal(definition.extractable, false, `${fieldId} must not be extractable`);
      assert.equal(definition.extractionMode, 'none');
    }
  });

  it('marks every ratio as non-extractable with the computed-on-save reason', () => {
    const ratios = FIELD_DEFINITIONS.filter((d) => d.fieldId.startsWith('financialProfile.ratios.'));
    assert.ok(ratios.length > 0);
    for (const definition of ratios) {
      assert.equal(definition.extractable, false, definition.fieldId);
      assert.match(definition.notExtractableReason ?? '', /calculateFinancialRatios/);
    }
  });

  it('never asks the model for mirror or derived fields: DIRECT_FIELDS is direct only', () => {
    assert.ok(DIRECT_FIELDS.length > 0);
    for (const definition of DIRECT_FIELDS) {
      assert.equal(definition.extractionMode, 'direct', definition.fieldId);
    }
    const notDirect = FIELD_DEFINITIONS.filter((d) => d.extractionMode !== 'direct').map(fid);
    for (const fieldId of notDirect) {
      assert.ok(!DIRECT_FIELDS.some((d) => d.fieldId === fieldId), `${fieldId} must not be direct`);
    }
  });

  it('gives every derived field a server derivation rule', () => {
    for (const definition of FIELD_DEFINITIONS.filter((d) => d.extractionMode === 'derived')) {
      assert.ok(definition.derivation, `${definition.fieldId} is derived but has no rule`);
    }
  });

  it('uses only known derivation rules', () => {
    for (const definition of FIELD_DEFINITIONS) {
      if (definition.derivation !== undefined) {
        assert.ok(KNOWN_DERIVATIONS.includes(definition.derivation), `${definition.fieldId} uses unknown rule`);
      }
    }
  });
});

describe('mirrors and fallbacks (contract 4.5)', () => {
  it('matches the documented mirror table', () => {
    const table: Array<[string, string, string | undefined]> = [
      ['annualTurnoverOrIncome', 'financialProfile.annualRevenue', 'financialProfile.gstAnnualTurnover'],
      ['creditScore', 'financialProfile.personalCibilScore', 'financialProfile.promoterCibilScore'],
      ['existingEmiObligations', 'financialProfile.existingMonthlyEmi', undefined],
    ];
    for (const [mirrorId, primary, fallback] of table) {
      const mirror = byId(mirrorId);
      assert.equal(mirror.extractionMode, 'mirror', `${mirrorId} must be a mirror`);
      assert.equal(mirror.mirrorOf, primary, `${mirrorId} primary`);
      if (fallback === undefined) {
        assert.equal(mirror.mirrorFallbacks, undefined, `${mirrorId} has no fallback`);
      } else {
        assert.deepEqual(mirror.mirrorFallbacks, [fallback], `${mirrorId} fallback`);
      }
    }
  });

  it('points every mirror at a primary that exists and is asked of the model', () => {
    for (const mirror of FIELD_DEFINITIONS.filter((d) => d.extractionMode === 'mirror')) {
      assert.ok(mirror.mirrorOf, `${mirror.fieldId} has no primary`);
      const primary = byId(mirror.mirrorOf!);
      assert.equal(primary.extractionMode, 'direct', `${mirror.mirrorOf} must be direct`);
      for (const fallback of mirror.mirrorFallbacks ?? []) {
        assert.equal(byId(fallback).extractionMode, 'direct', `${fallback} must be direct`);
      }
    }
  });

  it('keeps commercial CMR rank out of creditScore', () => {
    const creditScore = byId('creditScore');
    assert.notEqual(creditScore.mirrorOf, 'financialProfile.commercialCmrRank');
    assert.ok(!(creditScore.mirrorFallbacks ?? []).includes('financialProfile.commercialCmrRank'));
  });

  it('maps GST compliance to gstTaxCompliant through the mirror rule', () => {
    const gst = byId('gstTaxCompliant');
    assert.equal(gst.derivation, 'gst_compliance_mirror');
    assert.equal(gst.defaultValue, 'not_provided');
  });
});

describe('enum options (contract 3 and 6)', () => {
  it('declares options for enum fields and none for other types', () => {
    for (const definition of FIELD_DEFINITIONS) {
      if (definition.valueType === 'enum') {
        assert.ok(definition.allowedValues.length > 0, `${definition.fieldId} is an enum with no options`);
      } else {
        assert.equal(definition.allowedValues.length, 0, `${definition.fieldId} is not an enum but has options`);
      }
    }
  });

  it('has unique, non-blank options', () => {
    for (const definition of FIELD_DEFINITIONS) {
      const options = definition.allowedValues;
      assert.equal(new Set(options).size, options.length, `${definition.fieldId} repeats an option`);
      for (const option of options) {
        assert.ok(option.trim().length > 0, `${definition.fieldId} has a blank option`);
      }
    }
  });

  it('has a default in the options for every non-dynamic enum that sets one', () => {
    for (const definition of FIELD_DEFINITIONS) {
      if (definition.valueType !== 'enum' || definition.target.kind === 'dynamic') continue;
      if (!definition.defaultValue) continue;
      assert.ok(
        definition.allowedValues.includes(definition.defaultValue),
        `${definition.fieldId} default ${definition.defaultValue} is not an option`
      );
    }
  });

  it('lists the funding purposes once each', () => {
    assert.equal(new Set(FUNDING_PURPOSE_VALUES).size, FUNDING_PURPOSE_VALUES.length);
    assert.equal(FUNDING_PURPOSE_VALUES.length, 8);
  });

  it('gives the non-extractable isFictionalDemo only true and false', () => {
    assert.deepEqual([...byId('isFictionalDemo').allowedValues], ['true', 'false']);
  });
});

describe('enum evidence and review (contract 4.2)', () => {
  const alwaysReviewed = (d: FieldDefinition) => d.policy === 'explicit_request' || d.alwaysReview === true;

  it('always reviews GST compliance and every explicit request enum', () => {
    assert.equal(byId('financialProfile.gstComplianceStatus').alwaysReview, true);
    assert.equal(byId('fundingPurpose').policy, 'explicit_request');
  });

  it('defines evidence for every option that can auto-apply, and for those enums only', () => {
    for (const definition of DIRECT_FIELDS.filter((d) => d.valueType === 'enum')) {
      if (alwaysReviewed(definition)) {
        assert.equal(definition.enumEvidence, undefined, `${definition.fieldId} is always reviewed`);
        continue;
      }
      const reachable = definition.allowedValues.filter(
        (option) =>
          option !== 'not_provided' &&
          (definition.policy !== 'positive_only' || option === 'yes' || option === 'available')
      );
      assert.ok(reachable.length > 0, definition.fieldId);
      for (const option of reachable) {
        assert.ok(definition.enumEvidence?.[option]?.any.length, `${definition.fieldId} ${option} has no evidence`);
      }
    }
  });

  it('keys evidence by real options', () => {
    for (const definition of FIELD_DEFINITIONS) {
      for (const option of Object.keys(definition.enumEvidence ?? {})) {
        assert.ok(definition.allowedValues.includes(option), `${definition.fieldId} ${option}`);
      }
    }
  });
});

describe('collateral evidence (contract 4.2)', () => {
  const evidence = getFieldDefinition('collateralAvailable')?.enumEvidence?.yes;

  it('lists a stated answer of no as a denial', () => {
    for (const phrase of ['collateral offered no', 'security offered nil']) {
      assert.ok(evidence?.none?.includes(phrase), phrase);
    }
  });

  it('lists the denials of collateral that cancel its keywords', () => {
    for (const phrase of ['no collateral', 'no security', 'without collateral', 'collateral free', 'unsecured']) {
      assert.ok(evidence?.none?.includes(phrase), phrase);
    }
  });

  it('keeps no denial among the keywords', () => {
    for (const phrase of evidence?.none ?? []) assert.ok(!evidence?.any.includes(phrase), phrase);
  });
});

describe('annual flow fields (contract 4.3)', () => {
  it('marks exactly the fields that cover a whole year', () => {
    const actual = FIELD_DEFINITIONS.filter((d) => d.annualFlow).map(fid).sort();
    assert.deepEqual(actual, [
      'financialProfile.amortization',
      'financialProfile.annualRevenue',
      'financialProfile.annualScheduledPrincipalRepayments',
      'financialProfile.depreciation',
      'financialProfile.ebit',
      'financialProfile.ebitda',
      'financialProfile.gstAnnualTurnover',
      'financialProfile.interestExpense',
      'financialProfile.netProfitAfterTax',
      'financialProfile.operatingCashFlow',
      'financialProfile.previousAnnualRevenue',
    ]);
  });

  it('keeps balance-sheet fields point-in-time', () => {
    for (const key of ['currentAssets', 'currentLiabilities', 'totalAssets', 'tangibleNetWorth', 'shareholdersEquity']) {
      assert.equal(byId(`financialProfile.${key}`).annualFlow, undefined, key);
    }
  });
});

describe('numeric rules and signs (contract 4.6, 4.7)', () => {
  const signed = [
    'financialProfile.netProfitAfterTax',
    'financialProfile.ebitda',
    'financialProfile.ebit',
    'financialProfile.tangibleNetWorth',
    'financialProfile.shareholdersEquity',
    'financialProfile.operatingCashFlow',
    'financialProfile.averageMonthlyBankingBalance',
  ];
  const expenseMagnitude = [
    'financialProfile.depreciation',
    'financialProfile.amortization',
    'financialProfile.interestExpense',
  ];

  it('marks exactly the contract signed fields as signed', () => {
    const actual = FIELD_DEFINITIONS.filter((d) => d.signPolicy === 'signed').map(fid).sort();
    assert.deepEqual(actual, [...signed].sort());
  });

  it('marks exactly the contract expense fields as expense_magnitude', () => {
    const actual = FIELD_DEFINITIONS.filter((d) => d.signPolicy === 'expense_magnitude').map(fid).sort();
    assert.deepEqual(actual, [...expenseMagnitude].sort());
  });

  it('gives signed fields no minimum of zero, so a loss can be entered', () => {
    for (const fieldId of signed) {
      assert.notEqual(byId(fieldId).min, 0, `${fieldId} must not declare min 0`);
    }
  });

  it('gives every currency field a sign policy', () => {
    for (const definition of FIELD_DEFINITIONS.filter((d) => d.unit === 'currency')) {
      assert.ok(definition.signPolicy, `${definition.fieldId} has no signPolicy`);
    }
  });

  it('has min no greater than max wherever both are set', () => {
    for (const definition of FIELD_DEFINITIONS) {
      if (definition.min !== undefined && definition.max !== undefined) {
        assert.ok(definition.min <= definition.max, `${definition.fieldId} has min above max`);
      }
    }
  });

  it('keeps the CIBIL-style scores in the 300 to 900 range', () => {
    for (const fieldId of ['creditScore', 'financialProfile.personalCibilScore', 'financialProfile.promoterCibilScore']) {
      const definition = byId(fieldId);
      assert.equal(definition.min, 300, fieldId);
      assert.equal(definition.max, 900, fieldId);
    }
  });

  it('sets the borrower request defaults from contract 4.6', () => {
    assert.equal(byId('requestedTenureMonths').defaultValue, '36');
    assert.equal(byId('fundingPurpose').defaultValue, 'working_capital');
  });
});

describe('required fields and inputs (contract 4.6, section 8)', () => {
  it('requires exactly the four borrower-request and identity fields', () => {
    const ids = REQUIRED_FIELDS.map(fid).sort();
    assert.deepEqual(ids, ['applicantLabel', 'fundingPurpose', 'requestedAmount', 'requestedTenureMonths']);
  });

  it('lists 18 financial inputs missing from the form', () => {
    assert.equal(FINANCIAL_FIELDS_NEEDING_INPUT.length, 18);
    for (const definition of FINANCIAL_FIELDS_NEEDING_INPUT) {
      assert.equal(definition.target.kind, 'financial', definition.fieldId);
      assert.equal(definition.hasVisibleInput, false, definition.fieldId);
    }
  });
});

describe('form helpers', () => {
  it('parses numeric input, keeping 0 and returning null for blank or junk', () => {
    assert.equal(parseNumericInput(0), 0);
    assert.equal(parseNumericInput('0'), 0);
    assert.equal(parseNumericInput('-1250.5'), -1250.5);
    assert.equal(parseNumericInput(''), null);
    assert.equal(parseNumericInput('   '), null);
    assert.equal(parseNumericInput(null), null);
    assert.equal(parseNumericInput(undefined), null);
    assert.equal(parseNumericInput('abc'), null);
    assert.equal(parseNumericInput('Infinity'), null);
    assert.equal(parseNumericInput('12,50,000'), null);
  });

  it('formats dynamic days, percent and count values the way the form stores them', () => {
    assert.equal(toFormValue(byId('dynamicPurposeAnswers.working_capital.receivableDays'), 45), '45 Days');
    assert.equal(toFormValue(byId('dynamicPurposeAnswers.machinery_equipment.borrowerMarginPercent'), 20), '20%');
    assert.equal(toFormValue(byId('dynamicPurposeAnswers.debt_consolidation.existingLenderCount'), 3), '3 Facilities');
  });

  it('formats non-dynamic values as plain strings, keeping zero', () => {
    assert.equal(toFormValue(byId('financialProfile.annualRevenue'), 0), '0');
    assert.equal(toFormValue(byId('businessVintageYears'), 3), '3');
  });
});
