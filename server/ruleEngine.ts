import type {
  BaselineOutcome,
  BorrowerAssessment,
  CategoryEvaluationResult,
  ConfigurableRuleField,
  EligibilityStatus,
  MatchingEvaluationRecord,
  ProductCategory,
  ProductDocumentRecord,
  RankedSubProductMatch,
  RuleCheckDetail,
  SubProduct,
  SubProductEvaluationResult,
} from '../src/types/domain.ts';
import { calculateFinancialRatios } from '../src/utils/financialMetrics';

function formatCurrency(val: number, currency: string): string {
  return `${currency} ${val.toLocaleString('en-IN')}`;
}

const FIELD_LABELS: Record<string, string> = {
  requestedAmount: 'Requested Facility Amount',
  requestedTenureMonths: 'Requested Tenure (Months)',
  annualTurnoverOrIncome: 'Annual Business Turnover / Income',
  businessVintageYears: 'Business Vintage (Years)',
  creditScore: 'Credit Bureau Score',
  existingEmiObligations: 'Existing Monthly EMI Obligations',
  profitabilityStatus: 'Profitability Track Record',
  gstTaxCompliant: 'GST / Tax Compliance Status',
  collateralAvailable: 'Collateral Availability',
  collateralValue: 'Estimated Collateral Value',
  entityType: 'Borrower Entity Structure',
  fundingPurpose: 'Funding Purpose',
  industrySector: 'Industry / Business Sector',
};

