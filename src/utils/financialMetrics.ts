import type { BorrowerFinancialProfile } from '../types/domain';

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  if (normalized === '') return null;
  const asNumber = Number(normalized);
  return Number.isFinite(asNumber) ? asNumber : null;
}

export function calculateFinancialRatios(
  profile: Partial<BorrowerFinancialProfile> | null | undefined
): Required<BorrowerFinancialProfile>['ratios'] {
  if (!profile) {
    return {
      netProfitMargin: null,
      ebitdaMargin: null,
      currentRatio: null,
      tolTnw: null,
      debtEquity: null,
      interestCoverage: null,
      dscr: null,
      revenueGrowth: null,
      bankingTurnoverRatio: null,
    };
  }

  const annualRevenue = toNumber(profile.annualRevenue);
  const previousAnnualRevenue = toNumber(profile.previousAnnualRevenue);
  const netProfitAfterTax = toNumber(profile.netProfitAfterTax);
  const ebitda = toNumber(profile.ebitda);
  const ebit = toNumber(profile.ebit);
  const interestExpense = toNumber(profile.interestExpense);
  const currentAssets = toNumber(profile.currentAssets);
  const currentLiabilities = toNumber(profile.currentLiabilities);
  const totalOutsideLiabilities = toNumber(profile.totalOutsideLiabilities);
  const tangibleNetWorth = toNumber(profile.tangibleNetWorth);
  const shareholdersEquity = toNumber(profile.shareholdersEquity);
  const totalOutstandingBorrowings = toNumber(profile.totalOutstandingBorrowings);
  const operatingCashFlow = toNumber(profile.operatingCashFlow);
  const annualScheduledPrincipalRepayments = toNumber(profile.annualScheduledPrincipalRepayments);
  const existingMonthlyEmi = toNumber(profile.existingMonthlyEmi);
  const averageMonthlyBankingCredits = toNumber(profile.averageMonthlyBankingCredits);
  const averageMonthlyBankingBalance = toNumber(profile.averageMonthlyBankingBalance);
  const ccOdSanctionedLimit = toNumber(profile.ccOdSanctionedLimit);
  const ccOdUtilisation = toNumber(profile.ccOdUtilisation);
  const gstAnnualTurnover = toNumber(profile.gstAnnualTurnover);

  const netProfitMargin =
    annualRevenue && annualRevenue !== 0 && netProfitAfterTax !== null
      ? (netProfitAfterTax / annualRevenue) * 100
      : null;

  const ebitdaMargin =
    annualRevenue && annualRevenue !== 0 && ebitda !== null
      ? (ebitda / annualRevenue) * 100
      : null;

  const currentRatio =
    currentLiabilities && currentLiabilities !== 0 && currentAssets !== null
      ? currentAssets / currentLiabilities
      : null;

  const tolTnw =
    tangibleNetWorth && tangibleNetWorth !== 0 && totalOutsideLiabilities !== null
      ? totalOutsideLiabilities / tangibleNetWorth
      : null;

  const debtEquity =
    shareholdersEquity && shareholdersEquity !== 0 && totalOutstandingBorrowings !== null
      ? totalOutstandingBorrowings / shareholdersEquity
      : null;

  const interestCoverage =
    interestExpense && interestExpense !== 0 && ebit !== null
      ? ebit / interestExpense
      : null;

  const totalDebtService =
    (annualScheduledPrincipalRepayments ?? 0) + (existingMonthlyEmi ? existingMonthlyEmi * 12 : 0);
  const dscr =
    totalDebtService > 0 && operatingCashFlow !== null
      ? operatingCashFlow / totalDebtService
      : null;

  const revenueGrowth =
    previousAnnualRevenue && previousAnnualRevenue !== 0 && annualRevenue !== null
      ? ((annualRevenue - previousAnnualRevenue) / previousAnnualRevenue) * 100
      : null;

  const bankingTurnoverRatio =
    averageMonthlyBankingCredits && averageMonthlyBankingCredits !== 0 && annualRevenue !== null
      ? (averageMonthlyBankingCredits * 12 / annualRevenue) * 100
      : null;

  const bankUtilisation =
    ccOdSanctionedLimit && ccOdSanctionedLimit !== 0 && ccOdUtilisation !== null
      ? (ccOdUtilisation / ccOdSanctionedLimit) * 100
      : null;

  return {
    netProfitMargin: netProfitMargin !== null ? Number(netProfitMargin.toFixed(2)) : null,
    ebitdaMargin: ebitdaMargin !== null ? Number(ebitdaMargin.toFixed(2)) : null,
    currentRatio: currentRatio !== null ? Number(currentRatio.toFixed(2)) : null,
    tolTnw: tolTnw !== null ? Number(tolTnw.toFixed(2)) : null,
    debtEquity: debtEquity !== null ? Number(debtEquity.toFixed(2)) : null,
    interestCoverage: interestCoverage !== null ? Number(interestCoverage.toFixed(2)) : null,
    dscr: dscr !== null ? Number(dscr.toFixed(2)) : null,
    revenueGrowth: revenueGrowth !== null ? Number(revenueGrowth.toFixed(2)) : null,
    bankingTurnoverRatio: bankingTurnoverRatio !== null ? Number(bankingTurnoverRatio.toFixed(2)) : null,
  };
}

export function getFinancialSummary(profile: Partial<BorrowerFinancialProfile> | null | undefined): string[] {
  const ratioSet = calculateFinancialRatios(profile);
  const summaries: string[] = [];

  if (ratioSet.netProfitMargin !== null) {
    summaries.push(`Net Profit Margin: ${ratioSet.netProfitMargin}%`);
  }
  if (ratioSet.ebitdaMargin !== null) {
    summaries.push(`EBITDA Margin: ${ratioSet.ebitdaMargin}%`);
  }
  if (ratioSet.currentRatio !== null) {
    summaries.push(`Current Ratio: ${ratioSet.currentRatio}`);
  }
  if (ratioSet.tolTnw !== null) {
    summaries.push(`TOL/TNW: ${ratioSet.tolTnw}`);
  }
  if (ratioSet.debtEquity !== null) {
    summaries.push(`Debt/Equity: ${ratioSet.debtEquity}`);
  }
  if (ratioSet.interestCoverage !== null) {
    summaries.push(`Interest Coverage: ${ratioSet.interestCoverage}x`);
  }
  if (ratioSet.dscr !== null) {
    summaries.push(`DSCR: ${ratioSet.dscr}`);
  }
  if (ratioSet.revenueGrowth !== null) {
    summaries.push(`Revenue Growth: ${ratioSet.revenueGrowth}%`);
  }
  if (ratioSet.bankingTurnoverRatio !== null) {
    summaries.push(`Banking Turnover Ratio: ${ratioSet.bankingTurnoverRatio}%`);
  }

  return summaries;
}
