export type AppModuleId =
  | 'dashboard'
  | 'new-assessment'
  | 'matching-engine'
  | 'directory'
  | 'history'
  | 'admin'
  | 'settings';

export type UserRole = 'admin' | 'employee';

export interface AuthenticatedGoogleUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  role: UserRole;
}

export type SheetsAuthMode = 'oauth_user' | 'service_account' | 'unauthenticated';

export type RequiredSheetTabName =
  | 'Product_Categories'
  | 'Sub_Products'
  | 'Eligibility_Rules'
  | 'Product_Documents'
  | 'Borrower_Assessments'
  | 'Matching_Results'
  | 'Policy_Review_Log';

export interface SheetTabSchemaStatus {
  tabName: RequiredSheetTabName;
  sheetId: number | null;
  exists: boolean;
  headersValid: boolean;
  missingHeaders: string[];
  rowCount: number;
}

export interface SheetsClientStatusPayload {
  authMode: SheetsAuthMode;
  serviceAccountConfigured: boolean;
  serviceAccountEmail: string | null;
  oauthUserEmail: string | null;
  spreadsheetConnected: boolean;
  spreadsheetId: string;
  spreadsheetTitle: string;
  spreadsheetUrl: string;
  lastSyncedAt: string;
  tabs: SheetTabSchemaStatus[];
}

export interface SheetTabPreviewPayload {
  tabName: RequiredSheetTabName;
  headers: string[];
  totalRows: number;
  rows: Record<string, string>[];
}

export interface WorkspaceConnectionConfig {
  spreadsheetId: string;
  spreadsheetTitle: string;
  spreadsheetUrl: string;
  driveFolderId: string;
  driveFolderName: string;
  adminEmails: string[];
  employeeEmails: string[];
  connectedByEmail: string;
  lastSyncedAt: string;
}

export type CategoryLifecycleStatus = 'placeholder' | 'active' | 'archived';

export type StudyMaterialStatus =
  | 'pending_upload'
  | 'draft_extracted'
  | 'in_review'
  | 'configured';

export type RuleVerificationStatus = 'draft' | 'verified' | 'rejected';

export type RuleStage = 'stage1_requirement' | 'stage2_eligibility';

export type RuleOperator =
  | 'number_min'
  | 'number_max'
  | 'boolean_equals'
  | 'text_equals'
  | 'in_list'
  | 'not_in_list'
  | 'custom_Presence';

export type TargetIntakeField =
  | 'requestedAmount'
  | 'requestedTenureMonths'
  | 'annualTurnoverOrIncome'
  | 'businessVintageYears'
  | 'creditScore'
  | 'existingEmiObligations'
  | 'profitabilityStatus'
  | 'gstTaxCompliant'
  | 'collateralAvailable'
  | 'collateralValue'
  | 'entityType'
  | 'fundingPurpose'
  | 'industrySector'
  | 'customAttribute';

export interface ConfigurableRuleField {
  id: string;
  categoryId?: string;
  subProductId?: string;
  stage?: RuleStage;
  targetField: TargetIntakeField;
  customKey?: string;
  label: string;
  operator: RuleOperator;
  expectedValue: string | number | boolean;
  isMandatory?: boolean;
  verificationStatus?: RuleVerificationStatus;
  sourceDocId?: string;
  extractedByAi?: boolean;
  verifiedBy?: string;
  verifiedAt?: string;
  notes: string;
}

export interface KeyValueAttribute {
  id: string;
  key: string;
  value: string;
}

export interface ExtractedRuleCandidate {
  stage: RuleStage;
  targetField: TargetIntakeField;
  customKey?: string;
  label: string;
  operator: RuleOperator;
  expectedValue: string;
  isMandatory: boolean;
  notes: string;
}

export interface ExtractedPdfDraft {
  extractedAt: string;
  productName: string;
  suggestedCategoryName: string;
  productDescription: string;
  suitableBorrowerTypes: string[];
  fundingPurposesAndUseCases: string[];
  eligibilityCriteriaText: string[];
  structuredRules: ExtractedRuleCandidate[];
  financialRequirements: string[];
  collateralRequirements: string[];
  requiredDocuments: string[];
  restrictionsAndExclusions: string[];
}

