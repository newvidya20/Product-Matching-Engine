import type {
  AIAdvisoryExplanation,
  AuthenticatedGoogleUser,
  BootstrapPayload,
  BorrowerAssessment,
  ConfigurableRuleField,
  DriveFileSummary,
  DriveStudyMaterialScanResult,
  MatchingEvaluationRecord,
  PolicyReviewLogEntry,
  ProductCategory,
  ProductDocumentRecord,
  RequiredSheetTabName,
  SheetsClientStatusPayload,
  SheetTabPreviewPayload,
  SheetTabSchemaStatus,
  SubProduct,
  SystemSettings,
  WorkspaceConnectionConfig,
} from '../types/domain';

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage =
      (data && typeof data.error === 'string' && data.error) ||
      `Request failed (${response.status})`;
    throw new Error(errorMessage);
  }
  return data as T;
}

export const apiClient = {
  bootstrap(): Promise<BootstrapPayload> {
    return requestJson<BootstrapPayload>('/api/bootstrap');
  },

  fetchWorkspaceMe(): Promise<{
    currentUser: AuthenticatedGoogleUser | null;
    workspaceConfig: WorkspaceConnectionConfig;
  }> {
    return requestJson('/api/workspace/me');
  },

  getSheetsStatus(): Promise<SheetsClientStatusPayload> {
    return requestJson('/api/sheets/status');
  },

  repairSheetsSchema(): Promise<{
    workspaceConfig: WorkspaceConnectionConfig;
    tabs: SheetTabSchemaStatus[];
  }> {
    return requestJson('/api/sheets/repair-schema', {
      method: 'POST',
    });
  },

  readSheetTab(
    tabName: RequiredSheetTabName,
    limit = 50
  ): Promise<SheetTabPreviewPayload> {
    return requestJson(
      `/api/sheets/${encodeURIComponent(tabName)}?limit=${encodeURIComponent(
        String(limit)
      )}`
    );
  },

  upsertSheetRow(
    tabName: RequiredSheetTabName,
    record: Record<string, unknown>,
    id?: string
  ): Promise<{
    success: boolean;
    operation: 'updated' | 'appended';
    tabName: RequiredSheetTabName;
  }> {
    return requestJson(`/api/sheets/${encodeURIComponent(tabName)}/rows`, {
      method: 'POST',
      body: JSON.stringify({ id, record }),
    });
  },

  deleteSheetRow(
    tabName: RequiredSheetTabName,
    rowId: string
  ): Promise<{
    success: boolean;
    tabName: RequiredSheetTabName;
    rowId: string;
  }> {
    return requestJson(
      `/api/sheets/${encodeURIComponent(tabName)}/rows/${encodeURIComponent(
        rowId
      )}`,
      {
        method: 'DELETE',
      }
    );
  },

  createMasterSpreadsheet(title?: string): Promise<{
    workspaceConfig: WorkspaceConnectionConfig;
    categories: ProductCategory[];
    policyLogs: PolicyReviewLogEntry[];
  }> {
    return requestJson('/api/workspace/sheets/create', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  },

  connectSpreadsheet(spreadsheetIdOrUrl: string): Promise<{
    workspaceConfig: WorkspaceConnectionConfig;
    categories: ProductCategory[];
    fictionalDemoCategories: ProductCategory[];
    assessments: BorrowerAssessment[];
    documents: ProductDocumentRecord[];
    policyLogs: PolicyReviewLogEntry[];
  }> {
    return requestJson('/api/workspace/sheets/connect', {
      method: 'POST',
      body: JSON.stringify({ spreadsheetIdOrUrl }),
    });
  },

  syncFromGoogleSheets(): Promise<{
    categories: ProductCategory[];
    fictionalDemoCategories: ProductCategory[];
    assessments: BorrowerAssessment[];
    documents: ProductDocumentRecord[];
    policyLogs: PolicyReviewLogEntry[];
    workspaceConfig: WorkspaceConnectionConfig;
  }> {
    return requestJson('/api/workspace/sheets/sync', {
      method: 'POST',
    });
  },

  listDriveSpreadsheets(q = ''): Promise<{ files: DriveFileSummary[] }> {
    return requestJson(`/api/workspace/drive/spreadsheets?q=${encodeURIComponent(q)}`);
  },

  listDrivePdfs(q = '', folderOnly = false): Promise<{ files: DriveFileSummary[] }> {
    return requestJson(
      `/api/workspace/drive/pdfs?q=${encodeURIComponent(q)}&folderOnly=${String(
        folderOnly
      )}`
    );
  },

  createDriveFolder(folderName?: string): Promise<{
    workspaceConfig: WorkspaceConnectionConfig;
    folder: DriveFileSummary;
  }> {
    return requestJson('/api/workspace/drive/folder', {
      method: 'POST',
      body: JSON.stringify({ folderName }),
    });
  },

  scanDriveStudyMaterialFolder(
    folderQueryOrId = 'study material'
  ): Promise<DriveStudyMaterialScanResult> {
    return requestJson(
      `/api/workspace/drive/scan-study-material?folder=${encodeURIComponent(
        folderQueryOrId
      )}`
    );
  },

  importDriveStudyMaterialFolder(payload?: {
    folderId?: string;
    folderQuery?: string;
  }): Promise<{
    scan: DriveStudyMaterialScanResult;
    categories: ProductCategory[];
    fictionalDemoCategories: ProductCategory[];
    documents: ProductDocumentRecord[];
    policyLogs: PolicyReviewLogEntry[];
    workspaceConfig: WorkspaceConnectionConfig;
  }> {
    return requestJson('/api/workspace/drive/import-study-material', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  updateWorkspaceAccess(payload: {
    adminEmails: string[];
    employeeEmails: string[];
  }): Promise<{ workspaceConfig: WorkspaceConnectionConfig }> {
    return requestJson('/api/workspace/access', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  uploadPdfDocument(payload: {
    fileName: string;
    base64Pdf: string;
    mimeType?: string;
    categoryId: string;
    subProductId?: string;
    suggestedCategoryName?: string;
    overwriteCategoryName?: boolean;
    deferSheetsSync?: boolean;
  }): Promise<{
    document: ProductDocumentRecord;
    documents: ProductDocumentRecord[];
    categories: ProductCategory[];
    policyLogs: PolicyReviewLogEntry[];
  }> {
    return requestJson('/api/documents/upload', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  linkDrivePdfDocument(payload: {
    driveFileId: string;
    fileName: string;
    webViewLink?: string;
    categoryId: string;
    subProductId?: string;
  }): Promise<{
    document: ProductDocumentRecord;
    documents: ProductDocumentRecord[];
    categories: ProductCategory[];
    policyLogs: PolicyReviewLogEntry[];
  }> {
    return requestJson('/api/documents/link-drive', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  extractPdfPolicyDraft(
    documentId: string,
    options?: { deferSheetsSync?: boolean }
  ): Promise<{
    document: ProductDocumentRecord;
    documents: ProductDocumentRecord[];
    categories: ProductCategory[];
    fictionalDemoCategories: ProductCategory[];
    policyLogs: PolicyReviewLogEntry[];
  }> {
    return requestJson(`/api/documents/${encodeURIComponent(documentId)}/extract`, {
      method: 'POST',
      body: JSON.stringify(options || {}),
    });
  },

  pushBatchToGoogleSheets(payload: {
    slotCategoryNames?: Array<{ categoryId: string; name: string }>;
    summary?: string;
  }): Promise<{
    categories: ProductCategory[];
    fictionalDemoCategories: ProductCategory[];
    documents: ProductDocumentRecord[];
    policyLogs: PolicyReviewLogEntry[];
    workspaceConfig: WorkspaceConnectionConfig;
  }> {
    return requestJson('/api/workspace/sheets/push-batch', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  verifyExtractedRules(payload: {
    categoryId: string;
    subProductId?: string;
    ruleId?: string;
    decision: 'verified' | 'rejected';
    updatedRule?: Partial<ConfigurableRuleField>;
    activateProduct?: boolean;
  }): Promise<{
    categories: ProductCategory[];
    fictionalDemoCategories: ProductCategory[];
    documents: ProductDocumentRecord[];
    policyLogs: PolicyReviewLogEntry[];
  }> {
    return requestJson('/api/admin/rules/verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  verifyAllExtractedRules(): Promise<{
    verifiedRulesCount: number;
    categories: ProductCategory[];
    fictionalDemoCategories: ProductCategory[];
    documents: ProductDocumentRecord[];
    policyLogs: PolicyReviewLogEntry[];
  }> {
    return requestJson('/api/admin/rules/verify-all', {
      method: 'POST',
    });
  },

  createCategory(payload: Partial<ProductCategory>): Promise<{ category: ProductCategory }> {
    return requestJson<{ category: ProductCategory }>('/api/categories', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateCategory(
    categoryId: string,
    payload: Partial<ProductCategory>
  ): Promise<{
    category: ProductCategory;
    fictionalDemoCategories: ProductCategory[];
    policyLogs?: PolicyReviewLogEntry[];
  }> {
    return requestJson(`/api/categories/${encodeURIComponent(categoryId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  createSubProduct(
    categoryId: string,
    payload: Partial<SubProduct>
  ): Promise<{
    category: ProductCategory;
    subProduct: SubProduct;
    fictionalDemoCategories: ProductCategory[];
  }> {
    return requestJson(`/api/categories/${encodeURIComponent(categoryId)}/sub-products`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateSubProduct(
    categoryId: string,
    subProductId: string,
    payload: Partial<SubProduct>
  ): Promise<{
    category: ProductCategory;
    subProduct: SubProduct;
    fictionalDemoCategories: ProductCategory[];
    policyLogs?: PolicyReviewLogEntry[];
  }> {
    return requestJson(
      `/api/categories/${encodeURIComponent(categoryId)}/sub-products/${encodeURIComponent(
        subProductId
      )}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      }
    );
  },

  deleteSubProduct(
    categoryId: string,
    subProductId: string
  ): Promise<{ category: ProductCategory; fictionalDemoCategories: ProductCategory[] }> {
    return requestJson(
      `/api/categories/${encodeURIComponent(categoryId)}/sub-products/${encodeURIComponent(
        subProductId
      )}`,
      {
        method: 'DELETE',
      }
    );
  },

  importCatalog(categories: ProductCategory[]): Promise<{
    categories: ProductCategory[];
    fictionalDemoCategories: ProductCategory[];
  }> {
    return requestJson('/api/admin/import-catalog', {
      method: 'POST',
      body: JSON.stringify({ categories }),
    });
  },

  resetCatalogPlaceholders(): Promise<{
    categories: ProductCategory[];
    fictionalDemoCategories: ProductCategory[];
  }> {
    return requestJson('/api/admin/reset-placeholders', {
      method: 'POST',
    });
  },

  createAssessment(
    payload: Partial<BorrowerAssessment>
  ): Promise<{ assessment: BorrowerAssessment }> {
    return requestJson('/api/assessments', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateAssessment(
    assessmentId: string,
    payload: Partial<BorrowerAssessment>
  ): Promise<{ assessment: BorrowerAssessment }> {
    return requestJson(`/api/assessments/${encodeURIComponent(assessmentId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  deleteAssessment(assessmentId: string): Promise<{ success: boolean }> {
    return requestJson(`/api/assessments/${encodeURIComponent(assessmentId)}`, {
      method: 'DELETE',
    });
  },

  resetDemoAssessments(): Promise<{ assessments: BorrowerAssessment[] }> {
    return requestJson('/api/admin/reset-demo-assessments', {
      method: 'POST',
    });
  },

  evaluateAssessment(
    assessmentId: string,
    datasetMode: 'official_catalog' | 'fictional_demo_sandbox'
  ): Promise<{
    assessment: BorrowerAssessment;
    evaluation: MatchingEvaluationRecord;
    categories?: ProductCategory[];
  }> {
    return requestJson(`/api/assessments/${encodeURIComponent(assessmentId)}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ datasetMode }),
    });
  },

  generateAiExplanation(
    assessmentId: string
  ): Promise<{ assessment: BorrowerAssessment; aiExplanation: AIAdvisoryExplanation }> {
    return requestJson(`/api/assessments/${encodeURIComponent(assessmentId)}/explain`, {
      method: 'POST',
    });
  },

  updateSettings(payload: Partial<SystemSettings>): Promise<{ settings: SystemSettings }> {
    return requestJson('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },
};