function evaluateVerifiedRule(
  rule: ConfigurableRuleField,
  assessment: BorrowerAssessment
): { check: RuleCheckDetail; missingFieldLabel?: string } {
  const stage = rule.stage || 'stage2_eligibility';
  const isMandatory = rule.isMandatory !== false;

  const makeMissing = (fieldLabel: string, expectedDesc: string) => ({
    missingFieldLabel: fieldLabel,
    check: {
      ruleId: rule.id,
      stage,
      label: rule.label,
      status: 'missing_data' as const,
      passed: false,
      isMandatory,
      actualSummary: 'Missing / Not Provided',
      expectedSummary: expectedDesc,
    },
  });

  const evalNumeric = (
    actualVal: number | null | undefined,
    fieldName: string,
    isCurrency: boolean,
    treatZeroAsMissing = false
  ) => {
    const expected = Number(rule.expectedValue);
    const expectedStr = isCurrency
      ? formatCurrency(expected, assessment.currency)
      : `${expected}`;
    const opPrefix =
      rule.operator === 'number_min'
        ? '>= '
        : rule.operator === 'number_max'
        ? '<= '
        : '';

    if (
      actualVal === null ||
      actualVal === undefined ||
      Number.isNaN(Number(actualVal)) ||
      (treatZeroAsMissing && Number(actualVal) <= 0)
    ) {
      return makeMissing(fieldName, `${opPrefix}${expectedStr}`);
    }

    const num = Number(actualVal);
    const passed =
      rule.operator === 'number_min'
        ? num >= expected
        : rule.operator === 'number_max'
        ? num <= expected
        : num === expected;

    return {
      check: {
        ruleId: rule.id,
        stage,
        label: rule.label,
        status: passed ? ('passed' as const) : ('failed' as const),
        passed,
        isMandatory,
        actualSummary: isCurrency
          ? formatCurrency(num, assessment.currency)
          : `${num}`,
        expectedSummary: `${opPrefix}${expectedStr}`,
      },
    };
  };

  switch (rule.targetField) {
    case 'requestedAmount':
      return evalNumeric(
        assessment.requestedAmount,
        FIELD_LABELS.requestedAmount,
        true,
        true
      );
    case 'requestedTenureMonths':
      return evalNumeric(
        assessment.requestedTenureMonths,
        FIELD_LABELS.requestedTenureMonths,
        false,
        true
      );
    case 'annualTurnoverOrIncome':
      return evalNumeric(
        assessment.annualTurnoverOrIncome,
        FIELD_LABELS.annualTurnoverOrIncome,
        true,
        true
      );
    case 'businessVintageYears':
      return evalNumeric(
        assessment.businessVintageYears,
        FIELD_LABELS.businessVintageYears,
        false,
        false
      );
    case 'creditScore':
      return evalNumeric(
        assessment.creditScore,
        FIELD_LABELS.creditScore,
        false,
        true
      );
    case 'existingEmiObligations':
      return evalNumeric(
        assessment.existingEmiObligations,
        FIELD_LABELS.existingEmiObligations,
        true,
        false
      );
    case 'collateralValue':
      return evalNumeric(
        assessment.collateralValue,
        FIELD_LABELS.collateralValue,
        true,
        true
      );
    case 'collateralAvailable': {
      const actual = assessment.collateralAvailable;
      const expected =
        rule.expectedValue === true ||
        String(rule.expectedValue).toLowerCase() === 'true';
      const passed = actual === expected;
      return {
        check: {
          ruleId: rule.id,
          stage,
          label: rule.label,
          status: passed ? 'passed' : 'failed',
          passed,
          isMandatory,
          actualSummary: actual ? 'Collateral Available' : 'Unsecured / No Collateral',
          expectedSummary: expected ? 'Collateral Mandatory' : 'Unsecured Permitted',
        },
      };
    }
    case 'gstTaxCompliant': {
      const val = assessment.gstTaxCompliant || 'not_provided';
      if (val === 'not_provided') {
        return makeMissing(FIELD_LABELS.gstTaxCompliant, String(rule.expectedValue));
      }
      const expectedBool =
        String(rule.expectedValue).toLowerCase() === 'true' ||
        String(rule.expectedValue).toLowerCase() === 'yes';
      const actualBool = val === 'yes';
      const passed = actualBool === expectedBool;
      return {
        check: {
          ruleId: rule.id,
          stage,
          label: rule.label,
          status: passed ? 'passed' : 'failed',
          passed,
          isMandatory,
          actualSummary: actualBool ? 'Compliant (Yes)' : 'No',
          expectedSummary: expectedBool ? 'Compliant Required' : 'Optional',
        },
      };
    }
    case 'profitabilityStatus': {
      const val = assessment.profitabilityStatus || 'not_provided';
      if (val === 'not_provided') {
        return makeMissing(
          FIELD_LABELS.profitabilityStatus,
          String(rule.expectedValue)
        );
      }
      const allowed = String(rule.expectedValue)
        .toLowerCase()
        .split(',')
        .map((s) => s.trim());
      const passed =
        rule.operator === 'not_in_list'
          ? !allowed.includes(val.toLowerCase())
          : allowed.includes(val.toLowerCase());
      return {
        check: {
          ruleId: rule.id,
          stage,
          label: rule.label,
          status: passed ? 'passed' : 'failed',
          passed,
          isMandatory,
          actualSummary: val.replace(/_/g, ' '),
          expectedSummary: String(rule.expectedValue).replace(/_/g, ' '),
        },
      };
    }
    case 'entityType':
    case 'fundingPurpose':
    case 'industrySector': {
      const rawActual =
        rule.targetField === 'entityType'
          ? assessment.entityType
          : rule.targetField === 'fundingPurpose'
          ? assessment.fundingPurpose || ''
          : assessment.industrySector || '';

      if (!rawActual.trim()) {
        return makeMissing(
          FIELD_LABELS[rule.targetField] || rule.targetField,
          String(rule.expectedValue)
        );
      }

      const actualNorm = rawActual.toLowerCase().trim();
      const listItems = String(rule.expectedValue)
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      let passed = false;
      if (rule.operator === 'not_in_list') {
        passed = !listItems.some((item) => actualNorm.includes(item));
      } else if (rule.operator === 'in_list') {
        passed = listItems.some(
          (item) => actualNorm === item || actualNorm.includes(item)
        );
      } else {
        passed = actualNorm === String(rule.expectedValue).toLowerCase().trim();
      }

      return {
        check: {
          ruleId: rule.id,
          stage,
          label: rule.label,
          status: passed ? 'passed' : 'failed',
          passed,
          isMandatory,
          actualSummary: rawActual.replace(/_/g, ' '),
          expectedSummary:
            rule.operator === 'not_in_list'
              ? `Excludes: ${rule.expectedValue}`
              : String(rule.expectedValue).replace(/_/g, ' '),
        },
      };
    }
    case 'customAttribute':
    default: {
      const keyName = (rule.customKey || '').trim().toLowerCase();
      const fromCustom = assessment.customAttributes.find(
        (attr) => attr.key.trim().toLowerCase() === keyName
      );
      const fromDynamic = assessment.dynamicPurposeAnswers
        ? Object.entries(assessment.dynamicPurposeAnswers).find(
            ([k]) => k.trim().toLowerCase() === keyName
          )?.[1]
        : undefined;

      const actualVal = (fromCustom?.value || fromDynamic || '').trim();
      if (!actualVal) {
        return makeMissing(
          rule.customKey || rule.label,
          rule.operator === 'custom_Presence'
            ? 'Required input'
            : String(rule.expectedValue)
        );
      }

      const expectedStr = String(rule.expectedValue).trim();
      const passed =
        rule.operator === 'custom_Presence'
          ? actualVal.length > 0
          : rule.operator === 'in_list'
          ? expectedStr
              .toLowerCase()
              .split(',')
              .map((s) => s.trim())
              .includes(actualVal.toLowerCase())
          : actualVal.toLowerCase() === expectedStr.toLowerCase();

      return {
        check: {
          ruleId: rule.id,
          stage,
          label: rule.label,
          status: passed ? 'passed' : 'failed',
          passed,
          isMandatory,
          actualSummary: actualVal,
          expectedSummary:
            rule.operator === 'custom_Presence' ? 'Provided' : expectedStr,
        },
      };
    }
  }
}