export interface ProductDocumentRecord {
  id: string;
  driveFileId: string;
  fileName: string;
  mimeType: string;
  webViewLink: string;
  categoryId: string;
  subProductId: string;
  extractionStatus: 'uploaded' | 'extracted_draft' | 'verified' | 'error';
  extractedDraft: ExtractedPdfDraft | null;
  uploadedBy: string;
  uploadedAt: string;
}

export interface StudyMaterialReferenceDocument {
  id: string;
  categoryName: string;
  productName: string;
  fileName: string;
  relativePath: string;
  pageCount: number;
  text: string;
  extractionError?: string;
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
}

export interface SubProduct {
  id: string;
  categoryId: string;
  code: string;
  name: string;
  status: CategoryLifecycleStatus;
  verificationStatus?: RuleVerificationStatus;
  description: string;
  studyMaterialRef: string;
  suitableBorrowerTypes?: string[];
  fundingPurposes?: string[];
  financialRequirements?: string[];
  collateralRequirements?: string[];
  requiredDocuments?: string[];
  restrictionsAndExclusions?: string[];
  sourceDocumentIds?: string[];
  attributes: KeyValueAttribute[];
  baselineRules: ConfigurableRuleField[];
  isFictionalDemo: boolean;
  updatedAt: string;
}

export interface ProductCategory {
  id: string;
  slotNumber: number;
  code: string;
  name: string;
  status: CategoryLifecycleStatus;
  description: string;
  studyMaterialStatus: StudyMaterialStatus;
  studyMaterialRef: string;
  suitableBorrowerTypes?: string[];
  fundingPurposes?: string[];
  restrictionsAndExclusions?: string[];
  sourceDocumentIds?: string[];
  attributes: KeyValueAttribute[];
  baselineRules: ConfigurableRuleField[];
  subProducts: SubProduct[];
  isFictionalDemo: boolean;
  updatedAt: string;
}

export type EntityStructureType =
  | 'individual'
  | 'proprietorship'
  | 'partnership'
  | 'llp'
  | 'private_limited'
  | 'public_limited'
  | 'trust_society';

export type FundingPurposeCategory =
  | 'working_capital'
  | 'machinery_equipment'
  | 'commercial_property'
  | 'invoice_discounting'
  | 'debt_consolidation'
  | 'project_expansion'
  | 'trade_import_export'
  | 'general_business';

export type ProfitabilityStatus =
  | 'profitable_2plus_years'
  | 'profitable_1_year'
  | 'breakeven_or_early'
  | 'loss_making'
  | 'not_provided';

export type AssessmentStatus = 'draft' | 'submitted' | 'evaluated';

export interface RuleCheckDetail {
  ruleId: string;
  stage: RuleStage;
  label: string;
  status: 'passed' | 'failed' | 'missing_data';
  passed: boolean;
  isMandatory: boolean;
  actualSummary: string;
  expectedSummary: string;
}

export type EligibilityStatus =
  | 'eligible'
  | 'incomplete_data'
  | 'ineligible'
  | 'pending_verification'
  | 'placeholder';

export type BaselineOutcome =
  | 'baseline_aligned'
  | 'outside_baseline_bounds'
  | 'incomplete_information'
  | 'configured_no_rules'
  | 'awaiting_study_material'
  | 'archived_excluded';

export interface RankedSubProductMatch {
  subProductId: string;
  subProductCode: string;
  subProductName: string;
  categoryId: string;
  categorySlotNumber: number;
  categoryCode: string;
  categoryName: string;
  suitabilityScore: number;
  stage1RequirementMatched: boolean;
  eligibilityStatus: EligibilityStatus;
  reasonsForMatching: string[];
  failedRequirements: string[];
  missingInformation: string[];
  requiredDocuments: string[];
  sourceDocuments: Array<{ id: string; fileName: string; webViewLink: string }>;
  ruleChecks: RuleCheckDetail[];
  isFictionalDemo: boolean;
}

export interface SubProductEvaluationResult {
  subProductId: string;
  code: string;
  name: string;
  status: CategoryLifecycleStatus;
  outcome: BaselineOutcome;
  eligibilityStatus: EligibilityStatus;
  suitabilityScore: number;
  reasonsForMatching: string[];
  failedRequirements: string[];
  missingInformation: string[];
  checks: RuleCheckDetail[];
  isFictionalDemo: boolean;
}

