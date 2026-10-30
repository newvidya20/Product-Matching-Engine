import fs from 'node:fs';
import path from 'node:path';
import type {
  BorrowerAssessment,
  PolicyReviewLogEntry,
  ProductCategory,
  ProductDocumentRecord,
  SystemSettings,
  WorkspaceConnectionConfig,
} from '../src/types/domain.ts';

export interface PersistentWorkspaceState {
  categories: ProductCategory[];
  assessments: BorrowerAssessment[];
  documents: ProductDocumentRecord[];
  policyLogs: PolicyReviewLogEntry[];
  settings: SystemSettings;
  workspaceConfig: WorkspaceConnectionConfig;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'loanbazaar-workspace-state.json');

export const DEFAULT_MAIN_CATEGORY_SLOTS = 19;

export function createInitialEmptyCategories(
  slotCount = DEFAULT_MAIN_CATEGORY_SLOTS
): ProductCategory[] {
  const now = new Date().toISOString();
  return Array.from({ length: slotCount }, (_, index) => {
    const slotNumber = index + 1;
    const padded = String(slotNumber).padStart(2, '0');
    return {
      id: `cat-${padded}`,
      slotNumber,
      code: `LB-CAT-${padded}`,
      name: '',
      status: 'placeholder',
      description: '',
      studyMaterialStatus: 'pending_upload',
      studyMaterialRef: '',
      suitableBorrowerTypes: [],
      fundingPurposes: [],
      restrictionsAndExclusions: [],
      sourceDocumentIds: [],
      attributes: [],
      baselineRules: [],
      subProducts: [],
      isFictionalDemo: false,
      updatedAt: now,
    };
  });
}

export function ensureMinimumCategorySlots(
  existing: ProductCategory[],
  minSlots = DEFAULT_MAIN_CATEGORY_SLOTS
): { categories: ProductCategory[]; upgraded: boolean } {
  const defaults = createInitialEmptyCategories(minSlots);
  const bySlot = new Set(existing.map((c) => c.slotNumber));
  const byId = new Set(existing.map((c) => c.id));
  let upgraded = false;
  const next = [...existing];

  for (const def of defaults) {
    if (!bySlot.has(def.slotNumber) && !byId.has(def.id)) {
      next.push(def);
      upgraded = true;
    }
  }

  if (upgraded) {
    next.sort((a, b) => a.slotNumber - b.slotNumber);
  }
  return { categories: next, upgraded };
}