function normalizeToken(val: string): string {
  return val.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function checkListSemanticFit(
  configuredList: string[] | undefined,
  borrowerValue: string | undefined
): { matched: boolean; checked: boolean } {
  if (!configuredList || configuredList.length === 0) {
    return { matched: true, checked: false };
  }
  if (!borrowerValue || !borrowerValue.trim()) {
    return { matched: false, checked: true };
  }
  const normBorrower = normalizeToken(borrowerValue);
  const matched = configuredList.some((item) => {
    const normItem = normalizeToken(item);
    return (
      normItem.includes(normBorrower) ||
      normBorrower.includes(normItem) ||
      normItem === 'all' ||
      normItem === 'any'
    );
  });
  return { matched, checked: true };
}

function evaluateFinancialSignals(assessment: BorrowerAssessment): {
  reasons: string[];
  missing: string[];
  failed: string[];
} {
  const profile = assessment.financialProfile;
  if (!profile) {
    return { reasons: [], missing: [], failed: [] };
  }

  const ratios = {
    ...calculateFinancialRatios(profile),
    ...profile.ratios,
  };

  const policyThresholds: Record<
    string,
    {
      dscrMin: number;
      tolTnwMax: number;
      debtEquityMax: number;
      currentRatioMin: number;
      cibilMin: number;
      cmrMax: number;
      revenueGrowthMin?: number;
    }
  > = {
    working_capital: {
      dscrMin: 1.1,
      tolTnwMax: 2.5,
      debtEquityMax: 2.5,
      currentRatioMin: 1.0,
      cibilMin: 650,
      cmrMax: 6,
    },
    machinery_equipment: {
      dscrMin: 1.2,
      tolTnwMax: 2.0,
      debtEquityMax: 1.8,
      currentRatioMin: 1.1,
      cibilMin: 680,
      cmrMax: 5,
    },
    commercial_property: {
      dscrMin: 1.25,
      tolTnwMax: 1.8,
      debtEquityMax: 1.6,
      currentRatioMin: 1.1,
      cibilMin: 680,
      cmrMax: 5,
    },
    invoice_discounting: {
      dscrMin: 1.0,
      tolTnwMax: 2.2,
      debtEquityMax: 1.5,
      currentRatioMin: 1.0,
      cibilMin: 650,
      cmrMax: 6,
      revenueGrowthMin: 0,
    },
    debt_consolidation: {
      dscrMin: 1.0,
      tolTnwMax: 2.0,
      debtEquityMax: 1.8,
      currentRatioMin: 1.0,
      cibilMin: 620,
      cmrMax: 7,
    },
    project_expansion: {
      dscrMin: 1.2,
      tolTnwMax: 1.8,
      debtEquityMax: 1.7,
      currentRatioMin: 1.2,
      cibilMin: 680,
      cmrMax: 5,
    },
    trade_import_export: {
      dscrMin: 1.0,
      tolTnwMax: 2.2,
      debtEquityMax: 1.8,
      currentRatioMin: 1.0,
      cibilMin: 650,
      cmrMax: 6,
      revenueGrowthMin: 0,
    },
    general_business: {
      dscrMin: 1.0,
      tolTnwMax: 2.5,
      debtEquityMax: 2.0,
      currentRatioMin: 1.0,
      cibilMin: 640,
      cmrMax: 7,
    },
  };

  const purposeKey = assessment.fundingPurpose || 'general_business';
  const policy = policyThresholds[purposeKey] || policyThresholds.general_business;
  const purposeLabel = purposeKey.replace(/_/g, ' ');

  const reasons: string[] = [];
  const missing: string[] = [];
  const failed: string[] = [];

  if (typeof ratios.netProfitMargin === 'number') {
    reasons.push(`Latest FY net profit margin is ${ratios.netProfitMargin}%.`);
  } else if (profile.annualRevenue || profile.netProfitAfterTax) {
    missing.push('Latest FY net profit margin');
  }

  if (typeof ratios.currentRatio === 'number') {
    reasons.push(`Current ratio is ${ratios.currentRatio}.`);
    if (ratios.currentRatio < policy.currentRatioMin) {
      failed.push(
        `Current ratio ${ratios.currentRatio} is below the ${purposeLabel} policy minimum of ${policy.currentRatioMin}.`
      );
    }
  }

  if (typeof ratios.tolTnw === 'number') {
    reasons.push(`TOL/TNW is ${ratios.tolTnw}.`);
    if (ratios.tolTnw > policy.tolTnwMax) {
      failed.push(
        `TOL/TNW ${ratios.tolTnw} exceeds the ${purposeLabel} policy limit of ${policy.tolTnwMax}.`
      );
    }
  }

  if (typeof ratios.debtEquity === 'number') {
    reasons.push(`Debt/Equity is ${ratios.debtEquity}.`);
    if (ratios.debtEquity > policy.debtEquityMax) {
      failed.push(
        `Debt/Equity ${ratios.debtEquity} exceeds the ${purposeLabel} policy limit of ${policy.debtEquityMax}.`
      );
    }
  }

  if (typeof ratios.dscr === 'number') {
    reasons.push(`DSCR is ${ratios.dscr}.`);
    if (ratios.dscr < policy.dscrMin) {
      failed.push(
        `DSCR ${ratios.dscr} is below the ${purposeLabel} policy minimum of ${policy.dscrMin}.`
      );
    }
  }

  if (typeof ratios.interestCoverage === 'number') {
    reasons.push(`Interest coverage is ${ratios.interestCoverage}x.`);
  }

  if (typeof ratios.revenueGrowth === 'number') {
    reasons.push(`Revenue growth is ${ratios.revenueGrowth}% year on year.`);
    if (
      typeof policy.revenueGrowthMin === 'number' &&
      ratios.revenueGrowth < policy.revenueGrowthMin
    ) {
      failed.push(
        `Revenue growth ${ratios.revenueGrowth}% is below the ${purposeLabel} benchmark of ${policy.revenueGrowthMin}%.`
      );
    }
  }

  if (typeof profile.personalCibilScore === 'number') {
    reasons.push(`Personal CIBIL score is ${profile.personalCibilScore}.`);
    if (profile.personalCibilScore < policy.cibilMin) {
      failed.push(
        `Personal CIBIL score ${profile.personalCibilScore} is below the ${purposeLabel} policy threshold of ${policy.cibilMin}.`
      );
    }
  }

  if (typeof profile.commercialCmrRank === 'number') {
    reasons.push(`Commercial CMR rank is ${profile.commercialCmrRank}.`);
    if (profile.commercialCmrRank > policy.cmrMax) {
      failed.push(
        `Commercial CMR rank ${profile.commercialCmrRank} is weaker than the ${purposeLabel} policy ceiling of ${policy.cmrMax}.`
      );
    }
  }

  if (typeof ratios.bankingTurnoverRatio === 'number') {
    reasons.push(`Banking turnover ratio is ${ratios.bankingTurnoverRatio}%.`);
  }

  if (!profile.personalCibilScore && !profile.commercialCmrRank && assessment.creditScore) {
    reasons.push(`Application credit score is ${assessment.creditScore} as a general risk signal.`);
  }

  return { reasons, missing, failed };
}

/**
 * Two-Stage Intelligent Product Matching Engine:
 * - Stage 1: Requirement Matching (borrower need, funding purpose, entity fit, exclusions)
 * - Stage 2: Mandatory Eligibility Matching using ONLY verified rules (never draft rules,
 *   never inventing rules, and never classifying incomplete assessments as eligible).
 */
export function runTwoStageProductMatching(
  assessment: BorrowerAssessment,
  catalog: ProductCategory[],
  documents: ProductDocumentRecord[],
  datasetMode: 'official_catalog' | 'fictional_demo_sandbox',
  evaluatedBy = 'Internal Advisory User'
): MatchingEvaluationRecord {
  let configuredCategoriesCount = 0;
  let placeholderCategoriesCount = 0;
  let alignedCategoriesCount = 0;
  let alignedSubProductsCount = 0;

  const allRankedCandidates: RankedSubProductMatch[] = [];

  const categoryResults: CategoryEvaluationResult[] = catalog.map((category) => {
    const isUnassignedPlaceholder =
      category.status === 'placeholder' ||
      (category.name.trim().length === 0 &&
        category.baselineRules.length === 0 &&
        category.subProducts.length === 0);

    const displayName =
      category.name.trim().length > 0
        ? category.name
        : `Unconfigured Category Slot ${String(category.slotNumber).padStart(2, '0')}`;

    if (category.status === 'archived') {
      return {
        categoryId: category.id,
        slotNumber: category.slotNumber,
        code: category.code,
        displayName,
        isPlaceholder: false,
        isFictionalDemo: category.isFictionalDemo,
        stage1Matched: false,
        outcome: 'archived_excluded',
        eligibilityStatus: 'ineligible',
        suitabilityScore: 0,
        categoryChecks: [],
        subProductResults: [],
      };
    }

    if (isUnassignedPlaceholder) {
      placeholderCategoriesCount += 1;
      return {
        categoryId: category.id,
        slotNumber: category.slotNumber,
        code: category.code,
        displayName,
        isPlaceholder: true,
        isFictionalDemo: category.isFictionalDemo,
        stage1Matched: false,
        outcome: 'awaiting_study_material',
        eligibilityStatus: 'placeholder',
        suitabilityScore: 0,
        categoryChecks: [],
        subProductResults: [],
      };
    }

    configuredCategoriesCount += 1;

    const activeCategoryRules = category.baselineRules.filter(
      (r) => r.verificationStatus !== 'rejected'
    );
    const hasDraftOnlyCategoryRules =
      activeCategoryRules.length === 0 &&
      category.baselineRules.some((r) => r.verificationStatus === 'draft');

    const catEvalItems = activeCategoryRules.map((rule) =>
      evaluateVerifiedRule(rule, assessment)
    );
    const categoryChecks = catEvalItems.map((i) => i.check);

    // Stage 1 Category-level purpose & entity check
    const catPurposeFit = checkListSemanticFit(
      category.fundingPurposes,
      assessment.fundingPurpose || assessment.statedPurpose
    );
    const catEntityFit = checkListSemanticFit(
      category.suitableBorrowerTypes,
      assessment.entityType
    );

    const evaluateSingleSubProduct = (sp: SubProduct): SubProductEvaluationResult => {
      if (sp.status === 'archived') {
        return {
          subProductId: sp.id,
          code: sp.code,
          name: sp.name || 'Archived Sub-Product',
          status: sp.status,
          outcome: 'archived_excluded',
          eligibilityStatus: 'ineligible',
          suitabilityScore: 0,
          reasonsForMatching: [],
          failedRequirements: ['Sub-product is archived.'],
          missingInformation: [],
          checks: [],
          isFictionalDemo: sp.isFictionalDemo,
        };
      }

      if (sp.status === 'placeholder') {
        return {
          subProductId: sp.id,
          code: sp.code,
          name: sp.name || 'Placeholder Sub-Product',
          status: sp.status,
          outcome: 'awaiting_study_material',
          eligibilityStatus: 'placeholder',
          suitabilityScore: 0,
          reasonsForMatching: [],
          failedRequirements: [],
          missingInformation: [],
          checks: [],
          isFictionalDemo: sp.isFictionalDemo,
        };
      }

      const reasons: string[] = [];
      const failed: string[] = [];
      const missing: string[] = [];
      const financialSignals = evaluateFinancialSignals(assessment);
      reasons.push(...financialSignals.reasons);
      failed.push(...financialSignals.failed);
      missing.push(...financialSignals.missing);

      // Stage 1 — Requirement Matching
      let stage1Score = 40;
      let stage1Matched = true;

      const purposeCheck = checkListSemanticFit(
        sp.fundingPurposes?.length ? sp.fundingPurposes : category.fundingPurposes,
        assessment.fundingPurpose || assessment.statedPurpose
      );
      if (purposeCheck.checked) {
        if (purposeCheck.matched) {
          stage1Score += 15;
          reasons.push(
            `Addresses stated funding purpose (${(
              assessment.fundingPurpose || 'business requirement'
            ).replace(/_/g, ' ')}).`
          );
        } else {
          stage1Matched = false;
          failed.push(
            `Funding purpose (${(assessment.fundingPurpose || 'unspecified').replace(
              /_/g,
              ' '
            )}) is outside product's stated use cases.`
          );
        }
      }

      const borrowerTypeCheck = checkListSemanticFit(
        sp.suitableBorrowerTypes?.length
          ? sp.suitableBorrowerTypes
          : category.suitableBorrowerTypes,
        assessment.entityType
      );
      if (borrowerTypeCheck.checked) {
        if (borrowerTypeCheck.matched) {
          stage1Score += 10;
          reasons.push(
            `Suitable for ${assessment.entityType.replace(/_/g, ' ')} borrower structure.`
          );
        } else {
          stage1Matched = false;
          failed.push(
            `Borrower entity type (${assessment.entityType.replace(
              /_/g,
              ' '
            )}) is not listed among suitable borrower types.`
          );
        }
      }

      // Check Restrictions & Exclusions
      const combinedExclusions = [
        ...(category.restrictionsAndExclusions || []),
        ...(sp.restrictionsAndExclusions || []),
      ];
      if (combinedExclusions.length > 0 && assessment.industrySector?.trim()) {
        const sectorNorm = normalizeToken(assessment.industrySector);
        const triggeredExclusion = combinedExclusions.find((ex) => {
          const exNorm = normalizeToken(ex);
          return exNorm.length > 3 && sectorNorm.includes(exNorm);
        });
        if (triggeredExclusion) {
          stage1Matched = false;
          failed.push(`Restricted sector / exclusion triggered: ${triggeredExclusion}`);
        }
      }

      // Stage 2 — Rule-based eligibility with PDF-derived logic treated as active.
      const activeSpRules = sp.baselineRules.filter(
        (r) => r.verificationStatus !== 'rejected'
      );
      const hasUnverifiedDraftsOnly =
        activeSpRules.length === 0 &&
        activeCategoryRules.length === 0 &&
        (sp.verificationStatus === 'draft' ||
          sp.baselineRules.some((r) => r.verificationStatus === 'draft') ||
          hasDraftOnlyCategoryRules);

      const spEvalItems = activeSpRules.map((r) =>
        evaluateVerifiedRule(r, assessment)
      );
      const allChecks: RuleCheckDetail[] = [
        ...categoryChecks,
        ...spEvalItems.map((i) => i.check),
      ];

      for (const item of [...catEvalItems, ...spEvalItems]) {
        if (item.check.status === 'passed') {
          reasons.push(`${item.check.label}: ${item.check.actualSummary}`);
        } else if (item.check.status === 'missing_data') {
          const label = item.missingFieldLabel || item.check.label;
          if (!missing.includes(label)) {
            missing.push(label);
          }
        } else if (item.check.status === 'failed') {
          failed.push(
            `${item.check.label} (Actual: ${item.check.actualSummary}; Required: ${item.check.expectedSummary})`
          );
          if (item.check.stage === 'stage1_requirement') {
            stage1Matched = false;
          }
        }
      }

      const totalRulesCount = allChecks.length;
      const passedRulesCount = allChecks.filter((c) => c.status === 'passed').length;
      const mandatoryFailed = allChecks.some(
        (c) => c.status === 'failed' && c.isMandatory
      );
      const mandatoryMissing = allChecks.some(
        (c) => c.status === 'missing_data' && c.isMandatory
      );

      let eligibilityStatus: EligibilityStatus = 'pending_verification';
      let outcome: BaselineOutcome = 'configured_no_rules';
      let suitabilityScore = 0;

      if (hasUnverifiedDraftsOnly || (totalRulesCount === 0 && !purposeCheck.checked && !borrowerTypeCheck.checked)) {
        eligibilityStatus = 'pending_verification';
        outcome = 'configured_no_rules';
        suitabilityScore = 35;
      } else if (!stage1Matched || mandatoryFailed || failed.length > 0) {
        eligibilityStatus = 'ineligible';
        outcome = 'outside_baseline_bounds';
        const passRatio =
          totalRulesCount > 0 ? passedRulesCount / totalRulesCount : 0.3;
        suitabilityScore = Math.max(12, Math.round(stage1Score * 0.5 + passRatio * 30));
      } else if (mandatoryMissing || missing.length > 0) {
        // NEVER classify incomplete assessments as eligible
        eligibilityStatus = 'incomplete_data';
        outcome = 'incomplete_information';
        const passRatio =
          totalRulesCount > 0 ? passedRulesCount / totalRulesCount : 0.5;
        suitabilityScore = Math.min(79, Math.round(stage1Score + passRatio * 20));
      } else {
        eligibilityStatus = 'eligible';
        outcome = 'baseline_aligned';
        const ruleBonus =
          totalRulesCount > 0 ? (passedRulesCount / totalRulesCount) * 35 : 25;
        suitabilityScore = Math.min(98, Math.round(stage1Score + ruleBonus));
      }

      if (eligibilityStatus === 'eligible') {
        alignedSubProductsCount += 1;
      }

      // Attach linked source Google Drive PDFs
      const docIds = new Set([
        ...(category.sourceDocumentIds || []),
        ...(sp.sourceDocumentIds || []),
      ]);
      const linkedDocs = documents
        .filter(
          (d) =>
            docIds.has(d.id) ||
            d.subProductId === sp.id ||
            (d.categoryId === category.id && !d.subProductId)
        )
        .map((d) => ({
          id: d.id,
          fileName: d.fileName,
          webViewLink: d.webViewLink,
        }));

      allRankedCandidates.push({
        subProductId: sp.id,
        subProductCode: sp.code,
        subProductName: sp.name || sp.code,
        categoryId: category.id,
        categorySlotNumber: category.slotNumber,
        categoryCode: category.code,
        categoryName: displayName,
        suitabilityScore,
        stage1RequirementMatched: stage1Matched,
        eligibilityStatus,
        reasonsForMatching: reasons,
        failedRequirements: failed,
        missingInformation: missing,
        requiredDocuments: sp.requiredDocuments || [],
        sourceDocuments: linkedDocs,
        ruleChecks: allChecks,
        isFictionalDemo: sp.isFictionalDemo || category.isFictionalDemo,
      });

      return {
        subProductId: sp.id,
        code: sp.code,
        name: sp.name || 'Configured Sub-Product',
        status: sp.status,
        outcome,
        eligibilityStatus,
        suitabilityScore,
        reasonsForMatching: reasons,
        failedRequirements: failed,
        missingInformation: missing,
        checks: allChecks,
        isFictionalDemo: sp.isFictionalDemo,
      };
    };

    const subProductResults = category.subProducts.map(evaluateSingleSubProduct);

    const anySubEligible = subProductResults.some(
      (s) => s.eligibilityStatus === 'eligible'
    );
    const anySubIncomplete = subProductResults.some(
      (s) => s.eligibilityStatus === 'incomplete_data'
    );
    const catMandatoryFailed = categoryChecks.some(
      (c) => c.status === 'failed' && c.isMandatory
    );
    const catMandatoryMissing = categoryChecks.some(
      (c) => c.status === 'missing_data' && c.isMandatory
    );

    let categoryEligibility: EligibilityStatus = 'pending_verification';
    let categoryOutcome: BaselineOutcome = 'configured_no_rules';

    if (anySubEligible) {
      categoryEligibility = 'eligible';
      categoryOutcome = 'baseline_aligned';
    } else if (anySubIncomplete) {
      categoryEligibility = 'incomplete_data';
      categoryOutcome = 'incomplete_information';
    } else if (catMandatoryFailed || !catPurposeFit.matched || !catEntityFit.matched) {
      categoryEligibility = 'ineligible';
      categoryOutcome = 'outside_baseline_bounds';
    } else if (catMandatoryMissing) {
      categoryEligibility = 'incomplete_data';
      categoryOutcome = 'incomplete_information';
    } else if (
      subProductResults.length > 0 &&
      subProductResults.every((s) => s.eligibilityStatus === 'ineligible')
    ) {
      categoryEligibility = 'ineligible';
      categoryOutcome = 'outside_baseline_bounds';
    } else if (activeCategoryRules.length > 0 && subProductResults.length === 0) {
      categoryEligibility = 'eligible';
      categoryOutcome = 'baseline_aligned';
    }

    if (categoryEligibility === 'eligible') {
      alignedCategoriesCount += 1;
    }

    const maxSubScore = subProductResults.reduce(
      (max, s) => Math.max(max, s.suitabilityScore),
      0
    );

    return {
      categoryId: category.id,
      slotNumber: category.slotNumber,
      code: category.code,
      displayName,
      isPlaceholder: false,
      isFictionalDemo: category.isFictionalDemo,
      stage1Matched: catPurposeFit.matched && catEntityFit.matched,
      outcome: categoryOutcome,
      eligibilityStatus: categoryEligibility,
      suitabilityScore: maxSubScore,
      categoryChecks,
      subProductResults,
    };
  });

  // Rank sub-products: Eligible first -> Incomplete Data -> Pending Verification -> Ineligible, then by score
  const statusWeight: Record<EligibilityStatus, number> = {
    eligible: 4,
    incomplete_data: 3,
    pending_verification: 2,
    ineligible: 1,
    placeholder: 0,
  };

  const sortedCandidates = [...allRankedCandidates].sort((a, b) => {
    const statusDiff =
      statusWeight[b.eligibilityStatus] - statusWeight[a.eligibilityStatus];
    if (statusDiff !== 0) return statusDiff;
    return b.suitabilityScore - a.suitabilityScore;
  });

  const primarySuitable = sortedCandidates.filter(
    (c) =>
      (c.eligibilityStatus === 'eligible' ||
        c.eligibilityStatus === 'incomplete_data') &&
      c.suitabilityScore >= 70
  );

  const top3SubProducts =
    primarySuitable.length > 0
      ? primarySuitable.slice(0, 3)
      : sortedCandidates
          .filter((c) => c.eligibilityStatus !== 'placeholder')
          .slice(0, 3);

  const top3Ids = new Set(top3SubProducts.map((item) => item.subProductId));

  const alternativePool = sortedCandidates.filter(
    (c) =>
      !top3Ids.has(c.subProductId) &&
      c.eligibilityStatus !== 'placeholder' &&
      c.suitabilityScore > 0
  );

  const alternativeSubProducts = alternativePool.slice(0, 5);

  return {
    evaluationId: `eval-${Date.now()}`,
    assessmentId: assessment.id,
    evaluatedAt: new Date().toISOString(),
    evaluatedBy,
    datasetMode,
    engineStageLabel: 'Two-Stage Engine — Requirement Fit & Verified Eligibility Rules',
    totalCategoriesInspected: catalog.length,
    configuredCategoriesCount,
    placeholderCategoriesCount,
    alignedCategoriesCount,
    alignedSubProductsCount,
    top3SubProducts,
    alternativeSubProducts,
    categoryResults,
    aiExplanation: null,
  };
}

export function runStage1BaselineEvaluation(
  assessment: BorrowerAssessment,
  catalog: ProductCategory[],
  datasetMode: 'official_catalog' | 'fictional_demo_sandbox'
): MatchingEvaluationRecord {
  return runTwoStageProductMatching(assessment, catalog, [], datasetMode);
}
