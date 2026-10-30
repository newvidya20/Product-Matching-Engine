import crypto from 'node:crypto';
import fs from 'node:fs';
import type {
  BorrowerAssessment,
  ConfigurableRuleField,
  ExtractedPdfDraft,
  MatchingEvaluationRecord,
  PolicyReviewLogEntry,
  ProductCategory,
  ProductDocumentRecord,
  RequiredSheetTabName,
  SheetsAuthMode,
  SheetTabPreviewPayload,
  SheetTabSchemaStatus,
  SubProduct,
  UserRole,
} from '../src/types/domain.ts';
import { createInitialEmptyCategories } from './storage.ts';

export const REQUIRED_SHEET_TABS = {
  CATEGORIES: 'Product_Categories',
  SUB_PRODUCTS: 'Sub_Products',
  RULES: 'Eligibility_Rules',
  DOCUMENTS: 'Product_Documents',
  ASSESSMENTS: 'Borrower_Assessments',
  MATCHING_RESULTS: 'Matching_Results',
  POLICY_LOG: 'Policy_Review_Log',
} as const satisfies Record<string, RequiredSheetTabName>;

export const ALL_REQUIRED_TAB_NAMES: RequiredSheetTabName[] = [
  REQUIRED_SHEET_TABS.CATEGORIES,
  REQUIRED_SHEET_TABS.SUB_PRODUCTS,
  REQUIRED_SHEET_TABS.RULES,
  REQUIRED_SHEET_TABS.DOCUMENTS,
  REQUIRED_SHEET_TABS.ASSESSMENTS,
  REQUIRED_SHEET_TABS.MATCHING_RESULTS,
  REQUIRED_SHEET_TABS.POLICY_LOG,
];

export const SHEET_HEADERS: Record<RequiredSheetTabName, string[]> = {
  Product_Categories: [
    'category_id',
    'slot_number',
    'code',
    'name',
    'status',
    'description',
    'study_material_status',
    'study_material_ref',
    'suitable_borrower_types_json',
    'funding_purposes_json',
    'restrictions_exclusions_json',
    'attributes_json',
    'source_doc_ids_json',
    'updated_at',
  ],
  Sub_Products: [
    'sub_product_id',
    'category_id',
    'code',
    'name',
    'status',
    'verification_status',
    'description',
    'study_material_ref',
    'suitable_borrower_types_json',
    'funding_purposes_json',
    'financial_requirements_json',
    'collateral_requirements_json',
    'required_documents_json',
    'restrictions_exclusions_json',
    'attributes_json',
    'source_doc_ids_json',
    'updated_at',
  ],
  Eligibility_Rules: [
    'rule_id',
    'category_id',
    'sub_product_id',
    'stage',
    'target_field',
    'custom_key',
    'label',
    'operator',
    'expected_value',
    'is_mandatory',
    'verification_status',
    'source_doc_id',
    'extracted_by_ai',
    'verified_by',
    'verified_at',
    'notes',
  ],
  Product_Documents: [
    'document_id',
    'drive_file_id',
    'file_name',
    'mime_type',
    'web_view_link',
    'category_id',
    'sub_product_id',
    'extraction_status',
    'extracted_draft_json',
    'uploaded_by',
    'uploaded_at',
  ],
  Borrower_Assessments: [
    'assessment_id',
    'reference_code',
    'applicant_label',
    'entity_type',
    'industry_sector',
    'business_vintage_years',
    'annual_turnover',
    'credit_score',
    'existing_emi_obligations',
    'profitability_status',
    'gst_tax_compliant',
    'funding_purpose',
    'dynamic_purpose_answers_json',
    'requested_amount',
    'currency',
    'requested_tenure_months',
    'collateral_available',
    'collateral_type',
    'collateral_value',
    'collateral_description',
    'stated_purpose',
    'assigned_officer',
    'branch_or_desk',
    'advisor_notes',
    'custom_attributes_json',
    'status',
    'is_fictional_demo',
    'created_at',
    'updated_at',
  ],
  Matching_Results: [
    'evaluation_id',
    'assessment_id',
    'reference_code',
    'evaluated_at',
    'evaluated_by',
    'dataset_mode',
    'top_3_sub_products_json',
    'full_evaluation_json',
  ],
  Policy_Review_Log: [
    'log_id',
    'timestamp',
    'actor_email',
    'actor_role',
    'action_type',
    'target_entity_type',
    'target_entity_id',
    'summary',
  ],
};

const GOOGLE_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedServiceAccountToken {
  accessToken: string;
  expiresAtMs: number;
  clientEmail: string;
}

let cachedSaToken: CachedServiceAccountToken | null = null;

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Loads Google Service Account credentials from GOOGLE_SERVICE_ACCOUNT_JSON
 * or GOOGLE_APPLICATION_CREDENTIALS file path when configured in server env.
 */
export function loadConfiguredServiceAccount(): ServiceAccountCredentials | null {
  const rawJson = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Partial<ServiceAccountCredentials>;
      if (parsed.client_email && parsed.private_key) {
        return {
          client_email: parsed.client_email,
          private_key: parsed.private_key.replace(/\\n/g, '\n'),
          token_uri: parsed.token_uri || 'https://oauth2.googleapis.com/token',
        };
      }
    } catch (err) {
      console.warn('Invalid GOOGLE_SERVICE_ACCOUNT_JSON format:', err);
    }
  }

  const credPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (credPath && fs.existsSync(credPath)) {
    try {
      const fileContent = fs.readFileSync(credPath, 'utf-8');
      const parsed = JSON.parse(fileContent) as Partial<ServiceAccountCredentials>;
      if (parsed.client_email && parsed.private_key) {
        return {
          client_email: parsed.client_email,
          private_key: parsed.private_key.replace(/\\n/g, '\n'),
          token_uri: parsed.token_uri || 'https://oauth2.googleapis.com/token',
        };
      }
    } catch (err) {
      console.warn('Unable to read GOOGLE_APPLICATION_CREDENTIALS file:', err);
    }
  }

  return null;
}

/**
 * Mints a short-lived Google OAuth 2.0 access token from the configured Service Account
 * using RS256 JWT assertion (cached in memory until 60s before expiration).
 */