export function getFictionalDemoCatalogOverlay(
  officialCategories: ProductCategory[]
): ProductCategory[] {
  const now = '2026-10-27T18:00:00.000Z';

  return officialCategories.map((cat) => {
    if (
      cat.status === 'active' ||
      cat.name.trim().length > 0 ||
      cat.subProducts.length > 0
    ) {
      return cat;
    }

    if (cat.slotNumber === 1) {
      return {
        ...cat,
        name: '[FICTIONAL DEMO] Sample Category Slot 01 — Standard Facility Group',
        status: 'active',
        description:
          'Fictional placeholder structure demonstrating how a main category groups multiple configurable sub-products.',
        studyMaterialStatus: 'configured',
        studyMaterialRef: 'DEMO-REF-001 (Fictional Sample)',
        suitableBorrowerTypes: ['proprietorship', 'partnership', 'llp', 'private_limited'],
        fundingPurposes: ['working_capital', 'machinery_equipment', 'general_business'],
        isFictionalDemo: true,
        updatedAt: now,
        attributes: [
          { id: 'demo-attr-1', key: 'Sample Repayment Cadence', value: 'Monthly (Fictional)' },
        ],
        baselineRules: [
          {
            id: 'demo-rule-cat1-min',
            stage: 'stage1_requirement',
            targetField: 'requestedAmount',
            label: '[FICTIONAL] Minimum Requested Facility',
            operator: 'number_min',
            expectedValue: 250000,
            isMandatory: true,
            verificationStatus: 'verified',
            notes: 'Fictional sample floor parameter for UI testing only.',
          },
        ],
        subProducts: [
          {
            id: 'demo-sub-01a',
            categoryId: cat.id,
            code: 'DEMO-SP-01A',
            name: '[FICTIONAL DEMO] Sample Sub-Product 01-A (Compact Tier)',
            status: 'active',
            verificationStatus: 'verified',
            description: 'Fictional sub-product tier illustrating lower-bound structural checks.',
            studyMaterialRef: 'DEMO-REF-001-A',
            suitableBorrowerTypes: ['proprietorship', 'partnership', 'llp', 'private_limited'],
            fundingPurposes: ['working_capital', 'general_business'],
            requiredDocuments: ['[FICTIONAL] Sample KYC & Registration Proof'],
            isFictionalDemo: true,
            updatedAt: now,
            attributes: [
              { id: 'dsa-1', key: 'Fictional Band', value: 'INR 2.5L – INR 25L' },
            ],
            baselineRules: [
              {
                id: 'dr-01a-1',
                stage: 'stage2_eligibility',
                targetField: 'requestedAmount',
                label: '[FICTIONAL] Max Facility Cap',
                operator: 'number_max',
                expectedValue: 2500000,
                isMandatory: true,
                verificationStatus: 'verified',
                notes: 'Fictional upper bound check.',
              },
              {
                id: 'dr-01a-2',
                stage: 'stage2_eligibility',
                targetField: 'requestedTenureMonths',
                label: '[FICTIONAL] Max Tenure Months',
                operator: 'number_max',
                expectedValue: 36,
                isMandatory: true,
                verificationStatus: 'verified',
                notes: 'Fictional tenure bound.',
              },
            ],
          },
          {
            id: 'demo-sub-01b',
            categoryId: cat.id,
            code: 'DEMO-SP-01B',
            name: '[FICTIONAL DEMO] Sample Sub-Product 01-B (Extended Tier)',
            status: 'active',
            verificationStatus: 'verified',
            description: 'Fictional sub-product tier illustrating mid-scale structural checks.',
            studyMaterialRef: 'DEMO-REF-001-B',
            suitableBorrowerTypes: ['llp', 'private_limited', 'public_limited'],
            fundingPurposes: ['machinery_equipment', 'working_capital', 'project_expansion'],
            requiredDocuments: ['[FICTIONAL] Sample Audited Financials (2 Years)'],
            isFictionalDemo: true,
            updatedAt: now,
            attributes: [
              { id: 'dsb-1', key: 'Fictional Band', value: 'INR 25L – INR 2.5Cr' },
            ],
            baselineRules: [
              {
                id: 'dr-01b-1',
                stage: 'stage2_eligibility',
                targetField: 'requestedAmount',
                label: '[FICTIONAL] Min Facility Floor',
                operator: 'number_min',
                expectedValue: 2500000,
                isMandatory: true,
                verificationStatus: 'verified',
                notes: 'Fictional minimum bound.',
              },
              {
                id: 'dr-01b-2',
                stage: 'stage2_eligibility',
                targetField: 'requestedAmount',
                label: '[FICTIONAL] Max Facility Cap',
                operator: 'number_max',
                expectedValue: 25000000,
                isMandatory: true,
                verificationStatus: 'verified',
                notes: 'Fictional upper bound.',
              },
              {
                id: 'dr-01b-3',
                stage: 'stage2_eligibility',
                targetField: 'businessVintageYears',
                label: '[FICTIONAL] Minimum Business Vintage (Years)',
                operator: 'number_min',
                expectedValue: 3,
                isMandatory: true,
                verificationStatus: 'verified',
                notes: 'Fictional vintage check.',
              },
            ],
          },
        ],
      };
    }

    if (cat.slotNumber === 2) {
      return {
        ...cat,
        name: '[FICTIONAL DEMO] Sample Category Slot 02 — Collateralized Structure',
        status: 'active',
        description:
          'Fictional placeholder category demonstrating collateral parameter verification across sub-products.',
        studyMaterialStatus: 'configured',
        studyMaterialRef: 'DEMO-REF-002 (Fictional Sample)',
        suitableBorrowerTypes: ['individual', 'proprietorship', 'partnership', 'llp', 'private_limited'],
        fundingPurposes: ['commercial_property', 'machinery_equipment', 'debt_consolidation'],
        isFictionalDemo: true,
        updatedAt: now,
        attributes: [],
        baselineRules: [
          {
            id: 'demo-rule-cat2-col',
            stage: 'stage2_eligibility',
            targetField: 'collateralAvailable',
            label: '[FICTIONAL] Collateral Availability Flag',
            operator: 'boolean_equals',
            expectedValue: true,
            isMandatory: true,
            verificationStatus: 'verified',
            notes: 'Fictional boolean flag check.',
          },
        ],
        subProducts: [
          {
            id: 'demo-sub-02a',
            categoryId: cat.id,
            code: 'DEMO-SP-02A',
            name: '[FICTIONAL DEMO] Sample Sub-Product 02-A (Long-Horizon Variant)',
            status: 'active',
            verificationStatus: 'verified',
            description: 'Fictional collateral-backed sub-product with extended tenure range.',
            studyMaterialRef: 'DEMO-REF-002-A',
            suitableBorrowerTypes: ['individual', 'proprietorship', 'llp', 'private_limited'],
            fundingPurposes: ['commercial_property', 'machinery_equipment', 'project_expansion'],
            requiredDocuments: ['[FICTIONAL] Sample Title & Valuation Placeholder'],
            isFictionalDemo: true,
            updatedAt: now,
            attributes: [],
            baselineRules: [
              {
                id: 'dr-02a-1',
                stage: 'stage2_eligibility',
                targetField: 'requestedAmount',
                label: '[FICTIONAL] Minimum Facility Amount',
                operator: 'number_min',
                expectedValue: 1000000,
                isMandatory: true,
                verificationStatus: 'verified',
                notes: 'Fictional minimum bound.',
              },
              {
                id: 'dr-02a-2',
                stage: 'stage2_eligibility',
                targetField: 'requestedTenureMonths',
                label: '[FICTIONAL] Maximum Tenure Months',
                operator: 'number_max',
                expectedValue: 120,
                isMandatory: true,
                verificationStatus: 'verified',
                notes: 'Fictional maximum tenure.',
              },
            ],
          },
        ],
      };
    }

    if (cat.slotNumber === 3) {
      return {
        ...cat,
        name: '[FICTIONAL DEMO] Sample Category Slot 03 — Commercial Entity Group',
        status: 'active',
        description:
          'Fictional placeholder category demonstrating turnover and credit score baseline validation.',
        studyMaterialStatus: 'configured',
        studyMaterialRef: 'DEMO-REF-003 (Fictional Sample)',
        suitableBorrowerTypes: ['private_limited', 'llp', 'partnership'],
        fundingPurposes: ['working_capital', 'invoice_discounting', 'machinery_equipment'],
        isFictionalDemo: true,
        updatedAt: now,
        attributes: [],
        baselineRules: [
          {
            id: 'demo-rule-cat3-turn',
            stage: 'stage2_eligibility',
            targetField: 'annualTurnoverOrIncome',
            label: '[FICTIONAL] Minimum Annual Turnover',
            operator: 'number_min',
            expectedValue: 5000000,
            isMandatory: true,
            verificationStatus: 'verified',
            notes: 'Fictional annual turnover threshold for sandbox testing.',
          },
        ],
        subProducts: [
          {
            id: 'demo-sub-03a',
            categoryId: cat.id,
            code: 'DEMO-SP-03A',
            name: '[FICTIONAL DEMO] Sample Sub-Product 03-A (Corporate Variant)',
            status: 'active',
            verificationStatus: 'verified',
            description: 'Fictional sub-product checking entity structure and credit bureau score.',
            studyMaterialRef: 'DEMO-REF-003-A',
            suitableBorrowerTypes: ['private_limited', 'llp'],
            fundingPurposes: ['working_capital', 'machinery_equipment', 'invoice_discounting'],
            requiredDocuments: ['[FICTIONAL] Sample GST Returns & Bureau Report'],
            isFictionalDemo: true,
            updatedAt: now,
            attributes: [],
            baselineRules: [
              {
                id: 'dr-03a-1',
                stage: 'stage2_eligibility',
                targetField: 'creditScore',
                label: '[FICTIONAL] Minimum Credit Bureau Score',
                operator: 'number_min',
                expectedValue: 700,
                isMandatory: true,
                verificationStatus: 'verified',
                notes: 'Fictional credit score check.',
              },
            ],
          },
        ],
      };
    }

    return cat;
  });
}

