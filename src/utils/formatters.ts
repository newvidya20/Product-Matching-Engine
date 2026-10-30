import type {
  AssessmentStatus,
  BaselineOutcome,
  CategoryLifecycleStatus,
  EligibilityStatus,
  EntityStructureType,
  FundingPurposeCategory,
  ProductCategory,
  StudyMaterialStatus,
} from '../types/domain';

export function formatMoney(amount: number, currency = 'INR'): string {
  return `${currency} ${Number(amount || 0).toLocaleString('en-IN')}`;
}

export function formatShortDate(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatEntityType(type: EntityStructureType): string {
  const map: Record<EntityStructureType, string> = {
    individual: 'Individual Applicant',
    proprietorship: 'Sole Proprietorship',
    partnership: 'Partnership Firm',
    llp: 'Limited Liability Partnership (LLP)',
    private_limited: 'Private Limited Company',
    public_limited: 'Public Limited Company',
    trust_society: 'Trust / Society',
  };
  return map[type] || type;
}

export function formatFundingPurpose(purpose?: FundingPurposeCategory): string {
  if (!purpose) return 'General Business Requirement';
  const map: Record<FundingPurposeCategory, string> = {
    working_capital: 'Working Capital & Inventory',
    machinery_equipment: 'Machinery & Equipment Purchase',
    commercial_property: 'Commercial Property / Expansion',
    invoice_discounting: 'Invoice / Bill Discounting',
    debt_consolidation: 'Debt Consolidation / Refinance',
    project_expansion: 'Project / Infrastructure Finance',
    trade_import_export: 'Trade / Import-Export Finance',
    general_business: 'General Business Requirement',
  };
  return map[purpose] || purpose;
}

export function getCategoryDisplayTitle(category: ProductCategory): string {
  if (category.name && category.name.trim().length > 0) {
    return category.name.trim();
  }
  return `Empty Placeholder Slot ${String(category.slotNumber).padStart(2, '0')}`;
}

export function isCategoryConfigured(category: ProductCategory): boolean {
  return (
    category.status === 'active' &&
    (category.name.trim().length > 0 ||
      category.subProducts.length > 0 ||
      category.baselineRules.length > 0)
  );
}

export function formatCategoryLifecycle(status: CategoryLifecycleStatus): {
  label: string;
  textClass: string;
} {
  switch (status) {
    case 'active':
      return { label: 'Active Configuration', textClass: 'text-emerald-700 font-medium' };
    case 'archived':
      return { label: 'Archived', textClass: 'text-stone-400' };
    case 'placeholder':
    default:
      return { label: 'Placeholder (Unconfigured)', textClass: 'text-amber-700' };
  }
}

export function formatStudyMaterialStatus(status: StudyMaterialStatus): {
  label: string;
  textClass: string;
} {
  switch (status) {
    case 'configured':
      return { label: 'Verified & Active', textClass: 'text-emerald-700 font-medium' };
    case 'draft_extracted':
      return {
        label: 'Study Material Rules Loaded',
        textClass: 'text-emerald-700 font-medium',
      };
    case 'in_review':
      return { label: 'Study Material Reviewed', textClass: 'text-amber-700 font-medium' };
    case 'pending_upload':
    default:
      return { label: 'Awaiting Study Material PDF', textClass: 'text-stone-500' };
  }
}

export function formatAssessmentStatus(status: AssessmentStatus): {
  label: string;
  textClass: string;
} {
  switch (status) {
    case 'evaluated':
      return { label: 'Matched (2-Stage)', textClass: 'text-emerald-700 font-medium' };
    case 'submitted':
      return { label: 'Ready for Matching', textClass: 'text-orange-700 font-medium' };
    case 'draft':
    default:
      return { label: 'Draft Intake', textClass: 'text-stone-500' };
  }
}

export function formatEligibilityStatus(status: EligibilityStatus): {
  label: string;
  textClass: string;
} {
  switch (status) {
    case 'eligible':
      return { label: 'Eligible (Verified Rules)', textClass: 'text-emerald-700 font-semibold' };
    case 'incomplete_data':
      return {
        label: 'Incomplete Information · Action Needed',
        textClass: 'text-amber-700 font-semibold',
      };
    case 'ineligible':
      return { label: 'Ineligible (Rule Failed)', textClass: 'text-red-700 font-medium' };
    case 'pending_verification':
      return {
        label: 'Study Material Rule Set in Use',
        textClass: 'text-emerald-700 font-medium',
      };
    case 'placeholder':
    default:
      return { label: 'Unconfigured Placeholder', textClass: 'text-stone-400' };
  }
}

export function formatBaselineOutcome(outcome: BaselineOutcome): {
  label: string;
  textClass: string;
} {
  switch (outcome) {
    case 'baseline_aligned':
      return { label: 'Eligible · Rules Verified', textClass: 'text-emerald-700 font-medium' };
    case 'incomplete_information':
      return { label: 'Missing Borrower Information', textClass: 'text-amber-700 font-medium' };
    case 'outside_baseline_bounds':
      return { label: 'Failed Mandatory Criteria', textClass: 'text-red-700 font-medium' };
    case 'configured_no_rules':
      return { label: 'Pending Verified Rules', textClass: 'text-amber-700 font-medium' };
    case 'archived_excluded':
      return { label: 'Archived · Excluded', textClass: 'text-stone-400' };
    case 'awaiting_study_material':
    default:
      return { label: 'Awaiting Study Material PDF', textClass: 'text-stone-500' };
  }
}