export async function getServiceAccountAccessToken(): Promise<{
  accessToken: string;
  clientEmail: string;
} | null> {
  const creds = loadConfiguredServiceAccount();
  if (!creds) return null;

  const nowMs = Date.now();
  if (cachedSaToken && cachedSaToken.expiresAtMs - 60_000 > nowMs) {
    return {
      accessToken: cachedSaToken.accessToken,
      clientEmail: cachedSaToken.clientEmail,
    };
  }

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;
  const tokenUri = creds.token_uri || 'https://oauth2.googleapis.com/token';

  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: creds.client_email,
      scope: GOOGLE_WORKSPACE_SCOPES.join(' '),
      aud: tokenUri,
      iat,
      exp,
    })
  );

  const unsignedJwt = `${header}.${claimSet}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  const signature = base64UrlEncode(signer.sign(creds.private_key));
  const assertion = `${unsignedJwt}.${signature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        `Service Account token exchange failed (${res.status})`
    );
  }

  const expiresInSec = Number(data.expires_in) || 3600;
  cachedSaToken = {
    accessToken: data.access_token,
    expiresAtMs: nowMs + expiresInSec * 1000,
    clientEmail: creds.client_email,
  };

  return {
    accessToken: cachedSaToken.accessToken,
    clientEmail: creds.client_email,
  };
}

/**
 * Resolves the active Google Sheets API access token:
 * 1. Uses the interactive user OAuth 2.0 Bearer token when signed in on the client.
 * 2. Falls back to the server's configured Service Account JWT when present.
 */
export async function resolveSheetsApiAuth(
  oauthBearerToken?: string | null
): Promise<{
  accessToken: string | null;
  authMode: SheetsAuthMode;
  serviceAccountEmail: string | null;
}> {
  const saCreds = loadConfiguredServiceAccount();

  if (oauthBearerToken && oauthBearerToken.trim().length > 0) {
    return {
      accessToken: oauthBearerToken.trim(),
      authMode: 'oauth_user',
      serviceAccountEmail: saCreds?.client_email || null,
    };
  }

  if (saCreds) {
    const minted = await getServiceAccountAccessToken();
    if (minted) {
      return {
        accessToken: minted.accessToken,
        authMode: 'service_account',
        serviceAccountEmail: minted.clientEmail,
      };
    }
  }

  return {
    accessToken: null,
    authMode: 'unauthenticated',
    serviceAccountEmail: saCreds?.client_email || null,
  };
}

