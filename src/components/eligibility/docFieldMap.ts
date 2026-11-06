import type { EligibilityInputField } from '../../types/eligibility';

/** Document AI field behind each Eligibility input (mirrors server/eligibility/inputSchema.ts INPUT_FIELD_IDS). */
export const ELIGIBILITY_DOC_FIELD_IDS: Readonly<Partial<Record<EligibilityInputField, string>>> = {
  entityType: 'entityType',
  fundingPurpose: 'fundingPurpose',
  requestedAmount: 'requestedAmount',
  requestedTenureMonths: 'requestedTenureMonths',
  businessVintageYears: 'businessVintageYears',
  personalCibilScore: 'financialProfile.personalCibilScore',
  promoterCibilScore: 'financialProfile.promoterCibilScore',
  commercialCmrRank: 'financialProfile.commercialCmrRank',
  commercialCreditReportStatus: 'financialProfile.commercialCreditReportStatus',
  annualRevenue: 'financialProfile.annualRevenue',
  netProfitAfterTax: 'financialProfile.netProfitAfterTax',
  ebitda: 'financialProfile.ebitda',
  ebit: 'financialProfile.ebit',
  depreciation: 'financialProfile.depreciation',
  amortization: 'financialProfile.amortization',
  interestExpense: 'financialProfile.interestExpense',
  profitabilityStatus: 'profitabilityStatus',
  currentAssets: 'financialProfile.currentAssets',
  currentLiabilities: 'financialProfile.currentLiabilities',
  totalOutsideLiabilities: 'financialProfile.totalOutsideLiabilities',
  tangibleNetWorth: 'financialProfile.tangibleNetWorth',
  annualScheduledPrincipalRepayments: 'financialProfile.annualScheduledPrincipalRepayments',
  existingMonthlyEmi: 'financialProfile.existingMonthlyEmi',
  operatingCashFlow: 'financialProfile.operatingCashFlow',
  averageMonthlyBankingCredits: 'financialProfile.averageMonthlyBankingCredits',
  gstAnnualTurnover: 'financialProfile.gstAnnualTurnover',
  gstComplianceStatus: 'financialProfile.gstComplianceStatus',
};

/** The Eligibility input a document field feeds. A mirror of personalCibilScore (creditScore) feeds it too. */
export function eligibilityFieldForDocField(docFieldId: string): EligibilityInputField | null {
  const direct = Object.entries(ELIGIBILITY_DOC_FIELD_IDS).find(([, id]) => id === docFieldId)?.[0];
  if (direct) return direct as EligibilityInputField;
  if (docFieldId === 'creditScore') return 'personalCibilScore';
  if (docFieldId === 'annualTurnoverOrIncome') return 'annualRevenue';
  if (docFieldId === 'existingEmiObligations') return 'existingMonthlyEmi';
  return null;
}
