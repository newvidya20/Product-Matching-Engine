/** "Totals from your documents": whole-period sums of what was read. Money is in rupees as numbers. */
export interface GstYearTotal {
  financialYear: string;
  gstin: string | null;
  /** Distinct YYYY-MM months counted. */
  monthsCovered: number;
  monthsExpected: 12;
  months: string[];
  outwardTaxable: number;
  zeroRated: number;
  nilExempt: number;
  /** outwardTaxable + zeroRated + nilExempt (3.1 a+b+c). Non-GST supplies are never counted. */
  total: number;
  /** Fewer than 12 months were read. */
  partYear: boolean;
}

export interface BankAccountTotal {
  label: string;
  monthsCovered: number;
  firstMonth: string | null;
  lastMonth: string | null;
  totalCredits: number;
  /** Null when any counted month has no debits figure: never 0. */
  totalDebits: number | null;
  /** Total credits over the months counted. Null when no month counted. */
  averageMonthlyCredits: number | null;
  /** Months between first and last that are not counted (absent, partial or conflicting). */
  missingMonths: string[];
}

export interface SessionTotals {
  gst: GstYearTotal[];
  bank: {
    accounts: BankAccountTotal[];
    allAccounts: {
      totalCredits: number;
      totalDebits: number | null;
      months: number;
      averageMonthlyCredits: number | null;
    } | null;
  };
  notes: string[];
}
