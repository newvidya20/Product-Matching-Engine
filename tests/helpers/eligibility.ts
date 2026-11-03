/** Shared fixtures for eligibility tests. FICTIONAL borrower values. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EligibilityInput, EligibilityRuleConfig } from '../../src/types/eligibility.ts';

export const SEED_PATH = fileURLToPath(new URL('../../server/eligibility/defaultRules.json', import.meta.url));

export function defaultRules(): EligibilityRuleConfig {
  return JSON.parse(readFileSync(SEED_PATH, 'utf-8')) as EligibilityRuleConfig;
}

/** Every criterion passes with the default rules. */
export function passingInput(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    entityType: 'private_limited',
    fundingPurpose: 'working_capital',
    requestedAmount: 3_000_000,
    requestedTenureMonths: 36,
    businessVintageYears: 5,
    personalCibilScore: 750,
    promoterCibilScore: null,
    commercialCmrRank: 4,
    commercialCreditReportStatus: 'available',
    annualRevenue: 20_000_000,
    netProfitAfterTax: 1_500_000,
    ebitda: 3_000_000,
    ebit: 2_500_000,
    depreciation: 400_000,
    amortization: 100_000,
    interestExpense: 500_000,
    profitabilityStatus: 'profitable_2plus_years',
    currentAssets: 5_000_000,
    currentLiabilities: 3_000_000,
    totalOutsideLiabilities: 6_000_000,
    tangibleNetWorth: 4_000_000,
    annualScheduledPrincipalRepayments: 600_000,
    existingMonthlyEmi: 100_000,
    averageMonthlyBankingCredits: 1_500_000,
    gstAnnualTurnover: 18_000_000,
    gstComplianceStatus: 'compliant',
    dscrStated: null,
    ...overrides,
  };
}
