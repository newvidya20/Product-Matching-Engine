import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FileArchive,
  FileText,
  FolderSearch,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { apiClient } from '../api/client';
import { useAppState } from '../context/AppStateContext';
import {
  EmptyStatePanel,
  PageHeader,
  SegmentedControl,
  SlideOverDrawer,
} from '../components/ui/Primitives';
import type {
  CategoryLifecycleStatus,
  ConfigurableRuleField,
  DriveFileSummary,
  KeyValueAttribute,
  ProductCategory,
  ProductDocumentRecord,
  RuleOperator,
  RuleStage,
  StudyMaterialStatus,
  SubProduct,
  TargetIntakeField,
} from '../types/domain';
import {
  formatDateTime,
  getCategoryDisplayTitle,
  isCategoryConfigured,
} from '../utils/formatters';

type AdminTabId = 'master' | 'pdfs' | 'verification' | 'logs';

function parseDelimitedList(text: string): string[] {
  return text
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinDelimitedList(items?: string[]): string {
  return (items || []).join('\n');
}

function createEmptyRule(): ConfigurableRuleField {
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    stage: 'stage2_eligibility',
    targetField: 'requestedAmount',
    customKey: '',
    label: 'Minimum Facility Threshold',
    operator: 'number_min',
    expectedValue: 0,
    isMandatory: true,
    verificationStatus: 'verified',
    notes: '',
  };
}

function defaultOperatorForField(field: TargetIntakeField): RuleOperator {
  if (field === 'collateralAvailable') return 'boolean_equals';
  if (
    field === 'entityType' ||
    field === 'fundingPurpose' ||
    field === 'industrySector' ||
    field === 'profitabilityStatus' ||
    field === 'gstTaxCompliant'
  ) {
    return 'in_list';
  }
  if (field === 'customAttribute') return 'custom_Presence';
  return 'number_min';
}