export function createInitialFictionalAssessments(): BorrowerAssessment[] {
  return [
    {
      id: 'demo-asmt-1001',
      referenceCode: 'LB-DEMO-1001',
      applicantLabel: '[FICTIONAL DEMO] Suryodaya Precision Components Pvt Ltd',
      entityType: 'private_limited',
      industrySector: 'Precision Engineering & Auto Components',
      businessVintageYears: 6,
      creditScore: 745,
      existingEmiObligations: 145000,
      profitabilityStatus: 'profitable_2plus_years',
      gstTaxCompliant: 'yes',
      fundingPurpose: 'machinery_equipment',
      dynamicPurposeAnswers: {
        equipmentCondition: 'New Domestic CNC Equipment',
        supplierQuotationReady: 'Yes',
        borrowerMarginPercent: '20%',
      },
      assignedOfficer: 'A. Deshmukh (Demo Desk)',
      branchOrDesk: 'West Zone — Commercial Desk',
      requestedAmount: 8500000,
      currency: 'INR',
      requestedTenureMonths: 60,
      annualTurnoverOrIncome: 42000000,
      collateralAvailable: true,
      collateralType: 'Industrial Unit & Machinery',
      collateralValue: 14000000,
      collateralDescription: 'Fictional sample industrial unit collateral record for UI testing.',
      statedPurpose: 'Fictional sample intake: CNC line expansion and working cycle buffer.',
      advisorNotes:
        'Fictional demonstration record created to verify two-stage matching and Google Sheets sync.',
      customAttributes: [],
      status: 'submitted',
      isFictionalDemo: true,
      createdAt: '2026-10-26T09:30:00.000Z',
      updatedAt: '2026-10-26T09:30:00.000Z',
      latestEvaluation: null,
    },
    {
      id: 'demo-asmt-1002',
      referenceCode: 'LB-DEMO-1002',
      applicantLabel: '[FICTIONAL DEMO] Kaveri Agro Distribution Proprietorship',
      entityType: 'proprietorship',
      industrySector: 'Agri Inputs & Distribution',
      businessVintageYears: 4,
      creditScore: null,
      existingEmiObligations: 25000,
      profitabilityStatus: 'profitable_1_year',
      gstTaxCompliant: 'yes',
      fundingPurpose: 'working_capital',
      dynamicPurposeAnswers: {
        receivableDays: '45 Days',
        inventoryHoldingDays: '30 Days',
      },
      assignedOfficer: 'R. Nair (Demo Desk)',
      branchOrDesk: 'South Zone — Regional Desk',
      requestedAmount: 1400000,
      currency: 'INR',
      requestedTenureMonths: 24,
      annualTurnoverOrIncome: 6800000,
      collateralAvailable: false,
      collateralType: '',
      collateralValue: null,
      collateralDescription: 'Unsecured intake request (Fictional sample).',
      statedPurpose: 'Fictional sample intake: seasonal inventory procurement (credit score omitted to demonstrate Missing Information detection).',
      advisorNotes:
        'Fictional demonstration record testing missing bureau score handling.',
      customAttributes: [],
      status: 'submitted',
      isFictionalDemo: true,
      createdAt: '2026-10-27T04:15:00.000Z',
      updatedAt: '2026-10-27T04:15:00.000Z',
      latestEvaluation: null,
    },
  ];
}

