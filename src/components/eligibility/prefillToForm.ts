import type { BorrowerAssessment, BorrowerFinancialProfile } from '../../types/domain';
import type { NewAssessmentPrefill } from '../../types/eligibility';
import { assessmentToForm, createBlankForm, type FormState } from '../documentAi/formModel';

/**
 * Starts a blank New Assessment form and writes only the values the eligibility record actually holds.
 * Everything else stays blank: nothing is defaulted or inferred.
 */
export function prefillToForm(prefill: NewAssessmentPrefill, defaultCurrency: string, officerDefault: string): FormState {
  const blank = createBlankForm(defaultCurrency, officerDefault);
  const { assessment, financialProfile } = prefill;
  const overlay = {
    applicantLabel: prefill.applicantLabel || blank.applicantLabel,
    ...assessment,
    financialProfile: financialProfile as BorrowerFinancialProfile,
  };
  // Start from the blank form's own values so unset fields keep their blank state.
  const asAssessment = {
    entityType: blank.entityType,
    fundingPurpose: blank.fundingPurpose,
    assignedOfficer: blank.assignedOfficer,
    branchOrDesk: blank.branchOrDesk,
    requestedAmount: 0,
    currency: blank.currency,
    requestedTenureMonths: 0,
    annualTurnoverOrIncome: 0,
    collateralAvailable: false,
    collateralDescription: '',
    statedPurpose: '',
    advisorNotes: '',
    customAttributes: [],
    isFictionalDemo: false,
    ...overlay,
  } as unknown as BorrowerAssessment;
  const form = assessmentToForm(asAssessment, defaultCurrency);
  // Fields the record does not carry go back to the blank form's state, not assessmentToForm's fallbacks.
  return {
    ...form,
    ...(assessment.fundingPurpose ? {} : { fundingPurpose: blank.fundingPurpose }),
    ...(assessment.requestedTenureMonths ? {} : { requestedTenureMonths: blank.requestedTenureMonths }),
    ...(assessment.gstTaxCompliant ? {} : { gstTaxCompliant: blank.gstTaxCompliant }),
    ...(assessment.profitabilityStatus ? {} : { profitabilityStatus: blank.profitabilityStatus }),
    collateralAvailable: blank.collateralAvailable,
    branchOrDesk: blank.branchOrDesk,
  };
}
