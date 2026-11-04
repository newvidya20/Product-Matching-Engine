/**
 * ONE fictional borrower shared by the Eligibility Check demo and the New Assessment demo, so Continue
 * from one to the other is coherent. Every value is invented. Under server/eligibility/defaultRules.json
 * this evaluates to CONDITIONALLY_ELIGIBLE (verified in tests/demo-data.test.ts):
 *  - CIBIL 735 is in the 700-749 conditional band; requested / monthly credits = 3.21 is in the 3-4 band.
 *  - DSCR = 7,200,000 / (3,000,000 + 185,000 x 12) = 1.38; TOL/TNW = 3.00; banking turnover = 86.7%.
 */
import type { EligibilityInput } from '../../types/eligibility';
import type { FormState } from '../documentAi/formModel';

export const DEMO_APPLICANT_LABEL = '[FICTIONAL DEMO] Deccan Precision Engineering LLP';

export const DEMO_ELIGIBILITY_INPUT: EligibilityInput = {
  entityType: 'llp',
  fundingPurpose: 'machinery_equipment',
  requestedAmount: 12_500_000,
  requestedTenureMonths: 60,
  businessVintageYears: 8,
  personalCibilScore: 735,
  promoterCibilScore: null,
  commercialCmrRank: 5,
  commercialCreditReportStatus: 'available',
  annualRevenue: 54_000_000,
  netProfitAfterTax: 4_200_000,
  ebitda: 9_600_000,
  ebit: 7_800_000,
  depreciation: 1_500_000,
  amortization: 300_000,
  interestExpense: 2_100_000,
  profitabilityStatus: 'profitable_2plus_years',
  currentAssets: 21_000_000,
  currentLiabilities: 13_000_000,
  totalOutsideLiabilities: 54_000_000,
  tangibleNetWorth: 18_000_000,
  annualScheduledPrincipalRepayments: 3_000_000,
  existingMonthlyEmi: 185_000,
  operatingCashFlow: 7_200_000,
  averageMonthlyBankingCredits: 3_900_000,
  gstAnnualTurnover: 53_200_000,
  gstComplianceStatus: 'compliant',
  dscrStated: null,
};

/** Form strings for the Eligibility page. Null stays blank. */
export function demoEligibilityValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(DEMO_ELIGIBILITY_INPUT)) out[k] = v === null ? '' : String(v);
  return out;
}

/** The same borrower as a New Assessment form, section 04 included. */
export function demoBorrowerForm(blank: FormState, officer: string): FormState {
  const i = DEMO_ELIGIBILITY_INPUT;
  const n = (v: number | null) => (v === null ? '' : String(v));
  return {
    ...blank,
    applicantLabel: DEMO_APPLICANT_LABEL,
    entityType: 'llp',
    industrySector: 'Industrial Machinery & Precision Components',
    businessVintageYears: n(i.businessVintageYears),
    gstTaxCompliant: 'yes',
    fundingPurpose: 'machinery_equipment',
    dynamicPurposeAnswers: {
      equipmentCondition: 'New Domestic Equipment',
      supplierQuotationReady: 'Yes',
      borrowerMarginPercent: '20%',
    },
    assignedOfficer: officer || 'M. Joshi (Demo Desk)',
    branchOrDesk: 'West Zone — Pune Desk',
    requestedAmount: n(i.requestedAmount),
    requestedTenureMonths: n(i.requestedTenureMonths),
    annualTurnoverOrIncome: n(i.annualRevenue),
    creditScore: n(i.personalCibilScore),
    existingEmiObligations: n(i.existingMonthlyEmi),
    profitabilityStatus: 'profitable_2plus_years',
    collateralAvailable: 'yes',
    collateralType: 'Industrial Shed & Equipment',
    collateralValue: '21000000',
    collateralDescription: 'Fictional sample industrial shed & machinery collateral record for workflow testing.',
    statedPurpose: 'Fictional sample intake: automated CNC assembly line acquisition.',
    advisorNotes: 'Fictional demo data. Populate the borrower profile to test product fit analysis against the approved catalogue.',
    isFictionalDemo: true,
    financialProfile: {
      ...blank.financialProfile,
      financialYearLabel: 'FY 2024-25 (FICTIONAL DEMO)',
      dataSource: 'audited',
      annualRevenue: n(i.annualRevenue),
      previousAnnualRevenue: '48500000',
      netProfitAfterTax: n(i.netProfitAfterTax),
      ebitda: n(i.ebitda),
      ebit: n(i.ebit),
      depreciation: n(i.depreciation),
      amortization: n(i.amortization),
      interestExpense: n(i.interestExpense),
      currentAssets: n(i.currentAssets),
      currentLiabilities: n(i.currentLiabilities),
      totalOutsideLiabilities: n(i.totalOutsideLiabilities),
      tangibleNetWorth: n(i.tangibleNetWorth),
      annualScheduledPrincipalRepayments: n(i.annualScheduledPrincipalRepayments),
      existingMonthlyEmi: n(i.existingMonthlyEmi),
      operatingCashFlow: n(i.operatingCashFlow),
      averageMonthlyBankingCredits: n(i.averageMonthlyBankingCredits),
      averageMonthlyBankingBalance: '1850000',
      gstAnnualTurnover: n(i.gstAnnualTurnover),
      personalCibilScore: n(i.personalCibilScore),
      commercialCmrRank: n(i.commercialCmrRank),
      gstComplianceStatus: 'compliant',
      commercialCreditReportStatus: 'available',
      personalCreditReportDate: '2026-10-15',
      delinquencies: 'None (fictional demo)',
      // Derived from the inputs above: 7,200,000 / (3,000,000 + 185,000 x 12).
      dscr: '1.38',
    },
  };
}