export function createDefaultSettings(): SystemSettings {
  return {
    organizationName: 'LoanBazaar Financial Services',
    internalUnitName: 'Internal Product Advisory & Matching Desk',
    defaultCurrency: 'INR',
    enableDemoSandbox: false,
    strict18CategorySlots: true,
    enableAiExplanationService: true,
    showFictionalRecordsInTables: true,
    themeMode: 'light',
    updatedAt: new Date().toISOString(),
  };
}

export function createDefaultWorkspaceConfig(): WorkspaceConnectionConfig {
  const envSheetId = (process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '').trim();
  return {
    spreadsheetId: envSheetId,
    spreadsheetTitle: envSheetId ? 'Configured LoanBazaar Sheet' : '',
    spreadsheetUrl: envSheetId
      ? `https://docs.google.com/spreadsheets/d/${envSheetId}/edit`
      : '',
    driveFolderId: '',
    driveFolderName: '',
    adminEmails: ['viloanbazzar@gmail.com'],
    employeeEmails: [],
    connectedByEmail: '',
    lastSyncedAt: '',
  };
}

export function loadDatabase(): PersistentWorkspaceState {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(CONFIG_FILE)) {
      const initial: PersistentWorkspaceState = {
        categories: createInitialEmptyCategories(),
        assessments: createInitialFictionalAssessments(),
        documents: [],
        policyLogs: [],
        settings: createDefaultSettings(),
        workspaceConfig: createDefaultWorkspaceConfig(),
      };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(initial, null, 2), 'utf-8');
      return initial;
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistentWorkspaceState>;
    const rawCats =
      Array.isArray(parsed.categories) && parsed.categories.length > 0
        ? parsed.categories
        : createInitialEmptyCategories();
    const { categories, upgraded } = ensureMinimumCategorySlots(rawCats);
    const loaded: PersistentWorkspaceState = {
      categories,
      assessments: Array.isArray(parsed.assessments)
        ? parsed.assessments
        : createInitialFictionalAssessments(),
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      policyLogs: Array.isArray(parsed.policyLogs) ? parsed.policyLogs : [],
      settings: {
        ...createDefaultSettings(),
        ...(parsed.settings || {}),
      },
      workspaceConfig: {
        ...createDefaultWorkspaceConfig(),
        ...(parsed.workspaceConfig || {}),
      },
    };
    if (upgraded) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(loaded, null, 2), 'utf-8');
    }
    return loaded;
  } catch {
    return {
      categories: createInitialEmptyCategories(),
      assessments: createInitialFictionalAssessments(),
      documents: [],
      policyLogs: [],
      settings: createDefaultSettings(),
      workspaceConfig: createDefaultWorkspaceConfig(),
    };
  }
}

export function saveDatabase(db: PersistentWorkspaceState): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(db, null, 2), 'utf-8');
}