export interface CategoryEvaluationResult {
  categoryId: string;
  slotNumber: number;
  code: string;
  displayName: string;
  isPlaceholder: boolean;
  isFictionalDemo: boolean;
  stage1Matched: boolean;
  outcome: BaselineOutcome;
  eligibilityStatus: EligibilityStatus;
  suitabilityScore: number;
  categoryChecks: RuleCheckDetail[];
  subProductResults: SubProductEvaluationResult[];
}

export interface AIAdvisoryExplanation {
  generatedAt: string;
  modelName: string;
  datasetContext: 'official_catalog' | 'fictional_demo_sandbox';
  borrowerRequirementSummary: string;
  deterministicOutcomeNarrative: string;
  employeeFollowUpChecklist: string[];
  governanceBoundaryNote: string;
}

export interface MatchingEvaluationRecord {
  evaluationId: string;
  assessmentId: string;
  evaluatedAt: string;
  evaluatedBy?: string;
  datasetMode: 'official_catalog' | 'fictional_demo_sandbox';
  engineStageLabel: string;
  totalCategoriesInspected: number;
  configuredCategoriesCount: number;
  placeholderCategoriesCount: number;
  alignedCategoriesCount: number;
  alignedSubProductsCount: number;
  top3SubProducts: RankedSubProductMatch[];
  alternativeSubProducts: RankedSubProductMatch[];
  categoryResults: CategoryEvaluationResult[];
  aiExplanation: AIAdvisoryExplanation | null;
}

export interface BorrowerAssessment {
  id: string;
  referenceCode: string;
  applicantLabel: string;
  entityType: EntityStructureType;
  industrySector?: string;
  businessVintageYears?: number | null;
  creditScore?: number | null;
  existingEmiObligations?: number | null;
  profitabilityStatus?: ProfitabilityStatus;
  gstTaxCompliant?: 'yes' | 'no' | 'not_provided';
  fundingPurpose?: FundingPurposeCategory;
  dynamicPurposeAnswers?: Record<string, string>;
  assignedOfficer: string;
  branchOrDesk: string;
  requestedAmount: number;
  currency: string;
  requestedTenureMonths: number;
  annualTurnoverOrIncome: number;
  collateralAvailable: boolean;
  collateralType?: string;
  collateralValue?: number | null;
  collateralDescription: string;
  statedPurpose: string;
  advisorNotes: string;
  customAttributes: KeyValueAttribute[];
  status: AssessmentStatus;
  isFictionalDemo: boolean;
  createdAt: string;
  updatedAt: string;
  latestEvaluation: MatchingEvaluationRecord | null;
}

export interface PolicyReviewLogEntry {
  id: string;
  timestamp: string;
  actorEmail: string;
  actorRole: UserRole;
  actionType:
    | 'pdf_uploaded'
    | 'pdf_linked'
    | 'ai_draft_extracted'
    | 'rule_verified'
    | 'rule_rejected'
    | 'product_updated'
    | 'sheets_initialized';
  targetEntityType: 'category' | 'sub_product' | 'rule' | 'document' | 'workspace';
  targetEntityId: string;
  summary: string;
}

export interface SystemSettings {
  organizationName: string;
  internalUnitName: string;
  defaultCurrency: string;
  enableDemoSandbox: boolean;
  strict18CategorySlots: boolean;
  enableAiExplanationService: boolean;
  showFictionalRecordsInTables: boolean;
  themeMode: 'light' | 'dark';
  updatedAt: string;
}

export interface BootstrapPayload {
  categories: ProductCategory[];
  fictionalDemoCategories: ProductCategory[];
  assessments: BorrowerAssessment[];
  documents: ProductDocumentRecord[];
  policyLogs: PolicyReviewLogEntry[];
  settings: SystemSettings;
  workspaceConfig: WorkspaceConnectionConfig;
  currentUser: AuthenticatedGoogleUser | null;
}

export interface DriveScannedProductFile {
  driveFileId: string;
  fileName: string;
  cleanSubProductName: string;
  mimeType: string;
  webViewLink: string;
  modifiedTime?: string;
}

export interface DriveScannedProductFolder {
  folderId: string;
  folderName: string;
  cleanCategoryName: string;
  slotNumber: number;
  files: DriveScannedProductFile[];
}

export interface DriveStudyMaterialScanResult {
  found: boolean;
  searchedQuery: string;
  rootFolder: DriveFileSummary | null;
  candidateFolders: DriveFileSummary[];
  productFolders: DriveScannedProductFolder[];
  totalFolders: number;
  totalFiles: number;
}