function columnIndexToLetter(colCountOneBased: number): string {
  let n = Math.max(1, colCountOneBased);
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function safeJsonParse<T>(raw: string | undefined, fallback: T): T {
  if (!raw || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function extractSpreadsheetId(rawSpreadsheetIdOrUrl: string): string {
  const trimmed = rawSpreadsheetIdOrUrl.trim();
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return urlMatch ? urlMatch[1] : trimmed;
}

export function isValidRequiredTabName(name: string): name is RequiredSheetTabName {
  return (ALL_REQUIRED_TAB_NAMES as string[]).includes(name);
}

// --- Row Serializers ---

export function serializeCategoryRow(cat: ProductCategory): string[] {
  return [
    cat.id,
    String(cat.slotNumber),
    cat.code,
    cat.name || '',
    cat.status,
    cat.description || '',
    cat.studyMaterialStatus,
    cat.studyMaterialRef || '',
    JSON.stringify(cat.suitableBorrowerTypes || []),
    JSON.stringify(cat.fundingPurposes || []),
    JSON.stringify(cat.restrictionsAndExclusions || []),
    JSON.stringify(cat.attributes || []),
    JSON.stringify(cat.sourceDocumentIds || []),
    cat.updatedAt || new Date().toISOString(),
  ];
}

export function serializeSubProductRow(sp: SubProduct): string[] {
  return [
    sp.id,
    sp.categoryId,
    sp.code,
    sp.name || '',
    sp.status,
    sp.verificationStatus || 'verified',
    sp.description || '',
    sp.studyMaterialRef || '',
    JSON.stringify(sp.suitableBorrowerTypes || []),
    JSON.stringify(sp.fundingPurposes || []),
    JSON.stringify(sp.financialRequirements || []),
    JSON.stringify(sp.collateralRequirements || []),
    JSON.stringify(sp.requiredDocuments || []),
    JSON.stringify(sp.restrictionsAndExclusions || []),
    JSON.stringify(sp.attributes || []),
    JSON.stringify(sp.sourceDocumentIds || []),
    sp.updatedAt || new Date().toISOString(),
  ];
}

export function serializeRuleRow(
  rule: ConfigurableRuleField,
  categoryId: string,
  subProductId = ''
): string[] {
  return [
    rule.id,
    categoryId,
    subProductId,
    rule.stage || 'stage2_eligibility',
    rule.targetField,
    rule.customKey || '',
    rule.label || '',
    rule.operator,
    String(rule.expectedValue ?? ''),
    String(rule.isMandatory ?? true),
    rule.verificationStatus || 'verified',
    rule.sourceDocId || '',
    String(rule.extractedByAi ?? false),
    rule.verifiedBy || '',
    rule.verifiedAt || '',
    rule.notes || '',
  ];
}

export function serializeDocumentRow(doc: ProductDocumentRecord): string[] {
  return [
    doc.id,
    doc.driveFileId,
    doc.fileName,
    doc.mimeType,
    doc.webViewLink,
    doc.categoryId,
    doc.subProductId || '',
    doc.extractionStatus,
    doc.extractedDraft ? JSON.stringify(doc.extractedDraft) : '',
    doc.uploadedBy,
    doc.uploadedAt,
  ];
}

export function serializeAssessmentRow(a: BorrowerAssessment): string[] {
  return [
    a.id,
    a.referenceCode,
    a.applicantLabel,
    a.entityType,
    a.industrySector || '',
    a.businessVintageYears != null ? String(a.businessVintageYears) : '',
    String(a.annualTurnoverOrIncome || 0),
    a.creditScore != null ? String(a.creditScore) : '',
    a.existingEmiObligations != null ? String(a.existingEmiObligations) : '',
    a.profitabilityStatus || 'not_provided',
    a.gstTaxCompliant || 'not_provided',
    a.fundingPurpose || 'general_business',
    JSON.stringify(a.dynamicPurposeAnswers || {}),
    String(a.requestedAmount || 0),
    a.currency || 'INR',
    String(a.requestedTenureMonths || 12),
    String(Boolean(a.collateralAvailable)),
    a.collateralType || '',
    a.collateralValue != null ? String(a.collateralValue) : '',
    a.collateralDescription || '',
    a.statedPurpose || '',
    a.assignedOfficer || '',
    a.branchOrDesk || '',
    a.advisorNotes || '',
    JSON.stringify(a.customAttributes || []),
    a.status,
    String(Boolean(a.isFictionalDemo)),
    a.createdAt,
    a.updatedAt,
  ];
}

export function serializeMatchingResultRow(
  referenceCode: string,
  evaluation: MatchingEvaluationRecord
): string[] {
  return [
    evaluation.evaluationId,
    evaluation.assessmentId,
    referenceCode,
    evaluation.evaluatedAt,
    evaluation.evaluatedBy || '',
    evaluation.datasetMode,
    JSON.stringify(evaluation.top3SubProducts || []),
    JSON.stringify(evaluation),
  ];
}

export function serializePolicyLogRow(entry: PolicyReviewLogEntry): string[] {
  return [
    entry.id,
    entry.timestamp,
    entry.actorEmail,
    entry.actorRole,
    entry.actionType,
    entry.targetEntityType,
    entry.targetEntityId,
    entry.summary,
  ];
}

// --- Header-Aware Row Helper ---

function createCellReader(
  headerRow: string[] | undefined,
  canonicalHeaders: string[]
): (row: string[], colName: string) => string {
  const headerIndexMap = new Map<string, number>();
  if (headerRow && headerRow.length > 0) {
    headerRow.forEach((h, idx) => {
      const normalized = (h || '').trim().toLowerCase();
      if (normalized) headerIndexMap.set(normalized, idx);
    });
  }

  return (row: string[], colName: string): string => {
    const mappedIdx = headerIndexMap.get(colName.toLowerCase());
    if (mappedIdx !== undefined) {
      return row[mappedIdx] ?? '';
    }
    const fallbackIdx = canonicalHeaders.indexOf(colName);
    return fallbackIdx >= 0 ? row[fallbackIdx] ?? '' : '';
  };
}

interface SpreadsheetMetadataResponse {
  spreadsheetId: string;
  spreadsheetUrl?: string;
  properties?: { title?: string };
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
      gridProperties?: { rowCount?: number; columnCount?: number };
    };
  }>;
}

/**
 * Dedicated Google Sheets v4 API Client supporting both OAuth 2.0 Bearer tokens
 * and Google Cloud Service Account JWT credentials across all 7 required LoanBazaar tabs.
 */
export class GoogleSheetsApiClient {
  private readonly accessToken: string;

  constructor(accessToken: string) {
    if (!accessToken || !accessToken.trim()) {
      throw new Error('Google Sheets API client requires a valid OAuth or Service Account token.');
    }
    this.accessToken = accessToken.trim();
  }

  static async fromRequestOrServiceAccount(
    oauthBearerToken?: string | null
  ): Promise<{
    client: GoogleSheetsApiClient | null;
    authMode: SheetsAuthMode;
    serviceAccountEmail: string | null;
  }> {
    const resolved = await resolveSheetsApiAuth(oauthBearerToken);
    if (!resolved.accessToken) {
      return {
        client: null,
        authMode: 'unauthenticated',
        serviceAccountEmail: resolved.serviceAccountEmail,
      };
    }
    return {
      client: new GoogleSheetsApiClient(resolved.accessToken),
      authMode: resolved.authMode,
      serviceAccountEmail: resolved.serviceAccountEmail,
    };
  }

  private async request<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(options?.headers || {}),
      },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const apiMessage =
        data?.error?.message ||
        (typeof data?.error === 'string' ? data.error : null) ||
        `Google Sheets API error (${res.status})`;
      throw new Error(apiMessage);
    }
    return data as T;
  }

  async getSpreadsheetMetadata(
    spreadsheetId: string
  ): Promise<SpreadsheetMetadataResponse> {
    return this.request<SpreadsheetMetadataResponse>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}?includeGridData=false`
    );
  }

  /**
   * Creates a new Google Spreadsheet with all 7 required LoanBazaar tabs,
   * frozen header rows, and initial 19 empty category placeholders.
   */
  async createMasterWorkbook(
    title = 'LoanBazaar – AI Product Matching Master'
  ): Promise<{ spreadsheetId: string; spreadsheetTitle: string; spreadsheetUrl: string }> {
    const created = await this.request<{
      spreadsheetId: string;
      spreadsheetUrl?: string;
      properties?: { title?: string };
    }>('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      body: JSON.stringify({
        properties: { title },
        sheets: ALL_REQUIRED_TAB_NAMES.map((tabTitle) => ({
          properties: {
            title: tabTitle,
            gridProperties: {
              frozenRowCount: 1,
              columnCount: Math.max(20, SHEET_HEADERS[tabTitle].length + 2),
            },
          },
        })),
      }),
    });

    const spreadsheetId = created.spreadsheetId;
    const initialCategories = createInitialEmptyCategories();

    const dataRanges = ALL_REQUIRED_TAB_NAMES.map((tabName) => {
      const headers = SHEET_HEADERS[tabName];
      if (tabName === REQUIRED_SHEET_TABS.CATEGORIES) {
        return {
          range: `'${tabName}'!A1`,
          values: [headers, ...initialCategories.map(serializeCategoryRow)],
        };
      }
      return {
        range: `'${tabName}'!A1`,
        values: [headers],
      };
    });

    await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: dataRanges,
        }),
      }
    );

    return {
      spreadsheetId,
      spreadsheetTitle: created.properties?.title || title,
      spreadsheetUrl:
        created.spreadsheetUrl ||
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    };
  }

  /**
   * Inspects spreadsheet metadata first (never assuming "Sheet1"), creates any missing
   * required tabs, and writes canonical header rows on empty tabs without overwriting data.
   */
  async ensureRequiredSheetsAndHeaders(
    rawSpreadsheetIdOrUrl: string
  ): Promise<{ spreadsheetId: string; spreadsheetTitle: string; spreadsheetUrl: string }> {
    const spreadsheetId = extractSpreadsheetId(rawSpreadsheetIdOrUrl);
    const meta = await this.getSpreadsheetMetadata(spreadsheetId);

    const existingTitles = new Set(
      (meta.sheets || []).map((s) => s.properties?.title || '').filter(Boolean)
    );

    const missingTabs = ALL_REQUIRED_TAB_NAMES.filter((t) => !existingTitles.has(t));
    if (missingTabs.length > 0) {
      await this.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}:batchUpdate`,
        {
          method: 'POST',
          body: JSON.stringify({
            requests: missingTabs.map((tabTitle) => ({
              addSheet: {
                properties: {
                  title: tabTitle,
                  gridProperties: {
                    frozenRowCount: 1,
                    columnCount: Math.max(20, SHEET_HEADERS[tabTitle].length + 2),
                  },
                },
              },
            })),
          }),
        }
      );
    }

    const rangesParam = ALL_REQUIRED_TAB_NAMES.map(
      (t) => `ranges=${encodeURIComponent(`'${t}'!A1:AD2`)}`
    ).join('&');

    const checkValues = await this.request<{
      valueRanges?: Array<{ range?: string; values?: string[][] }>;
    }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchGet?${rangesParam}`
    );

    const headerUpdates: Array<{ range: string; values: string[][] }> = [];
    ALL_REQUIRED_TAB_NAMES.forEach((tabName, idx) => {
      const existingRows = checkValues.valueRanges?.[idx]?.values || [];
      if (existingRows.length === 0) {
        if (tabName === REQUIRED_SHEET_TABS.CATEGORIES) {
          headerUpdates.push({
            range: `'${tabName}'!A1`,
            values: [
              SHEET_HEADERS[tabName],
              ...createInitialEmptyCategories().map(serializeCategoryRow),
            ],
          });
        } else {
          headerUpdates.push({
            range: `'${tabName}'!A1`,
            values: [SHEET_HEADERS[tabName]],
          });
        }
      } else {
        // Ensure canonical headers exist if row 1 is missing trailing columns
        const row1 = (existingRows[0] || []).map((c) => c.trim().toLowerCase());
        const canonical = SHEET_HEADERS[tabName];
        const missingAny = canonical.some((col) => !row1.includes(col.toLowerCase()));
        if (missingAny && existingRows.length === 1) {
          headerUpdates.push({
            range: `'${tabName}'!A1`,
            values: [canonical],
          });
        }
      }
    });

    if (headerUpdates.length > 0) {
      await this.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values:batchUpdate`,
        {
          method: 'POST',
          body: JSON.stringify({
            valueInputOption: 'RAW',
            data: headerUpdates,
          }),
        }
      );
    }

    return {
      spreadsheetId,
      spreadsheetTitle: meta.properties?.title || 'Connected LoanBazaar Sheet',
      spreadsheetUrl:
        meta.spreadsheetUrl ||
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    };
  }

  /**
   * Inspects live schema status, header health, and row counts across all 7 required sheets.
   */
  async inspectSchemaStatus(spreadsheetId: string): Promise<{
    spreadsheetTitle: string;
    spreadsheetUrl: string;
    tabs: SheetTabSchemaStatus[];
  }> {
    const meta = await this.getSpreadsheetMetadata(spreadsheetId);
    const sheetMap = new Map<string, number | null>();
    for (const s of meta.sheets || []) {
      if (s.properties?.title) {
        sheetMap.set(s.properties.title, s.properties.sheetId ?? null);
      }
    }

    const existingRequired = ALL_REQUIRED_TAB_NAMES.filter((t) => sheetMap.has(t));
    const valueByTab = new Map<RequiredSheetTabName, string[][]>();

    if (existingRequired.length > 0) {
      const rangesQuery = existingRequired
        .map((t) => {
          const endCol = columnIndexToLetter(SHEET_HEADERS[t].length);
          return `ranges=${encodeURIComponent(`'${t}'!A:${endCol}`)}`;
        })
        .join('&');

      const batch = await this.request<{
        valueRanges?: Array<{ values?: string[][] }>;
      }>(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values:batchGet?${rangesQuery}`
      );

      existingRequired.forEach((tabName, idx) => {
        valueByTab.set(tabName, batch.valueRanges?.[idx]?.values || []);
      });
    }

    const tabs: SheetTabSchemaStatus[] = ALL_REQUIRED_TAB_NAMES.map((tabName) => {
      const exists = sheetMap.has(tabName);
      if (!exists) {
        return {
          tabName,
          sheetId: null,
          exists: false,
          headersValid: false,
          missingHeaders: SHEET_HEADERS[tabName],
          rowCount: 0,
        };
      }

      const rows = valueByTab.get(tabName) || [];
      const headerRow = (rows[0] || []).map((h) => (h || '').trim().toLowerCase());
      const missingHeaders = SHEET_HEADERS[tabName].filter(
        (expected) => !headerRow.includes(expected.toLowerCase())
      );
      const dataRowCount = rows
        .slice(1)
        .filter((r) => r.some((cell) => (cell || '').trim().length > 0)).length;

      return {
        tabName,
        sheetId: sheetMap.get(tabName) ?? null,
        exists: true,
        headersValid: missingHeaders.length === 0,
        missingHeaders,
        rowCount: dataRowCount,
      };
    });

    return {
      spreadsheetTitle: meta.properties?.title || 'Connected LoanBazaar Sheet',
      spreadsheetUrl:
        meta.spreadsheetUrl ||
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      tabs,
    };
  }

  /**
   * Reads structured key-value rows from any single required sheet tab for inspection or API queries.
   */
  async readTabPreview(
    spreadsheetId: string,
    tabName: RequiredSheetTabName,
    limit = 100
  ): Promise<SheetTabPreviewPayload> {
    const canonical = SHEET_HEADERS[tabName];
    const endCol = columnIndexToLetter(canonical.length);
    const data = await this.request<{ values?: string[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(`'${tabName}'!A:${endCol}`)}`
    );

    const allValues = data.values || [];
    const headers = allValues[0]?.length ? allValues[0] : canonical;
    const rawDataRows = allValues
      .slice(1)
      .filter((r) => r.some((cell) => (cell || '').trim().length > 0));

    const rows = rawDataRows.slice(0, limit).map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = r[i] ?? '';
      });
      return obj;
    });

    return {
      tabName,
      headers,
      totalRows: rawDataRows.length,
      rows,
    };
  }

  /**
   * Reads all 7 required LoanBazaar sheets in a single atomic batchGet request
   * using dynamic header-name mapping and open-ended row ranges.
   */
  async readAllWorkbookData(spreadsheetId: string): Promise<{
    categories: ProductCategory[];
    assessments: BorrowerAssessment[];
    documents: ProductDocumentRecord[];
    policyLogs: PolicyReviewLogEntry[];
  }> {
    // Ensure tabs exist first if spreadsheet was freshly shared or modified
    await this.ensureRequiredSheetsAndHeaders(spreadsheetId);

    const rangesQuery = ALL_REQUIRED_TAB_NAMES.map((t) => {
      const endCol = columnIndexToLetter(SHEET_HEADERS[t].length + 2);
      return `ranges=${encodeURIComponent(`'${t}'!A:${endCol}`)}`;
    }).join('&');

    const batch = await this.request<{
      valueRanges?: Array<{ values?: string[][] }>;
    }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchGet?${rangesQuery}`
    );

    const [
      catValues = [],
      subValues = [],
      ruleValues = [],
      docValues = [],
      asmtValues = [],
      matchValues = [],
      logValues = [],
    ] = (batch.valueRanges || []).map((vr) => vr.values || []);

    const readRuleCell = createCellReader(
      ruleValues[0],
      SHEET_HEADERS.Eligibility_Rules
    );
    const allRules: ConfigurableRuleField[] = ruleValues
      .slice(1)
      .filter((r) => readRuleCell(r, 'rule_id').trim().length > 0)
      .map((r) => {
        const op = (readRuleCell(r, 'operator') ||
          'number_min') as ConfigurableRuleField['operator'];
        const rawExpected = readRuleCell(r, 'expected_value');
        let parsedExpected: string | number | boolean = rawExpected;
        if (op === 'number_min' || op === 'number_max') {
          parsedExpected = Number(rawExpected) || 0;
        } else if (op === 'boolean_equals') {
          parsedExpected = rawExpected.toLowerCase() === 'true';
        }

        return {
          id: readRuleCell(r, 'rule_id'),
          categoryId: readRuleCell(r, 'category_id'),
          subProductId: readRuleCell(r, 'sub_product_id'),
          stage:
            (readRuleCell(r, 'stage') as ConfigurableRuleField['stage']) ||
            'stage2_eligibility',
          targetField:
            (readRuleCell(r, 'target_field') as ConfigurableRuleField['targetField']) ||
            'requestedAmount',
          customKey: readRuleCell(r, 'custom_key'),
          label: readRuleCell(r, 'label') || 'Rule Criterion',
          operator: op,
          expectedValue: parsedExpected,
          isMandatory: readRuleCell(r, 'is_mandatory') !== 'false',
          verificationStatus:
            (readRuleCell(
              r,
              'verification_status'
            ) as ConfigurableRuleField['verificationStatus']) || 'verified',
          sourceDocId: readRuleCell(r, 'source_doc_id'),
          extractedByAi: readRuleCell(r, 'extracted_by_ai') === 'true',
          verifiedBy: readRuleCell(r, 'verified_by'),
          verifiedAt: readRuleCell(r, 'verified_at'),
          notes: readRuleCell(r, 'notes'),
        };
      });

    const readSubCell = createCellReader(subValues[0], SHEET_HEADERS.Sub_Products);
    const subProductsByCategory = new Map<string, SubProduct[]>();
    for (const r of subValues.slice(1)) {
      const spId = readSubCell(r, 'sub_product_id').trim();
      const catId = readSubCell(r, 'category_id').trim();
      if (!spId || !catId) continue;

      const spRules = allRules.filter((rule) => rule.subProductId === spId);
      const sp: SubProduct = {
        id: spId,
        categoryId: catId,
        code: readSubCell(r, 'code'),
        name: readSubCell(r, 'name'),
        status: (readSubCell(r, 'status') as SubProduct['status']) || 'placeholder',
        verificationStatus:
          (readSubCell(
            r,
            'verification_status'
          ) as SubProduct['verificationStatus']) || 'verified',
        description: readSubCell(r, 'description'),
        studyMaterialRef: readSubCell(r, 'study_material_ref'),
        suitableBorrowerTypes: safeJsonParse<string[]>(
          readSubCell(r, 'suitable_borrower_types_json'),
          []
        ),
        fundingPurposes: safeJsonParse<string[]>(
          readSubCell(r, 'funding_purposes_json'),
          []
        ),
        financialRequirements: safeJsonParse<string[]>(
          readSubCell(r, 'financial_requirements_json'),
          []
        ),
        collateralRequirements: safeJsonParse<string[]>(
          readSubCell(r, 'collateral_requirements_json'),
          []
        ),
        requiredDocuments: safeJsonParse<string[]>(
          readSubCell(r, 'required_documents_json'),
          []
        ),
        restrictionsAndExclusions: safeJsonParse<string[]>(
          readSubCell(r, 'restrictions_exclusions_json'),
          []
        ),
        attributes: safeJsonParse(readSubCell(r, 'attributes_json'), []),
        sourceDocumentIds: safeJsonParse<string[]>(
          readSubCell(r, 'source_doc_ids_json'),
          []
        ),
        baselineRules: spRules,
        isFictionalDemo: false,
        updatedAt: readSubCell(r, 'updated_at') || new Date().toISOString(),
      };

      const list = subProductsByCategory.get(catId) || [];
      list.push(sp);
      subProductsByCategory.set(catId, list);
    }

    const readCatCell = createCellReader(
      catValues[0],
      SHEET_HEADERS.Product_Categories
    );
    let categories: ProductCategory[] = catValues
      .slice(1)
      .filter((r) => readCatCell(r, 'category_id').trim().length > 0)
      .map((r, idx) => {
        const catId = readCatCell(r, 'category_id').trim();
        const catLevelRules = allRules.filter(
          (rule) => rule.categoryId === catId && !rule.subProductId
        );
        return {
          id: catId,
          slotNumber: Number(readCatCell(r, 'slot_number')) || idx + 1,
          code:
            readCatCell(r, 'code') || `LB-CAT-${String(idx + 1).padStart(2, '0')}`,
          name: readCatCell(r, 'name'),
          status:
            (readCatCell(r, 'status') as ProductCategory['status']) || 'placeholder',
          description: readCatCell(r, 'description'),
          studyMaterialStatus:
            (readCatCell(
              r,
              'study_material_status'
            ) as ProductCategory['studyMaterialStatus']) || 'pending_upload',
          studyMaterialRef: readCatCell(r, 'study_material_ref'),
          suitableBorrowerTypes: safeJsonParse<string[]>(
            readCatCell(r, 'suitable_borrower_types_json'),
            []
          ),
          fundingPurposes: safeJsonParse<string[]>(
            readCatCell(r, 'funding_purposes_json'),
            []
          ),
          restrictionsAndExclusions: safeJsonParse<string[]>(
            readCatCell(r, 'restrictions_exclusions_json'),
            []
          ),
          attributes: safeJsonParse(readCatCell(r, 'attributes_json'), []),
          sourceDocumentIds: safeJsonParse<string[]>(
            readCatCell(r, 'source_doc_ids_json'),
            []
          ),
          baselineRules: catLevelRules,
          subProducts: subProductsByCategory.get(catId) || [],
          isFictionalDemo: false,
          updatedAt: readCatCell(r, 'updated_at') || new Date().toISOString(),
        };
      });

    if (categories.length === 0) {
      categories = createInitialEmptyCategories(19);
    } else if (categories.length < 19) {
      const defaults = createInitialEmptyCategories(19);
      const presentSlots = new Set(categories.map((c) => c.slotNumber));
      const missingDefs: ProductCategory[] = [];
      for (const def of defaults) {
        if (!presentSlots.has(def.slotNumber)) {
          categories.push(def);
          missingDefs.push(def);
        }
      }
      categories.sort((a, b) => a.slotNumber - b.slotNumber);
      for (const missingDef of missingDefs) {
        try {
          await this.upsertCategoryAndRules(spreadsheetId, missingDef);
        } catch (err) {
          console.warn('Auto-append missing category slot warning:', err);
        }
      }
    }

    const readMatchCell = createCellReader(
      matchValues[0],
      SHEET_HEADERS.Matching_Results
    );
    const latestEvalByAssessment = new Map<string, MatchingEvaluationRecord>();
    for (const r of matchValues.slice(1)) {
      const evalId = readMatchCell(r, 'evaluation_id').trim();
      const asmtId = readMatchCell(r, 'assessment_id').trim();
      if (!evalId || !asmtId) continue;
      const parsedEval = safeJsonParse<MatchingEvaluationRecord | null>(
        readMatchCell(r, 'full_evaluation_json'),
        null
      );
      if (parsedEval) {
        latestEvalByAssessment.set(asmtId, parsedEval);
      }
    }

    const readAsmtCell = createCellReader(
      asmtValues[0],
      SHEET_HEADERS.Borrower_Assessments
    );
    const assessments: BorrowerAssessment[] = asmtValues
      .slice(1)
      .filter((r) => readAsmtCell(r, 'assessment_id').trim().length > 0)
      .map((r) => {
        const id = readAsmtCell(r, 'assessment_id').trim();
        const vintageRaw = readAsmtCell(r, 'business_vintage_years');
        const scoreRaw = readAsmtCell(r, 'credit_score');
        const emiRaw = readAsmtCell(r, 'existing_emi_obligations');
        const colValRaw = readAsmtCell(r, 'collateral_value');

        return {
          id,
          referenceCode: readAsmtCell(r, 'reference_code'),
          applicantLabel: readAsmtCell(r, 'applicant_label'),
          entityType:
            (readAsmtCell(r, 'entity_type') as BorrowerAssessment['entityType']) ||
            'individual',
          industrySector: readAsmtCell(r, 'industry_sector'),
          businessVintageYears: vintageRaw !== '' ? Number(vintageRaw) : null,
          annualTurnoverOrIncome: Number(readAsmtCell(r, 'annual_turnover')) || 0,
          creditScore: scoreRaw !== '' ? Number(scoreRaw) : null,
          existingEmiObligations: emiRaw !== '' ? Number(emiRaw) : null,
          profitabilityStatus:
            (readAsmtCell(
              r,
              'profitability_status'
            ) as BorrowerAssessment['profitabilityStatus']) || 'not_provided',
          gstTaxCompliant:
            (readAsmtCell(
              r,
              'gst_tax_compliant'
            ) as BorrowerAssessment['gstTaxCompliant']) || 'not_provided',
          fundingPurpose:
            (readAsmtCell(
              r,
              'funding_purpose'
            ) as BorrowerAssessment['fundingPurpose']) || 'general_business',
          dynamicPurposeAnswers: safeJsonParse<Record<string, string>>(
            readAsmtCell(r, 'dynamic_purpose_answers_json'),
            {}
          ),
          requestedAmount: Number(readAsmtCell(r, 'requested_amount')) || 0,
          currency: readAsmtCell(r, 'currency') || 'INR',
          requestedTenureMonths:
            Number(readAsmtCell(r, 'requested_tenure_months')) || 12,
          collateralAvailable:
            readAsmtCell(r, 'collateral_available').toLowerCase() === 'true',
          collateralType: readAsmtCell(r, 'collateral_type'),
          collateralValue: colValRaw !== '' ? Number(colValRaw) : null,
          collateralDescription: readAsmtCell(r, 'collateral_description'),
          statedPurpose: readAsmtCell(r, 'stated_purpose'),
          assignedOfficer: readAsmtCell(r, 'assigned_officer'),
          branchOrDesk: readAsmtCell(r, 'branch_or_desk'),
          advisorNotes: readAsmtCell(r, 'advisor_notes'),
          customAttributes: safeJsonParse(
            readAsmtCell(r, 'custom_attributes_json'),
            []
          ),
          status:
            (readAsmtCell(r, 'status') as BorrowerAssessment['status']) || 'submitted',
          isFictionalDemo:
            readAsmtCell(r, 'is_fictional_demo').toLowerCase() === 'true',
          createdAt: readAsmtCell(r, 'created_at') || new Date().toISOString(),
          updatedAt: readAsmtCell(r, 'updated_at') || new Date().toISOString(),
          latestEvaluation: latestEvalByAssessment.get(id) || null,
        };
      });

    const readDocCell = createCellReader(
      docValues[0],
      SHEET_HEADERS.Product_Documents
    );
    const documents: ProductDocumentRecord[] = docValues
      .slice(1)
      .filter((r) => readDocCell(r, 'document_id').trim().length > 0)
      .map((r) => ({
        id: readDocCell(r, 'document_id').trim(),
        driveFileId: readDocCell(r, 'drive_file_id'),
        fileName: readDocCell(r, 'file_name') || 'Document.pdf',
        mimeType: readDocCell(r, 'mime_type') || 'application/pdf',
        webViewLink: readDocCell(r, 'web_view_link'),
        categoryId: readDocCell(r, 'category_id'),
        subProductId: readDocCell(r, 'sub_product_id'),
        extractionStatus:
          (readDocCell(
            r,
            'extraction_status'
          ) as ProductDocumentRecord['extractionStatus']) || 'uploaded',
        extractedDraft: safeJsonParse<ExtractedPdfDraft | null>(
          readDocCell(r, 'extracted_draft_json'),
          null
        ),
        uploadedBy: readDocCell(r, 'uploaded_by'),
        uploadedAt: readDocCell(r, 'uploaded_at') || new Date().toISOString(),
      }));

    const readLogCell = createCellReader(
      logValues[0],
      SHEET_HEADERS.Policy_Review_Log
    );
    const policyLogs: PolicyReviewLogEntry[] = logValues
      .slice(1)
      .filter((r) => readLogCell(r, 'log_id').trim().length > 0)
      .map((r) => ({
        id: readLogCell(r, 'log_id').trim(),
        timestamp: readLogCell(r, 'timestamp'),
        actorEmail: readLogCell(r, 'actor_email'),
        actorRole: (readLogCell(r, 'actor_role') as UserRole) || 'admin',
        actionType:
          (readLogCell(
            r,
            'action_type'
          ) as PolicyReviewLogEntry['actionType']) || 'product_updated',
        targetEntityType:
          (readLogCell(
            r,
            'target_entity_type'
          ) as PolicyReviewLogEntry['targetEntityType']) || 'category',
        targetEntityId: readLogCell(r, 'target_entity_id'),
        summary: readLogCell(r, 'summary'),
      }))
      .reverse();

    return {
      categories,
      assessments,
      documents,
      policyLogs,
    };
  }

  /**
   * Row-level upsert by Column A primary ID: updates ONLY the matching row in place,
   * or appends a new row at the bottom without disturbing other rows edited in Google Sheets.
   */
  async upsertRowByPrimaryId(
    spreadsheetId: string,
    tabName: RequiredSheetTabName,
    recordId: string,
    serializedRow: string[]
  ): Promise<'updated' | 'appended'> {
    const idColValues = await this.request<{ values?: string[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(`'${tabName}'!A:A`)}`
    );

    const colRows = idColValues.values || [];
    let matchedOneBasedRow = -1;
    for (let i = 1; i < colRows.length; i++) {
      if ((colRows[i]?.[0] || '').trim() === recordId) {
        matchedOneBasedRow = i + 1;
        break;
      }
    }

    const endCol = columnIndexToLetter(SHEET_HEADERS[tabName].length);

    if (matchedOneBasedRow > 1) {
      await this.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values/${encodeURIComponent(
          `'${tabName}'!A${matchedOneBasedRow}:${endCol}${matchedOneBasedRow}`
        )}?valueInputOption=RAW`,
        {
          method: 'PUT',
          body: JSON.stringify({ values: [serializedRow] }),
        }
      );
      return 'updated';
    }

    await this.appendRow(spreadsheetId, tabName, serializedRow);
    return 'appended';
  }

  /**
   * Deletes the exact row matching `recordId` in Column A using `deleteDimension`
   * so other rows in the sheet remain intact.
   */
  async deleteRowByPrimaryId(
    spreadsheetId: string,
    tabName: RequiredSheetTabName,
    recordId: string
  ): Promise<boolean> {
    const meta = await this.getSpreadsheetMetadata(spreadsheetId);
    const sheetObj = (meta.sheets || []).find(
      (s) => s.properties?.title === tabName
    );
    const sheetId = sheetObj?.properties?.sheetId;
    if (sheetId === undefined) return false;

    const idColValues = await this.request<{ values?: string[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(`'${tabName}'!A:A`)}`
    );

    const colRows = idColValues.values || [];
    const zeroBasedIndicesToDelete: number[] = [];
    for (let i = 1; i < colRows.length; i++) {
      if ((colRows[i]?.[0] || '').trim() === recordId) {
        zeroBasedIndicesToDelete.push(i);
      }
    }

    if (zeroBasedIndicesToDelete.length === 0) return false;

    // Delete bottom-up so row indices don't shift mid-batch
    zeroBasedIndicesToDelete.sort((a, b) => b - a);
    await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: zeroBasedIndicesToDelete.map((rowIdx) => ({
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: rowIdx,
                endIndex: rowIdx + 1,
              },
            },
          })),
        }),
      }
    );

    return true;
  }

  /**
   * Appends a single row to a sheet tab.
   */
  async appendRow(
    spreadsheetId: string,
    tabName: RequiredSheetTabName,
    row: string[]
  ): Promise<void> {
    await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(
        `'${tabName}'!A1`
      )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        body: JSON.stringify({ values: [row] }),
      }
    );
  }

  /**
   * Atomically replaces multiple tabs in 2 batch API calls (`values:batchClear` + `values:batchUpdate`).
   */
  async batchOverwriteTabs(
    spreadsheetId: string,
    tabPayloads: Array<{ tabName: RequiredSheetTabName; rows: string[][] }>
  ): Promise<void> {
    if (tabPayloads.length === 0) return;

    const clearRanges = tabPayloads.map(({ tabName }) => {
      const endCol = columnIndexToLetter(SHEET_HEADERS[tabName].length + 2);
      return `'${tabName}'!A:${endCol}`;
    });

    await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchClear`,
      {
        method: 'POST',
        body: JSON.stringify({ ranges: clearRanges }),
      }
    );

    const data = tabPayloads.map(({ tabName, rows }) => ({
      range: `'${tabName}'!A1`,
      values: [SHEET_HEADERS[tabName], ...rows],
    }));

    await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data,
        }),
      }
    );
  }

  // --- Domain-Specific Sheet Operations ---

  async syncCatalogAndRules(
    spreadsheetId: string,
    categories: ProductCategory[]
  ): Promise<void> {
    const catRows = categories.map(serializeCategoryRow);
    const subRows: string[][] = [];
    const ruleRows: string[][] = [];

    for (const cat of categories) {
      for (const rule of cat.baselineRules) {
        ruleRows.push(serializeRuleRow(rule, cat.id, ''));
      }
      for (const sp of cat.subProducts) {
        subRows.push(serializeSubProductRow(sp));
        for (const spRule of sp.baselineRules) {
          ruleRows.push(serializeRuleRow(spRule, cat.id, sp.id));
        }
      }
    }

    await this.batchOverwriteTabs(spreadsheetId, [
      { tabName: REQUIRED_SHEET_TABS.CATEGORIES, rows: catRows },
      { tabName: REQUIRED_SHEET_TABS.SUB_PRODUCTS, rows: subRows },
      { tabName: REQUIRED_SHEET_TABS.RULES, rows: ruleRows },
    ]);
  }

  async syncOwnerRules(
    spreadsheetId: string,
    categoryId: string,
    subProductId: string,
    ownerRules: ConfigurableRuleField[]
  ): Promise<void> {
    const endCol = columnIndexToLetter(SHEET_HEADERS.Eligibility_Rules.length);
    const current = await this.request<{ values?: string[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(`'Eligibility_Rules'!A:${endCol}`)}`
    );

    const allValues = current.values || [];
    const readCell = createCellReader(
      allValues[0],
      SHEET_HEADERS.Eligibility_Rules
    );

    const retainedRows = allValues
      .slice(1)
      .filter((r) => readCell(r, 'rule_id').trim().length > 0)
      .filter((r) => {
        const rowCat = readCell(r, 'category_id').trim();
        const rowSub = readCell(r, 'sub_product_id').trim();
        if (subProductId) {
          return rowSub !== subProductId;
        }
        return !(rowCat === categoryId && !rowSub);
      });

    const replacementRows = ownerRules.map((rule) =>
      serializeRuleRow(rule, categoryId, subProductId)
    );

    await this.batchOverwriteTabs(spreadsheetId, [
      {
        tabName: REQUIRED_SHEET_TABS.RULES,
        rows: [...retainedRows, ...replacementRows],
      },
    ]);
  }

  async upsertCategoryAndRules(
    spreadsheetId: string,
    category: ProductCategory
  ): Promise<void> {
    await this.upsertRowByPrimaryId(
      spreadsheetId,
      REQUIRED_SHEET_TABS.CATEGORIES,
      category.id,
      serializeCategoryRow(category)
    );
    await this.syncOwnerRules(
      spreadsheetId,
      category.id,
      '',
      category.baselineRules
    );
  }

  async upsertSubProductAndRules(
    spreadsheetId: string,
    subProduct: SubProduct
  ): Promise<void> {
    await this.upsertRowByPrimaryId(
      spreadsheetId,
      REQUIRED_SHEET_TABS.SUB_PRODUCTS,
      subProduct.id,
      serializeSubProductRow(subProduct)
    );
    await this.syncOwnerRules(
      spreadsheetId,
      subProduct.categoryId,
      subProduct.id,
      subProduct.baselineRules
    );
  }

  async deleteSubProductAndRules(
    spreadsheetId: string,
    categoryId: string,
    subProductId: string
  ): Promise<void> {
    await this.deleteRowByPrimaryId(
      spreadsheetId,
      REQUIRED_SHEET_TABS.SUB_PRODUCTS,
      subProductId
    );
    await this.syncOwnerRules(spreadsheetId, categoryId, subProductId, []);
  }

  async upsertDocument(
    spreadsheetId: string,
    doc: ProductDocumentRecord
  ): Promise<void> {
    await this.upsertRowByPrimaryId(
      spreadsheetId,
      REQUIRED_SHEET_TABS.DOCUMENTS,
      doc.id,
      serializeDocumentRow(doc)
    );
  }

  async syncDocuments(
    spreadsheetId: string,
    documents: ProductDocumentRecord[]
  ): Promise<void> {
    await this.batchOverwriteTabs(spreadsheetId, [
      {
        tabName: REQUIRED_SHEET_TABS.DOCUMENTS,
        rows: documents.map(serializeDocumentRow),
      },
    ]);
  }

  async upsertAssessment(
    spreadsheetId: string,
    assessment: BorrowerAssessment
  ): Promise<void> {
    await this.upsertRowByPrimaryId(
      spreadsheetId,
      REQUIRED_SHEET_TABS.ASSESSMENTS,
      assessment.id,
      serializeAssessmentRow(assessment)
    );
  }

  async deleteAssessment(
    spreadsheetId: string,
    assessmentId: string
  ): Promise<void> {
    await this.deleteRowByPrimaryId(
      spreadsheetId,
      REQUIRED_SHEET_TABS.ASSESSMENTS,
      assessmentId
    );
  }

  async syncAssessments(
    spreadsheetId: string,
    assessments: BorrowerAssessment[]
  ): Promise<void> {
    await this.batchOverwriteTabs(spreadsheetId, [
      {
        tabName: REQUIRED_SHEET_TABS.ASSESSMENTS,
        rows: assessments.map(serializeAssessmentRow),
      },
    ]);
  }

  async appendMatchingResult(
    spreadsheetId: string,
    referenceCode: string,
    evaluation: MatchingEvaluationRecord
  ): Promise<void> {
    await this.appendRow(
      spreadsheetId,
      REQUIRED_SHEET_TABS.MATCHING_RESULTS,
      serializeMatchingResultRow(referenceCode, evaluation)
    );
  }

  async appendPolicyLog(
    spreadsheetId: string,
    entry: PolicyReviewLogEntry
  ): Promise<void> {
    await this.appendRow(
      spreadsheetId,
      REQUIRED_SHEET_TABS.POLICY_LOG,
      serializePolicyLogRow(entry)
    );
  }
}