function RuleListEditor({
  rules,
  onChange,
}: {
  rules: ConfigurableRuleField[];
  onChange: (next: ConfigurableRuleField[]) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const handleAdd = () => {
    onChange([...rules, createEmptyRule()]);
  };

  const handleUpdate = (
    id: string,
    patch: Partial<ConfigurableRuleField>
  ) => {
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const handleRemove = (id: string) => {
    onChange(rules.filter((r) => r.id !== id));
  };

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setIsOpen((prev) => !prev);
          }
        }}
        className="w-full flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 text-left transition-colors hover:bg-stone-100 cursor-pointer"
      >
        <div>
          <div className="text-xs font-semibold text-stone-900">
            Configurable Stage 1 & Stage 2 Rules ({rules.length})
          </div>
          <p className="text-[11px] text-stone-500">
            Only rules marked <strong className="text-emerald-700">verified</strong> are
            enforced during Stage 2 mandatory eligibility matching.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              handleAdd();
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-stone-700 bg-white border border-stone-200 hover:bg-stone-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Verified Rule</span>
          </button>
          <ChevronDown
            className={`w-4 h-4 text-stone-600 transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </div>
      </div>

      {isOpen && (
        rules.length === 0 ? (
          <div className="py-4 px-4 bg-stone-50 border border-stone-200/80 rounded-lg text-xs text-stone-500">
            No eligibility rules configured yet. Add verified rules manually or import
            approved product policy criteria.
          </div>
        ) : (
          <div className="divide-y divide-stone-200 border border-stone-200 rounded-lg bg-stone-50/40">
            {rules.map((rule) => {
              const verStatus = rule.verificationStatus || 'verified';
              return (
                <div key={rule.id} className="p-3.5 space-y-2.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          verStatus === 'verified'
                            ? 'font-semibold text-emerald-700'
                            : verStatus === 'rejected'
                            ? 'font-medium text-red-600'
                            : 'font-semibold text-amber-700'
                        }
                      >
                        {verStatus === 'verified'
                          ? 'Verified Rule'
                          : verStatus === 'rejected'
                          ? 'Rejected Draft'
                          : 'Draft · Needs Admin Verification'}
                      </span>
                      <span aria-hidden="true" className="text-stone-300">
                        ·
                      </span>
                      <select
                        value={rule.stage || 'stage2_eligibility'}
                        onChange={(e) =>
                          handleUpdate(rule.id, { stage: e.target.value as RuleStage })
                        }
                        className="px-2 py-0.5 bg-white border border-stone-300 rounded text-[11px] text-stone-700 focus:outline-none focus:border-orange-600"
                      >
                        <option value="stage1_requirement">
                          Stage 1 — Requirement Fit
                        </option>
                        <option value="stage2_eligibility">
                          Stage 2 — Eligibility Gate
                        </option>
                      </select>
                      <label className="inline-flex items-center gap-1 text-stone-600 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={rule.isMandatory !== false}
                          onChange={(e) =>
                            handleUpdate(rule.id, { isMandatory: e.target.checked })
                          }
                          className="w-3.5 h-3.5 rounded border-stone-300 text-orange-600"
                        />
                        <span>Mandatory</span>
                      </label>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        value={verStatus}
                        onChange={(e) =>
                          handleUpdate(rule.id, {
                            verificationStatus: e.target.value as
                              | 'draft'
                              | 'verified'
                              | 'rejected',
                          })
                        }
                        className="px-2 py-0.5 bg-white border border-stone-300 rounded text-[11px] text-stone-700 focus:outline-none focus:border-orange-600"
                      >
                        <option value="verified">Status: Verified</option>
                        <option value="draft">Status: Draft</option>
                        <option value="rejected">Status: Rejected</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => handleRemove(rule.id)}
                        aria-label="Delete rule parameter"
                        className="p-1 text-stone-400 hover:text-red-600 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                    <input
                      type="text"
                      value={rule.label}
                      onChange={(e) => handleUpdate(rule.id, { label: e.target.value })}
                      placeholder="Rule label"
                      className="sm:col-span-5 px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                    />
                    <select
                      value={rule.targetField}
                      onChange={(e) => {
                        const targetField = e.target.value as TargetIntakeField;
                        handleUpdate(rule.id, {
                          targetField,
                          operator: defaultOperatorForField(targetField),
                        });
                      }}
                      className="sm:col-span-4 px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                    >
                      <option value="requestedAmount">Requested Amount</option>
                      <option value="requestedTenureMonths">Tenure (Months)</option>
                      <option value="annualTurnoverOrIncome">Annual Turnover</option>
                      <option value="businessVintageYears">Business Vintage (Years)</option>
                      <option value="creditScore">Credit Bureau Score</option>
                      <option value="existingEmiObligations">Monthly EMI Obligations</option>
                      <option value="profitabilityStatus">Profitability Status</option>
                      <option value="gstTaxCompliant">GST / Tax Compliance</option>
                      <option value="collateralAvailable">Collateral Available Flag</option>
                      <option value="collateralValue">Collateral Value</option>
                      <option value="entityType">Entity Structure</option>
                      <option value="fundingPurpose">Funding Purpose</option>
                      <option value="industrySector">Industry Sector</option>
                      <option value="customAttribute">Custom Intake Key</option>
                    </select>
                    <select
                      value={rule.operator}
                      onChange={(e) =>
                        handleUpdate(rule.id, {
                          operator: e.target.value as RuleOperator,
                        })
                      }
                      className="sm:col-span-3 px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                    >
                      <option value="number_min">Minimum (&gt;=)</option>
                      <option value="number_max">Maximum (&lt;=)</option>
                      <option value="boolean_equals">Boolean Match</option>
                      <option value="text_equals">Exact Text Match</option>
                      <option value="in_list">In Comma List</option>
                      <option value="not_in_list">Excluded From List</option>
                      <option value="custom_Presence">Attribute Present</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5">
                    {rule.targetField === 'customAttribute' && (
                      <input
                        type="text"
                        value={rule.customKey || ''}
                        onChange={(e) =>
                          handleUpdate(rule.id, { customKey: e.target.value })
                        }
                        placeholder="Custom Intake Key Name"
                        className="sm:col-span-4 px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                      />
                    )}
                    <input
                      type="text"
                      value={String(rule.expectedValue)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const val =
                          rule.operator === 'number_min' || rule.operator === 'number_max'
                            ? Number(raw) || 0
                            : rule.operator === 'boolean_equals'
                            ? raw.toLowerCase() === 'true'
                            : raw;
                        handleUpdate(rule.id, { expectedValue: val });
                      }}
                      placeholder="Expected Value (e.g., 650, true, working_capital,machinery_equipment)"
                      className="sm:col-span-5 px-2.5 py-1.5 font-mono bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                    />
                    <input
                      type="text"
                      value={rule.notes}
                      onChange={(e) => handleUpdate(rule.id, { notes: e.target.value })}
                      placeholder="Policy source citation / section note"
                      className={`${
                        rule.targetField === 'customAttribute'
                          ? 'sm:col-span-3'
                          : 'sm:col-span-7'
                      } px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

function AttributeListEditor({
  attributes,
  onChange,
}: {
  attributes: KeyValueAttribute[];
  onChange: (next: KeyValueAttribute[]) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="space-y-2.5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setIsOpen((prev) => !prev);
          }
        }}
        className="w-full flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 text-left transition-colors hover:bg-stone-100 cursor-pointer"
      >
        <div className="text-xs font-semibold text-stone-900">
          Configurable Metadata Attributes ({attributes.length})
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onChange([
                ...attributes,
                { id: `attr-${Date.now()}`, key: '', value: '' },
              ]);
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-stone-700 bg-white border border-stone-200 hover:bg-stone-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Attribute</span>
          </button>
          <ChevronDown
            className={`w-4 h-4 text-stone-600 transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </div>
      </div>

      {isOpen && attributes.length > 0 && (
        <div className="space-y-2">
          {attributes.map((attr) => (
            <div key={attr.id} className="grid grid-cols-12 gap-2 items-center">
              <input
                type="text"
                value={attr.key}
                onChange={(e) =>
                  onChange(
                    attributes.map((a) =>
                      a.id === attr.id ? { ...a, key: e.target.value } : a
                    )
                  )
                }
                placeholder="Attribute Key"
                className="col-span-5 px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
              />
              <input
                type="text"
                value={attr.value}
                onChange={(e) =>
                  onChange(
                    attributes.map((a) =>
                      a.id === attr.id ? { ...a, value: e.target.value } : a
                    )
                  )
                }
                placeholder="Attribute Value"
                className="col-span-6 px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
              />
              <button
                type="button"
                onClick={() =>
                  onChange(attributes.filter((a) => a.id !== attr.id))
                }
                aria-label="Delete attribute"
                className="col-span-1 p-1.5 text-stone-400 hover:text-red-600 justify-self-end cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface PendingDraftRuleItem {
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  subProductId?: string;
  subProductCode?: string;
  subProductName?: string;
  rule: ConfigurableRuleField;
}

export function AdminProductManagementModule() {
  const {
    state,
    navigateTo,
    openAdminTab,
    setSelectedAdminCategoryId,
    saveCategory,
    addCategorySlot,
    addSubProduct,
    saveSubProduct,
    removeSubProduct,
    uploadPdfToDrive,
    linkExistingDrivePdf,
    extractPdfDraftWithAi,
    verifyRuleDecision,
    verifyAllDraftRules,
    importCatalogConfig,
    resetCatalogPlaceholders,
    notify,
  } = useAppState();

  const activeTab: AdminTabId = state.selectedAdminTab;
  const setActiveTab = (tab: AdminTabId) => openAdminTab(tab);

  const selectedCategory: ProductCategory | null =
    state.categories.find((c) => c.id === state.selectedAdminCategoryId) ??
    state.categories[0] ??
    null;

  // Category editor local state
  const [catCode, setCatCode] = useState('');
  const [catName, setCatName] = useState('');
  const [catStatus, setCatStatus] = useState<CategoryLifecycleStatus>('placeholder');
  const [studyStatus, setStudyStatus] = useState<StudyMaterialStatus>('pending_upload');
  const [studyRef, setStudyRef] = useState('');
  const [catDesc, setCatDesc] = useState('');
  const [catBorrowerTypesText, setCatBorrowerTypesText] = useState('');
  const [catPurposesText, setCatPurposesText] = useState('');
  const [catExclusionsText, setCatExclusionsText] = useState('');
  const [catAttributes, setCatAttributes] = useState<KeyValueAttribute[]>([]);
  const [catRules, setCatRules] = useState<ConfigurableRuleField[]>([]);

  // Sub-product drawer state
  const [editingSubProduct, setEditingSubProduct] = useState<SubProduct | null>(null);
  const [confirmDeleteSubId, setConfirmDeleteSubId] = useState<string | null>(null);
  const [isSubProductsOpen, setIsSubProductsOpen] = useState(false);

  // PDF upload & Drive picker state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pdfReferencesOpen, setPdfReferencesOpen] = useState(false);
  const [pdfTargetCategoryId, setPdfTargetCategoryId] = useState<string>(
    selectedCategory?.id || 'cat-01'
  );
  const [pdfTargetSubProductId, setPdfTargetSubProductId] = useState<string>('');
  const [driveSearchQuery, setDriveSearchQuery] = useState('');
  const [driveFolderOnly, setDriveFolderOnly] = useState(false);
  const [drivePdfResults, setDrivePdfResults] = useState<DriveFileSummary[]>([]);
  const [isSearchingDrive, setIsSearchingDrive] = useState(false);
  const [inspectedDoc, setInspectedDoc] = useState<ProductDocumentRecord | null>(null);

  // Draft rule inline edits keyed by ruleId
  const [draftEdits, setDraftEdits] = useState<
    Record<string, Partial<ConfigurableRuleField>>
  >({});

  // Import JSON drawer state
  const [importDrawerOpen, setImportDrawerOpen] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmResetAll, setConfirmResetAll] = useState(false);

  useEffect(() => {
    if (!selectedCategory) return;
    setCatCode(selectedCategory.code);
    setCatName(selectedCategory.name);
    setCatStatus(selectedCategory.status);
    setStudyStatus(selectedCategory.studyMaterialStatus);
    setStudyRef(selectedCategory.studyMaterialRef);
    setCatDesc(selectedCategory.description);
    setCatBorrowerTypesText(joinDelimitedList(selectedCategory.suitableBorrowerTypes));
    setCatPurposesText(joinDelimitedList(selectedCategory.fundingPurposes));
    setCatExclusionsText(
      joinDelimitedList(selectedCategory.restrictionsAndExclusions)
    );
    setCatAttributes(selectedCategory.attributes);
    setCatRules(selectedCategory.baselineRules);
  }, [selectedCategory]);

  // Collect all draft rules across categories and sub-products
  const pendingDraftRules = useMemo<PendingDraftRuleItem[]>(() => {
    const list: PendingDraftRuleItem[] = [];
    for (const cat of state.categories) {
      for (const r of cat.baselineRules) {
        if (r.verificationStatus === 'draft') {
          list.push({
            categoryId: cat.id,
            categoryCode: cat.code,
            categoryName: getCategoryDisplayTitle(cat),
            rule: r,
          });
        }
      }
      for (const sp of cat.subProducts) {
        for (const r of sp.baselineRules) {
          if (r.verificationStatus === 'draft') {
            list.push({
              categoryId: cat.id,
              categoryCode: cat.code,
              categoryName: getCategoryDisplayTitle(cat),
              subProductId: sp.id,
              subProductCode: sp.code,
              subProductName: sp.name || sp.code,
              rule: r,
            });
          }
        }
      }
    }
    return list;
  }, [state.categories]);

  // RBAC Guard: Employees cannot modify Product Master, upload PDFs, or verify rules
  if (state.currentUser?.role === 'employee') {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Admin Product Management"
          description="Product reference administration and local policy-rule review are available in this workspace."
          metadataItems={[
            `Signed in as ${state.currentUser.email}`,
            'Role: Employee Access',
          ]}
        />
        <EmptyStatePanel
          icon={<Lock className="w-6 h-6" />}
          title="Administrator Authorization Required"
          description="Your Google Workspace account is assigned Employee permissions. You can create borrower assessments, run Two-Stage Product Matching, and inspect the Product Directory and Assessment History. Ask a LoanBazaar Administrator to add your email to the Admin Access list in Settings if you need to manage products or verify extracted PDF rules."
          actionLabel="Go to New Borrower Assessment"
          onAction={() => navigateTo('new-assessment')}
        />
      </div>
    );
  }

  const pdfTargetCategory =
    state.categories.find((c) => c.id === pdfTargetCategoryId) ??
    state.categories[0] ??
    null;

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCategory) return;
    await saveCategory(selectedCategory.id, {
      code: catCode,
      name: catName,
      status: catStatus,
      studyMaterialStatus: studyStatus,
      studyMaterialRef: studyRef,
      description: catDesc,
      suitableBorrowerTypes: parseDelimitedList(catBorrowerTypesText),
      fundingPurposes: parseDelimitedList(catPurposesText),
      restrictionsAndExclusions: parseDelimitedList(catExclusionsText),
      attributes: catAttributes.filter((a) => a.key.trim().length > 0),
      baselineRules: catRules,
    });
  };

  const handleCreateSubProduct = async () => {
    if (!selectedCategory) return;
    const created = await addSubProduct(selectedCategory.id, {
      name: '',
      status: 'placeholder',
      description: '',
    });
    if (created) {
      setEditingSubProduct(created);
    }
  };

  const handleSaveSubProductDrawer = async () => {
    if (!selectedCategory || !editingSubProduct) return;
    await saveSubProduct(selectedCategory.id, editingSubProduct.id, {
      code: editingSubProduct.code,
      name: editingSubProduct.name,
      status: editingSubProduct.status,
      verificationStatus: editingSubProduct.verificationStatus,
      description: editingSubProduct.description,
      studyMaterialRef: editingSubProduct.studyMaterialRef,
      suitableBorrowerTypes: editingSubProduct.suitableBorrowerTypes || [],
      fundingPurposes: editingSubProduct.fundingPurposes || [],
      financialRequirements: editingSubProduct.financialRequirements || [],
      collateralRequirements: editingSubProduct.collateralRequirements || [],
      requiredDocuments: editingSubProduct.requiredDocuments || [],
      restrictionsAndExclusions: editingSubProduct.restrictionsAndExclusions || [],
      attributes: editingSubProduct.attributes.filter((a) => a.key.trim().length > 0),
      baselineRules: editingSubProduct.baselineRules,
    });
    setEditingSubProduct(null);
  };

  const handleLocalPdfSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      notify('error', 'Please select a valid PDF document (.pdf).');
      return;
    }

    const base64Pdf = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result || '');
        const commaIndex = res.indexOf(',');
        resolve(commaIndex >= 0 ? res.slice(commaIndex + 1) : res);
      };
      reader.onerror = () => reject(new Error('Failed to read PDF file.'));
      reader.readAsDataURL(file);
    });

    await uploadPdfToDrive({
      fileName: file.name,
      base64Pdf,
      categoryId: pdfTargetCategoryId,
      subProductId: pdfTargetSubProductId || undefined,
    });
  };

  const handleSearchDrivePdfs = async () => {
    setIsSearchingDrive(true);
    try {
      const res = await apiClient.listDrivePdfs(driveSearchQuery, driveFolderOnly);
      setDrivePdfResults(res.files);
    } catch (err) {
      notify(
        'error',
        err instanceof Error
          ? err.message
          : 'Sign in with Google to browse Google Drive PDFs.'
      );
    } finally {
      setIsSearchingDrive(false);
    }
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(state.categories, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `loanbazaar-catalog-config-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleImportSubmit = async () => {
    setImportError(null);
    try {
      const parsed = JSON.parse(importJsonText);
      const categoriesArray = Array.isArray(parsed) ? parsed : parsed.categories;
      if (!Array.isArray(categoriesArray)) {
        setImportError('Expected a JSON array of category records.');
        return;
      }
      const ok = await importCatalogConfig(categoriesArray);
      if (ok) {
        setImportDrawerOpen(false);
        setImportJsonText('');
      }
    } catch {
      setImportError('Invalid JSON syntax. Paste a valid JSON catalog array.');
    }
  };

  const categoryLinkedDocs = selectedCategory
    ? state.documents.filter((d) => d.categoryId === selectedCategory.id)
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin Product Management"
        description="Review product categories and sub-products in the active catalogue and ensure policy alignment before publication."
        metadataItems={[
          `${state.categories.length} Category Slots`,
          `${state.documents.length} linked product references`,
          `${pendingDraftRules.length} draft rules awaiting verification`,
        ]}
        actions={
          <>
            <button
              type="button"
              onClick={handleExportJson}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-200 hover:bg-stone-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export JSON</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setImportError(null);
                setImportDrawerOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-200 hover:bg-stone-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Import JSON</span>
            </button>
            {confirmResetAll ? (
              <button
                type="button"
                onClick={() => {
                  setConfirmResetAll(false);
                  void resetCatalogPlaceholders();
                }}
                onBlur={() => setConfirmResetAll(false)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>Confirm Reset All {state.categories.length || 19} Slots</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmResetAll(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-stone-600 bg-white border border-stone-200 hover:bg-stone-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Placeholders</span>
              </button>
            )}
          </>
        }
      />

      {/* Sub-navigation across the 4 Admin Workflows */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <SegmentedControl<AdminTabId>
          options={[
            {
              value: 'master',
              label: `1. Product Master (${state.categories.length || 19} Slots)`,
              count: state.categories.length,
            },
            {
              value: 'verification',
              label: '2. Rule Verification Queue',
              count: pendingDraftRules.length,
            },
            {
              value: 'logs',
              label: '3. Policy Review Log',
              count: state.policyLogs.length,
            },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />

      </div>

      {/* ===================================================================== */}
      {/* TAB 1: PRODUCT MASTER (18 SLOTS & UNLIMITED SUB-PRODUCTS)             */}
      {/* ===================================================================== */}
      {activeTab === 'master' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: 18 Category Slot Selector */}
          <aside className="lg:col-span-4 bg-white border border-stone-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3.5 border-b border-stone-200 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-stone-900">
                Main Category Slots ({state.categories.length})
              </span>
              {!state.settings.strict18CategorySlots && (
                <button
                  type="button"
                  onClick={() => void addCategorySlot({})}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-orange-700 hover:bg-orange-50 rounded-md cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Slot</span>
                </button>
              )}
            </div>

            <div className="max-h-[680px] overflow-y-auto divide-y divide-stone-200">
              {state.categories.map((cat) => {
                const active = selectedCategory?.id === cat.id;
                const configured = isCategoryConfigured(cat);
                const catDraftCount =
                  cat.baselineRules.filter((r) => r.verificationStatus === 'draft')
                    .length +
                  cat.subProducts.reduce(
                    (acc, sp) =>
                      acc +
                      sp.baselineRules.filter((r) => r.verificationStatus === 'draft')
                        .length,
                    0
                  );

                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedAdminCategoryId(cat.id)}
                    className={`w-full px-4 py-3 text-left flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                      active ? 'bg-orange-50/80' : 'hover:bg-stone-50'
                    }`}
                  >
                    <div className="min-w-0 flex items-center gap-3">
                      <span
                        className={`font-mono tabular-nums text-xs w-6 shrink-0 ${
                          active ? 'text-orange-700 font-semibold' : 'text-stone-400'
                        }`}
                      >
                        {String(cat.slotNumber).padStart(2, '0')}
                      </span>
                      <div className="min-w-0">
                        <div
                          className={`text-xs truncate ${
                            active
                              ? 'font-semibold text-orange-950'
                              : configured
                              ? 'font-medium text-stone-900'
                              : 'text-stone-500'
                          }`}
                        >
                          {getCategoryDisplayTitle(cat)}
                        </div>
                        <div className="text-[11px] text-stone-400 flex items-center gap-1.5">
                          <span className="font-mono">{cat.code}</span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">
                            {cat.subProducts.length} sub-products
                          </span>
                          {catDraftCount > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-amber-700 font-medium tabular-nums">
                                {catDraftCount} draft
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Right Column: Category & Unlimited Sub-Products Editor */}
          {selectedCategory && (
            <div className="lg:col-span-8 bg-white border border-stone-200 rounded-xl divide-y divide-stone-200">
              <form
                onSubmit={(e) => void handleSaveCategory(e)}
                className="p-6 space-y-6"
              >
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono text-stone-500">
                      Slot {String(selectedCategory.slotNumber).padStart(2, '0')} ·{' '}
                      {selectedCategory.code}
                    </div>
                    <h2 className="text-base font-semibold text-stone-900 font-display mt-0.5">
                      Main Category Configuration
                    </h2>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={state.isMutating}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>Save Category Slot</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-stone-700">
                      Official Category Name
                    </label>
                    <input
                      type="text"
                      value={catName}
                      onChange={(e) => setCatName(e.target.value)}
                      placeholder="Leave blank to keep as Empty Placeholder Slot"
                      className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-stone-700">
                      Internal Category Code
                    </label>
                    <input
                      type="text"
                      value={catCode}
                      onChange={(e) => setCatCode(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-stone-700">
                      Slot Lifecycle Status
                    </label>
                    <select
                      value={catStatus}
                      onChange={(e) =>
                        setCatStatus(e.target.value as CategoryLifecycleStatus)
                      }
                      className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                    >
                      <option value="placeholder">Placeholder (Unconfigured)</option>
                      <option value="active">Active (Configured for Engine)</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-stone-700">
                      Product Reference Readiness
                    </label>
                    <select
                      value={studyStatus}
                      onChange={(e) =>
                        setStudyStatus(e.target.value as StudyMaterialStatus)
                      }
                      className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                    >
                      <option value="pending_upload">Awaiting Product Reference</option>
                      <option value="draft_extracted">
                        Draft Extracted · Pending Verification
                      </option>
                      <option value="in_review">Material Under Review</option>
                      <option value="configured">Verified & Active</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-stone-700">
                    Product Reference / Circular Version
                  </label>
                  <input
                    type="text"
                    value={studyRef}
                    onChange={(e) => setStudyRef(e.target.value)}
                    placeholder="e.g., Official Policy Circular ID or Google Drive PDF Filename"
                    className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                  />
                </div>

                {categoryLinkedDocs.length > 0 && (
                  <div className="space-y-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setPdfReferencesOpen((prev) => !prev)}
                      className="w-full flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 text-left transition-colors hover:bg-stone-100"
                    >
                      <div className="font-medium text-stone-700">
                        Linked Product References ({categoryLinkedDocs.length})
                      </div>
                      <ChevronDown
                        className={`w-4 h-4 text-stone-600 transition-transform ${
                          pdfReferencesOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    {pdfReferencesOpen && (
                      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-3">
                        {categoryLinkedDocs.map((doc) => (
                          <a
                            key={doc.id}
                            href={doc.webViewLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-orange-700 hover:underline font-medium"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            <span>{doc.fileName}</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-stone-700">
                    Category Scope Description
                  </label>
                  <textarea
                    rows={2}
                    value={catDesc}
                    onChange={(e) => setCatDesc(e.target.value)}
                    placeholder="Enter official scope notes..."
                    className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-stone-700">
                      Suitable Borrower Types (one per line)
                    </label>
                    <textarea
                      rows={3}
                      value={catBorrowerTypesText}
                      onChange={(e) => setCatBorrowerTypesText(e.target.value)}
                      placeholder="e.g., private_limited&#10;llp"
                      className="w-full px-3 py-2 text-xs bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-stone-700">
                      Supported Funding Purposes (one per line)
                    </label>
                    <textarea
                      rows={3}
                      value={catPurposesText}
                      onChange={(e) => setCatPurposesText(e.target.value)}
                      placeholder="e.g., working_capital&#10;machinery_equipment"
                      className="w-full px-3 py-2 text-xs bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-stone-700">
                      Restrictions & Exclusions (one per line)
                    </label>
                    <textarea
                      rows={3}
                      value={catExclusionsText}
                      onChange={(e) => setCatExclusionsText(e.target.value)}
                      placeholder="Policy exclusions..."
                      className="w-full px-3 py-2 text-xs bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                    />
                  </div>
                </div>

                <div className="pt-4 border-t border-stone-200">
                  <AttributeListEditor
                    attributes={catAttributes}
                    onChange={setCatAttributes}
                  />
                </div>

                <div className="pt-4 border-t border-stone-200">
                  <RuleListEditor rules={catRules} onChange={setCatRules} />
                </div>
              </form>

              {/* Unlimited Sub-Products Manager */}
              <div className="p-6 space-y-4">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setIsSubProductsOpen((prev) => !prev)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setIsSubProductsOpen((prev) => !prev);
                    }
                  }}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-3 text-left transition-colors hover:bg-stone-100 cursor-pointer"
                >
                  <div>
                    <h3 className="text-sm font-semibold text-stone-900 font-display">
                      Sub-Products in Slot{' '}
                      {String(selectedCategory.slotNumber).padStart(2, '0')} (
                      {selectedCategory.subProducts.length})
                    </h3>
                    <p className="text-xs text-stone-500 mt-0.5">
                      Unlimited sub-products with source Drive PDFs, Stage 1 & Stage 2
                      rules, required documents, and collateral criteria.
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={state.isMutating}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleCreateSubProduct();
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-amber-950 bg-amber-400 hover:bg-amber-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Sub-Product</span>
                    </button>
                    <ChevronDown
                      className={`w-4 h-4 text-stone-600 transition-transform ${
                        isSubProductsOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </div>
                </div>

                {isSubProductsOpen && (
                  selectedCategory.subProducts.length === 0 ? (
                    <div className="py-8 px-4 text-center bg-stone-50/70 border border-stone-200/80 rounded-lg text-xs text-stone-500">
                      No sub-products created under this category yet. Upload & extract a
                      product PDF in Tab 2 or click &ldquo;Add Sub-Product&rdquo; above.
                    </div>
                  ) : (
                    <div className="divide-y divide-stone-200 border border-stone-200 rounded-lg">
                      {selectedCategory.subProducts.map((sp) => {
                        const isConfirming = confirmDeleteSubId === sp.id;
                        const verifiedCount = sp.baselineRules.filter(
                          (r) => (r.verificationStatus || 'verified') === 'verified'
                        ).length;
                        const draftCount = sp.baselineRules.filter(
                          (r) => r.verificationStatus === 'draft'
                        ).length;

                        return (
                          <div
                            key={sp.id}
                            className="px-4 py-3 flex items-center justify-between gap-4 text-xs hover:bg-stone-50/80"
                          >
                            <div className="min-w-0">
                              <div className="font-medium text-stone-900 truncate">
                                {sp.name || 'Empty Sub-Product Placeholder'}
                              </div>
                              <div className="text-[11px] text-stone-500 flex flex-wrap items-center gap-1.5">
                                <span className="font-mono">{sp.code}</span>
                                <span aria-hidden="true">·</span>
                                <span>{sp.status}</span>
                                <span aria-hidden="true">·</span>
                                <span className="text-emerald-700 font-mono tabular-nums">
                                  {verifiedCount} verified rules
                                </span>
                                {draftCount > 0 && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="text-amber-700 font-semibold font-mono tabular-nums">
                                      {draftCount} draft rules
                                    </span>
                                  </>
                                )}
                                {(sp.sourceDocumentIds?.length || 0) > 0 && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="tabular-nums">
                                      {sp.sourceDocumentIds?.length} PDF(s)
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => setEditingSubProduct({ ...sp })}
                                className="px-2.5 py-1 text-xs font-medium text-orange-700 hover:bg-orange-50 rounded-md cursor-pointer"
                              >
                                Configure
                              </button>
                              {isConfirming ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setConfirmDeleteSubId(null);
                                    void removeSubProduct(selectedCategory.id, sp.id);
                                  }}
                                  onBlur={() => setConfirmDeleteSubId(null)}
                                  className="px-2.5 py-1 text-xs font-semibold text-white bg-red-600 rounded-md cursor-pointer"
                                >
                                  Confirm
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteSubId(sp.id)}
                                  className="px-2 py-1 text-xs text-stone-400 hover:text-red-600 rounded-md cursor-pointer"
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 2: BULK 18-PRODUCT ZIP & GOOGLE DRIVE PDF IMPORT + AI EXTRACTION   */}
      {/* ===================================================================== */}
      {activeTab === 'pdfs' && (
        <div className="space-y-6">
          <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-stone-900">Reference documents</h2>
            <p className="text-xs text-stone-600">
              {state.documents.length} product references are indexed for the active catalogue.
              Refresh the reference set after changes to keep matching and policy review current.
            </p>
            <div className="max-h-96 overflow-auto divide-y divide-stone-100">
              {state.documents.map((document) => (
                <div key={document.id} className="py-2 text-xs text-stone-700">
                  <span className="font-medium">{document.fileName}</span>
                  <span className="ml-2 text-stone-500">
                    {state.categories.find((category) => category.id === document.categoryId)?.name}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-200">
            {/* Target Slot & Upload / Browse Controls */}
            <div className="p-6 space-y-5">
              <div>
                <h2 className="text-base font-semibold text-stone-900 font-display">
                  Single PDF Upload or Browse Existing Google Drive PDFs
                </h2>
                <p className="text-xs text-stone-500 mt-0.5">
                  Select a target category slot (and optional sub-product). Multiple PDFs
                  can be linked to each category and sub-product. AI extraction saves
                  structured specifications and candidate rules as{' '}
                  <strong className="text-stone-700">Drafts</strong> in Google Sheets
                  until an Admin verifies them.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-stone-700">
                    1. Target Product Category Slot (01–{String(state.categories.length || 19).padStart(2, '0')})
                  </label>
                  <select
                    value={pdfTargetCategoryId}
                    onChange={(e) => {
                      setPdfTargetCategoryId(e.target.value);
                      setPdfTargetSubProductId('');
                    }}
                    className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                  >
                    {state.categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        Slot {String(cat.slotNumber).padStart(2, '0')} · {cat.code} —{' '}
                        {getCategoryDisplayTitle(cat)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-stone-700">
                    2. Target Sub-Product (Optional — leave blank to create draft on
                    extract)
                  </label>
                  <select
                    value={pdfTargetSubProductId}
                    onChange={(e) => setPdfTargetSubProductId(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                  >
                    <option value="">
                       Category-level / Auto-create new Draft Sub-Product on AI Extract
                    </option>
                    {pdfTargetCategory?.subProducts.map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {sp.code} — {sp.name || 'Unnamed Sub-Product'}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
                {/* Option A: Direct Upload to Google Drive */}
                <div className="space-y-3">
                  <div className="text-xs font-semibold text-stone-900">
                    Option A — Upload Local PDF to Google Drive
                  </div>
                  <p className="text-xs text-stone-500 leading-relaxed">
                    Uploads the PDF file into{' '}
                    <span className="font-medium text-stone-800">
                      {state.workspaceConfig.driveFolderName || 'your Google Drive'}
                    </span>{' '}
                    and records the Drive link in <span className="font-mono">Product_Documents</span>.
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(e) => void handleLocalPdfSelected(e)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    disabled={state.isMutating}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Choose PDF & Upload to Google Drive</span>
                  </button>
                </div>

                {/* Option B: Browse Existing PDFs in Google Drive */}
                <div className="space-y-3">
                  <div className="text-xs font-semibold text-stone-900">
                    Option B — Select Existing PDF from Google Drive
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={driveSearchQuery}
                      onChange={(e) => setDriveSearchQuery(e.target.value)}
                      placeholder="Filter Drive PDFs by filename..."
                      className="flex-1 px-3 py-2 text-xs bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                    />
                    <button
                      type="button"
                      disabled={isSearchingDrive}
                      onClick={() => void handleSearchDrivePdfs()}
                      className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-stone-800 bg-stone-100 hover:bg-stone-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                    >
                      <FolderSearch className="w-3.5 h-3.5" />
                      <span>{isSearchingDrive ? 'Searching...' : 'Browse Drive PDFs'}</span>
                    </button>
                  </div>
                  {state.workspaceConfig.driveFolderId && (
                    <label className="inline-flex items-center gap-2 text-xs text-stone-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={driveFolderOnly}
                        onChange={(e) => setDriveFolderOnly(e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-stone-300 text-orange-600"
                      />
                      <span>
                        Search only inside{' '}
                        <strong>{state.workspaceConfig.driveFolderName}</strong>
                      </span>
                    </label>
                  )}

                  {drivePdfResults.length > 0 && (
                    <div className="max-h-48 overflow-y-auto divide-y divide-stone-200 border border-stone-200 rounded-lg">
                      {drivePdfResults.map((df) => (
                        <div
                          key={df.id}
                          className="px-3 py-2 flex items-center justify-between gap-3 text-xs hover:bg-stone-50"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-stone-900 truncate">
                              {df.name}
                            </div>
                            <div className="text-[11px] text-stone-400 font-mono truncate">
                              {df.id}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={state.isMutating}
                            onClick={() =>
                              void linkExistingDrivePdf({
                                driveFileId: df.id,
                                fileName: df.name,
                                webViewLink: df.webViewLink,
                                categoryId: pdfTargetCategoryId,
                                subProductId: pdfTargetSubProductId || undefined,
                              })
                            }
                            className="px-2.5 py-1 text-xs font-semibold text-orange-700 hover:bg-orange-50 rounded-md shrink-0 cursor-pointer"
                          >
                            Link PDF
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Linked Product_Documents Table + AI Policy Extraction */}
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-stone-900 font-display">
                    Linked Product References ({state.documents.length})
                  </h3>
                  <p className="text-xs text-stone-500 mt-0.5">
                    Click &ldquo;Extract Draft with AI&rdquo; to read the PDF from Google
                    Drive via Gemini and populate draft specifications & candidate rules.
                  </p>
                </div>
              </div>

              {state.documents.length === 0 ? (
                <div className="py-8 px-4 text-center bg-stone-50/70 border border-stone-200/80 rounded-lg text-xs text-stone-500">
                  No product references linked yet. Upload a PDF or select one from
                  Google Drive above.
                </div>
              ) : (
                <div className="overflow-x-auto border border-stone-200 rounded-lg">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-stone-200 bg-stone-50/70 text-[11px] font-medium text-stone-500">
                        <th className="py-2.5 px-4">PDF File Name</th>
                        <th className="py-2.5 px-4">Linked Product Slot</th>
                        <th className="py-2.5 px-4">Extraction Status</th>
                        <th className="py-2.5 px-4">Uploaded</th>
                        <th className="py-2.5 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-200 text-xs">
                      {state.documents.map((doc) => {
                        const cat = state.categories.find(
                          (c) => c.id === doc.categoryId
                        );
                        const sp = cat?.subProducts.find(
                          (s) => s.id === doc.subProductId
                        );

                        return (
                          <tr key={doc.id} className="hover:bg-stone-50/80">
                            <td className="py-3 px-4">
                              <a
                                href={doc.webViewLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 font-medium text-stone-900 hover:text-orange-700"
                              >
                                <FileText className="w-3.5 h-3.5 text-orange-600 shrink-0" />
                                <span>{doc.fileName}</span>
                                <ExternalLink className="w-3 h-3 text-stone-400 shrink-0" />
                              </a>
                            </td>
                            <td className="py-3 px-4 text-stone-600">
                              <div className="font-medium text-stone-800">
                                {cat ? getCategoryDisplayTitle(cat) : doc.categoryId}
                              </div>
                              {sp && (
                                <div className="text-[11px] text-stone-500 font-mono">
                                  Sub-Product: {sp.name || sp.code}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-4">
                              <span
                                className={
                                  doc.extractionStatus === 'verified'
                                    ? 'text-emerald-700 font-medium'
                                    : doc.extractionStatus === 'extracted_draft'
                                    ? 'text-amber-700 font-medium'
                                    : doc.extractionStatus === 'error'
                                    ? 'text-red-600 font-medium'
                                    : 'text-stone-500'
                                }
                              >
                                {doc.extractionStatus === 'verified'
                                  ? 'Verified & Active'
                                  : doc.extractionStatus === 'extracted_draft'
                                  ? 'Draft Extracted · Needs Review'
                                  : doc.extractionStatus === 'error'
                                  ? 'Extraction Error'
                                  : 'Uploaded · Ready to Extract'}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-stone-500 tabular-nums whitespace-nowrap">
                              {formatDateTime(doc.uploadedAt)}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-2">
                                {doc.extractedDraft && (
                                  <button
                                    type="button"
                                    onClick={() => setInspectedDoc(doc)}
                                    className="px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 rounded-md cursor-pointer"
                                  >
                                    Inspect Draft
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={state.isGeneratingAi || state.isMutating}
                                  onClick={() =>
                                    void extractPdfDraftWithAi(doc.id, doc.fileName)
                                  }
                                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-amber-950 bg-amber-400 hover:bg-amber-500 rounded-md transition-colors cursor-pointer disabled:opacity-50"
                                >
                                  <Sparkles className="w-3.5 h-3.5" />
                                  <span>
                                    {state.isGeneratingAi
                                      ? 'Extracting...'
                                      : 'Extract Draft with AI'}
                                  </span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 3: ADMIN DRAFT RULE VERIFICATION QUEUE                            */}
      {/* ===================================================================== */}
      {activeTab === 'verification' && (
        <div className="space-y-6">
          {pendingDraftRules.length === 0 ? (
            <EmptyStatePanel
              icon={<Check className="w-6 h-6" />}
              title="All Extracted Eligibility Rules Reviewed"
              description="No draft eligibility rules are currently queued. Local PDF text matches are reference suggestions and do not create or verify policy rules."
            />
          ) : (
            <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-200">
              <div className="p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-stone-900 font-display">
                    Pending Draft Eligibility Rules ({pendingDraftRules.length})
                  </h2>
                  <p className="text-xs text-stone-500 mt-0.5">
                    Review and refine AI-extracted rules against the source PDF before
                    activating them for Two-Stage Product Matching. Unverified rules are
                    never enforced.
                  </p>
                </div>

                <button
                  type="button"
                  disabled={state.isMutating}
                  onClick={() => void verifyAllDraftRules()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>
                    Verify &amp; Activate All ({pendingDraftRules.length}) Drafts
                  </span>
                </button>
              </div>

              {pendingDraftRules.map((item) => {
                const editPatch = draftEdits[item.rule.id] || {};
                const effectiveRule: ConfigurableRuleField = {
                  ...item.rule,
                  ...editPatch,
                };

                const updateDraftPatch = (patch: Partial<ConfigurableRuleField>) => {
                  setDraftEdits((prev) => ({
                    ...prev,
                    [item.rule.id]: {
                      ...(prev[item.rule.id] || {}),
                      ...patch,
                    },
                  }));
                };

                return (
                  <div key={item.rule.id} className="p-5 space-y-3 text-xs">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-stone-500">
                          {item.categoryCode}
                        </span>
                        <span aria-hidden="true" className="text-stone-300">
                          ·
                        </span>
                        <span className="font-semibold text-stone-900">
                          {item.categoryName}
                        </span>
                        {item.subProductName && (
                          <>
                            <span aria-hidden="true" className="text-stone-300">
                              →
                            </span>
                            <span className="font-semibold text-orange-700">
                              {item.subProductName} ({item.subProductCode})
                            </span>
                          </>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={state.isMutating}
                          onClick={() =>
                            void verifyRuleDecision({
                              categoryId: item.categoryId,
                              subProductId: item.subProductId,
                              ruleId: item.rule.id,
                              decision: 'verified',
                              updatedRule: effectiveRule,
                              activateProduct: true,
                              summaryLabel: `${effectiveRule.label} (${
                                item.subProductName || item.categoryName
                              })`,
                            })
                          }
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Verify & Activate</span>
                        </button>
                        <button
                          type="button"
                          disabled={state.isMutating}
                          onClick={() =>
                            void verifyRuleDecision({
                              categoryId: item.categoryId,
                              subProductId: item.subProductId,
                              ruleId: item.rule.id,
                              decision: 'rejected',
                              summaryLabel: `${effectiveRule.label} (${
                                item.subProductName || item.categoryName
                              })`,
                            })
                          }
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <X className="w-3.5 h-3.5" />
                          <span>Reject</span>
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5">
                      <input
                        type="text"
                        value={effectiveRule.label}
                        onChange={(e) => updateDraftPatch({ label: e.target.value })}
                        className="md:col-span-4 px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                      />
                      <select
                        value={effectiveRule.stage || 'stage2_eligibility'}
                        onChange={(e) =>
                          updateDraftPatch({ stage: e.target.value as RuleStage })
                        }
                        className="md:col-span-2 px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                      >
                        <option value="stage1_requirement">Stage 1 Fit</option>
                        <option value="stage2_eligibility">Stage 2 Gate</option>
                      </select>
                      <select
                        value={effectiveRule.targetField}
                        onChange={(e) =>
                          updateDraftPatch({
                            targetField: e.target.value as TargetIntakeField,
                          })
                        }
                        className="md:col-span-2 px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                      >
                        <option value="requestedAmount">Requested Amount</option>
                        <option value="requestedTenureMonths">Tenure (Months)</option>
                        <option value="annualTurnoverOrIncome">Annual Turnover</option>
                        <option value="businessVintageYears">Vintage (Years)</option>
                        <option value="creditScore">Credit Score</option>
                        <option value="existingEmiObligations">Monthly EMI</option>
                        <option value="profitabilityStatus">Profitability</option>
                        <option value="gstTaxCompliant">GST Compliance</option>
                        <option value="collateralAvailable">Collateral Flag</option>
                        <option value="collateralValue">Collateral Value</option>
                        <option value="entityType">Entity Structure</option>
                        <option value="fundingPurpose">Funding Purpose</option>
                        <option value="industrySector">Industry Sector</option>
                        <option value="customAttribute">Custom Field</option>
                      </select>
                      <select
                        value={effectiveRule.operator}
                        onChange={(e) =>
                          updateDraftPatch({
                            operator: e.target.value as RuleOperator,
                          })
                        }
                        className="md:col-span-2 px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                      >
                        <option value="number_min">Min (&gt;=)</option>
                        <option value="number_max">Max (&lt;=)</option>
                        <option value="boolean_equals">Boolean</option>
                        <option value="text_equals">Exact Text</option>
                        <option value="in_list">In List</option>
                        <option value="not_in_list">Not In List</option>
                        <option value="custom_Presence">Present</option>
                      </select>
                      <input
                        type="text"
                        value={String(effectiveRule.expectedValue)}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const val =
                            effectiveRule.operator === 'number_min' ||
                            effectiveRule.operator === 'number_max'
                              ? Number(raw) || 0
                              : effectiveRule.operator === 'boolean_equals'
                              ? raw.toLowerCase() === 'true'
                              : raw;
                          updateDraftPatch({ expectedValue: val });
                        }}
                        className="md:col-span-2 px-2.5 py-1.5 font-mono bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                      />
                    </div>

                    {effectiveRule.notes && (
                      <div className="text-[11px] text-stone-500">
                        <strong className="text-stone-700">PDF Citation:</strong>{' '}
                        {effectiveRule.notes}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 4: POLICY REVIEW LOG                                              */}
      {/* ===================================================================== */}
      {activeTab === 'logs' && (
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
          {state.policyLogs.length === 0 ? (
            <div className="py-12 px-6 text-center text-xs text-stone-500">
              No policy review events logged yet. Uploading PDFs, extracting drafts,
              updating product configurations, and verifying rules automatically record
              audit entries in <span className="font-mono">Policy_Review_Log</span>.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50/70 text-[11px] font-medium text-stone-500">
                    <th className="py-3 px-4">Timestamp</th>
                    <th className="py-3 px-4">Actor</th>
                    <th className="py-3 px-4">Action</th>
                    <th className="py-3 px-4">Target</th>
                    <th className="py-3 px-4">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200 text-xs">
                  {state.policyLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-stone-50/80">
                      <td className="py-3 px-4 font-mono tabular-nums text-stone-500 whitespace-nowrap">
                        {formatDateTime(log.timestamp)}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className="font-medium text-stone-900">
                          {log.actorEmail}
                        </span>
                        <span className="text-stone-400"> · {log.actorRole}</span>
                      </td>
                      <td className="py-3 px-4 font-mono text-stone-700 whitespace-nowrap">
                        {log.actionType}
                      </td>
                      <td className="py-3 px-4 font-mono text-stone-500 whitespace-nowrap">
                        {log.targetEntityType}:{log.targetEntityId}
                      </td>
                      <td className="py-3 px-4 text-stone-700">{log.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Sub-Product Configuration Drawer */}
      <SlideOverDrawer
        open={Boolean(editingSubProduct)}
        title={
          editingSubProduct?.name
            ? `Edit Sub-Product: ${editingSubProduct.name}`
            : 'Configure Sub-Product Record'
        }
        subtitle={editingSubProduct?.code}
        onClose={() => setEditingSubProduct(null)}
        footer={
          editingSubProduct && (
            <>
              <button
                type="button"
                onClick={() => setEditingSubProduct(null)}
                className="px-4 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={state.isMutating}
                onClick={() => void handleSaveSubProductDrawer()}
                className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg cursor-pointer disabled:opacity-50"
              >
                Save Sub-Product
              </button>
            </>
          )
        }
      >
        {editingSubProduct && (
          <div className="space-y-5 text-xs">
            <div className="space-y-1.5">
              <label className="block font-medium text-stone-700">
                Sub-Product Name
              </label>
              <input
                type="text"
                value={editingSubProduct.name}
                onChange={(e) =>
                  setEditingSubProduct({ ...editingSubProduct, name: e.target.value })
                }
                placeholder="Official Sub-Product Name (or leave empty as placeholder)"
                className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="block font-medium text-stone-700">
                  Sub-Product Code
                </label>
                <input
                  type="text"
                  value={editingSubProduct.code}
                  onChange={(e) =>
                    setEditingSubProduct({
                      ...editingSubProduct,
                      code: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 text-sm font-mono bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block font-medium text-stone-700">
                  Lifecycle Status
                </label>
                <select
                  value={editingSubProduct.status}
                  onChange={(e) =>
                    setEditingSubProduct({
                      ...editingSubProduct,
                      status: e.target.value as CategoryLifecycleStatus,
                    })
                  }
                  className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                >
                  <option value="placeholder">Placeholder</option>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block font-medium text-stone-700">
                Product Reference
              </label>
              <input
                type="text"
                value={editingSubProduct.studyMaterialRef}
                onChange={(e) =>
                  setEditingSubProduct({
                    ...editingSubProduct,
                    studyMaterialRef: e.target.value,
                  })
                }
                placeholder="Document page, circular ID, or Drive PDF filename"
                className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block font-medium text-stone-700">Description</label>
              <textarea
                rows={3}
                value={editingSubProduct.description}
                onChange={(e) =>
                  setEditingSubProduct({
                    ...editingSubProduct,
                    description: e.target.value,
                  })
                }
                placeholder="Sub-product scope notes..."
                className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-stone-200">
              <div className="space-y-1.5">
                <label className="block font-medium text-stone-700">
                  Suitable Borrower Types (one per line)
                </label>
                <textarea
                  rows={2}
                  value={joinDelimitedList(editingSubProduct.suitableBorrowerTypes)}
                  onChange={(e) =>
                    setEditingSubProduct({
                      ...editingSubProduct,
                      suitableBorrowerTypes: parseDelimitedList(e.target.value),
                    })
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block font-medium text-stone-700">
                  Funding Purposes & Use Cases (one per line)
                </label>
                <textarea
                  rows={2}
                  value={joinDelimitedList(editingSubProduct.fundingPurposes)}
                  onChange={(e) =>
                    setEditingSubProduct({
                      ...editingSubProduct,
                      fundingPurposes: parseDelimitedList(e.target.value),
                    })
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block font-medium text-stone-700">
                  Financial Requirements (one per line)
                </label>
                <textarea
                  rows={2}
                  value={joinDelimitedList(editingSubProduct.financialRequirements)}
                  onChange={(e) =>
                    setEditingSubProduct({
                      ...editingSubProduct,
                      financialRequirements: parseDelimitedList(e.target.value),
                    })
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block font-medium text-stone-700">
                  Collateral Requirements (one per line)
                </label>
                <textarea
                  rows={2}
                  value={joinDelimitedList(editingSubProduct.collateralRequirements)}
                  onChange={(e) =>
                    setEditingSubProduct({
                      ...editingSubProduct,
                      collateralRequirements: parseDelimitedList(e.target.value),
                    })
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block font-medium text-stone-700">
                  Required Documents (one per line)
                </label>
                <textarea
                  rows={3}
                  value={joinDelimitedList(editingSubProduct.requiredDocuments)}
                  onChange={(e) =>
                    setEditingSubProduct({
                      ...editingSubProduct,
                      requiredDocuments: parseDelimitedList(e.target.value),
                    })
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block font-medium text-stone-700">
                  Restrictions & Exclusions (one per line)
                </label>
                <textarea
                  rows={3}
                  value={joinDelimitedList(editingSubProduct.restrictionsAndExclusions)}
                  onChange={(e) =>
                    setEditingSubProduct({
                      ...editingSubProduct,
                      restrictionsAndExclusions: parseDelimitedList(e.target.value),
                    })
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600"
                />
              </div>
            </div>

            <div className="pt-4 border-t border-stone-200">
              <AttributeListEditor
                attributes={editingSubProduct.attributes}
                onChange={(next) =>
                  setEditingSubProduct({ ...editingSubProduct, attributes: next })
                }
              />
            </div>

            <div className="pt-4 border-t border-stone-200">
              <RuleListEditor
                rules={editingSubProduct.baselineRules}
                onChange={(next) =>
                  setEditingSubProduct({
                    ...editingSubProduct,
                    baselineRules: next,
                  })
                }
              />
            </div>
          </div>
        )}
      </SlideOverDrawer>

      {/* AI Extracted PDF Draft Inspector Drawer */}
      <SlideOverDrawer
        open={Boolean(inspectedDoc && inspectedDoc.extractedDraft)}
        title={inspectedDoc?.fileName || 'Extracted PDF Policy Draft'}
        subtitle={
          inspectedDoc?.extractedDraft
            ? `Extracted ${formatDateTime(inspectedDoc.extractedDraft.extractedAt)}`
            : undefined
        }
        onClose={() => setInspectedDoc(null)}
        footer={
          <button
            type="button"
            onClick={() => {
              setInspectedDoc(null);
              setActiveTab('verification');
            }}
            className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg cursor-pointer"
          >
            Go to Rule Verification Queue
          </button>
        }
      >
        {inspectedDoc?.extractedDraft && (
          <div className="space-y-4 text-xs">
            <div>
              <div className="text-stone-500">Extracted Product & Suggested Category</div>
              <div className="font-semibold text-stone-900 mt-0.5">
                {inspectedDoc.extractedDraft.productName || 'Not explicitly named'} ·{' '}
                {inspectedDoc.extractedDraft.suggestedCategoryName || 'General'}
              </div>
            </div>

            <div>
              <div className="font-semibold text-stone-900">Product Description</div>
              <p className="text-stone-600 leading-relaxed mt-0.5">
                {inspectedDoc.extractedDraft.productDescription || '—'}
              </p>
            </div>

            {(
              [
                [
                  'Suitable Borrower Types',
                  inspectedDoc.extractedDraft.suitableBorrowerTypes,
                ],
                [
                  'Funding Purposes & Use Cases',
                  inspectedDoc.extractedDraft.fundingPurposesAndUseCases,
                ],
                [
                  'Eligibility Criteria Statements',
                  inspectedDoc.extractedDraft.eligibilityCriteriaText,
                ],
                [
                  'Financial Requirements',
                  inspectedDoc.extractedDraft.financialRequirements,
                ],
                [
                  'Collateral Requirements',
                  inspectedDoc.extractedDraft.collateralRequirements,
                ],
                ['Required Documents', inspectedDoc.extractedDraft.requiredDocuments],
                [
                  'Restrictions & Exclusions',
                  inspectedDoc.extractedDraft.restrictionsAndExclusions,
                ],
              ] as Array<[string, string[]]>
            ).map(([heading, items]) => (
              <div key={heading} className="pt-3 border-t border-stone-200">
                <div className="font-semibold text-stone-900">{heading}</div>
                {items.length === 0 ? (
                  <p className="text-stone-400 mt-0.5">None stated in PDF</p>
                ) : (
                  <ul className="mt-1 space-y-1 text-stone-600 list-disc pl-4">
                    {items.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </SlideOverDrawer>

      {/* Bulk JSON Import Drawer */}
      <SlideOverDrawer
        open={importDrawerOpen}
        title="Import Configurable Catalog JSON"
        subtitle="Bulk-load category and sub-product configurations from structured portfolio exports."
        onClose={() => setImportDrawerOpen(false)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setImportDrawerOpen(false)}
              className="px-4 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={state.isMutating || !importJsonText.trim()}
              onClick={() => void handleImportSubmit()}
              className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg cursor-pointer disabled:opacity-50"
            >
              Apply Catalog JSON
            </button>
          </>
        }
      >
        <div className="space-y-4 text-xs">
          <p className="text-stone-600 leading-relaxed">
            Paste a JSON array of <span className="font-mono">ProductCategory</span>{' '}
            objects exported from LoanBazaar or compiled from approved product reference sets. When
            19-slot governance is enabled, the payload must contain 19 category records.
          </p>
          {importError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 font-medium">
              {importError}
            </div>
          )}
          <textarea
            rows={14}
            value={importJsonText}
            onChange={(e) => setImportJsonText(e.target.value)}
            placeholder='[ { "id": "cat-01", "slotNumber": 1, "code": "LB-CAT-01", ... } ]'
            className="w-full p-3 font-mono text-xs bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
          />
        </div>
      </SlideOverDrawer>
    </div>
  );
}
