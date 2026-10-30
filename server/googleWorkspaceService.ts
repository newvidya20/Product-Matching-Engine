import type {
  AuthenticatedGoogleUser,
  BorrowerAssessment,
  DriveFileSummary,
  MatchingEvaluationRecord,
  PolicyReviewLogEntry,
  ProductCategory,
  ProductDocumentRecord,
  UserRole,
  WorkspaceConnectionConfig,
} from '../src/types/domain.ts';
import {
  ALL_REQUIRED_TAB_NAMES,
  GoogleSheetsApiClient,
  REQUIRED_SHEET_TABS,
  SHEET_HEADERS,
  isValidRequiredTabName,
  loadConfiguredServiceAccount,
  resolveSheetsApiAuth,
} from './googleSheetsClient.ts';

export {
  ALL_REQUIRED_TAB_NAMES,
  GoogleSheetsApiClient,
  REQUIRED_SHEET_TABS,
  SHEET_HEADERS,
  isValidRequiredTabName,
  loadConfiguredServiceAccount,
  resolveSheetsApiAuth,
};

export async function verifyGoogleAccessToken(
  accessToken: string,
  workspaceConfig: WorkspaceConnectionConfig
): Promise<AuthenticatedGoogleUser> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(
      'Google session expired or invalid. Please sign in with Google again.'
    );
  }

  const info = (await res.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };

  if (!info.email) {
    throw new Error('Unable to read verified email address from Google account.');
  }

  const normalizedEmail = info.email.toLowerCase().trim();
  const normalizedAdmins = workspaceConfig.adminEmails.map((e) =>
    e.toLowerCase().trim()
  );

  let role: UserRole = 'employee';
  if (
    normalizedEmail === 'viloanbazzar@gmail.com' ||
    normalizedAdmins.includes(normalizedEmail) ||
    (workspaceConfig.connectedByEmail &&
      workspaceConfig.connectedByEmail.toLowerCase().trim() === normalizedEmail) ||
    normalizedAdmins.length === 0
  ) {
    role = 'admin';
  }

  return {
    uid: info.sub || normalizedEmail,
    email: normalizedEmail,
    displayName: info.name || normalizedEmail,
    photoURL: info.picture,
    role,
  };
}

async function googleDriveJson<T>(
  url: string,
  accessToken: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const apiMessage =
      data?.error?.message ||
      (typeof data?.error === 'string' ? data.error : null) ||
      `Google Drive API error (${res.status})`;
    throw new Error(apiMessage);
  }
  return data as T;
}

// --- Compatibility wrappers delegating to GoogleSheetsApiClient ---

export async function createLoanBazaarMasterSpreadsheet(
  accessToken: string,
  title = 'LoanBazaar – AI Product Matching Master'
): Promise<{
  spreadsheetId: string;
  spreadsheetTitle: string;
  spreadsheetUrl: string;
}> {
  const client = new GoogleSheetsApiClient(accessToken);
  return client.createMasterWorkbook(title);
}

export async function connectAndEnsureSpreadsheetStructure(
  accessToken: string,
  rawSpreadsheetIdOrUrl: string
): Promise<{
  spreadsheetId: string;
  spreadsheetTitle: string;
  spreadsheetUrl: string;
}> {
  const client = new GoogleSheetsApiClient(accessToken);
  return client.ensureRequiredSheetsAndHeaders(rawSpreadsheetIdOrUrl);
}

export async function readAllSheetsData(
  accessToken: string,
  spreadsheetId: string
): Promise<{
  categories: ProductCategory[];
  assessments: BorrowerAssessment[];
  documents: ProductDocumentRecord[];
  policyLogs: PolicyReviewLogEntry[];
}> {
  const client = new GoogleSheetsApiClient(accessToken);
  return client.readAllWorkbookData(spreadsheetId);
}

export async function syncCatalogAndRulesToSheets(
  accessToken: string,
  spreadsheetId: string,
  categories: ProductCategory[]
): Promise<void> {
  const client = new GoogleSheetsApiClient(accessToken);
  await client.syncCatalogAndRules(spreadsheetId, categories);
}

export async function syncDocumentsToSheets(
  accessToken: string,
  spreadsheetId: string,
  documents: ProductDocumentRecord[]
): Promise<void> {
  const client = new GoogleSheetsApiClient(accessToken);
  await client.syncDocuments(spreadsheetId, documents);
}

export async function syncAssessmentsToSheets(
  accessToken: string,
  spreadsheetId: string,
  assessments: BorrowerAssessment[]
): Promise<void> {
  const client = new GoogleSheetsApiClient(accessToken);
  await client.syncAssessments(spreadsheetId, assessments);
}

export async function appendMatchingResultToSheets(
  accessToken: string,
  spreadsheetId: string,
  referenceCode: string,
  evaluation: MatchingEvaluationRecord
): Promise<void> {
  const client = new GoogleSheetsApiClient(accessToken);
  await client.appendMatchingResult(spreadsheetId, referenceCode, evaluation);
}

export async function appendPolicyLogToSheets(
  accessToken: string,
  spreadsheetId: string,
  entry: PolicyReviewLogEntry
): Promise<void> {
  const client = new GoogleSheetsApiClient(accessToken);
  await client.appendPolicyLog(spreadsheetId, entry);
}

// --- Google Drive Operations ---

export async function listDriveFilesByMime(
  accessToken: string,
  mimeType: string,
  searchQuery = '',
  folderId = ''
): Promise<DriveFileSummary[]> {
  const clauses = [`mimeType='${mimeType}'`, 'trashed=false'];
  if (folderId.trim()) {
    clauses.push(`'${folderId.trim()}' in parents`);
  }
  if (searchQuery.trim()) {
    const escaped = searchQuery.trim().replace(/'/g, "\\'");
    clauses.push(`name contains '${escaped}'`);
  }

  const q = encodeURIComponent(clauses.join(' and '));
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=40&orderBy=modifiedTime desc&fields=files(id,name,mimeType,webViewLink,modifiedTime)`;
  const data = await googleDriveJson<{ files?: DriveFileSummary[] }>(
    url,
    accessToken
  );
  return data.files || [];
}

export async function createLoanBazaarDriveFolder(
  accessToken: string,
  folderName = 'LoanBazaar Product Study Materials'
): Promise<DriveFileSummary> {
  return googleDriveJson<DriveFileSummary>(
    'https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,webViewLink',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    }
  );
}

export async function uploadPdfToGoogleDrive(
  accessToken: string,
  fileName: string,
  base64Pdf: string,
  folderId?: string,
  mimeType = 'application/pdf'
): Promise<DriveFileSummary> {
  const effectiveMime = (mimeType || 'application/pdf').trim() || 'application/pdf';
  const metadata: Record<string, unknown> = {
    name: fileName,
    mimeType: effectiveMime,
  };
  if (folderId && folderId.trim()) {
    metadata.parents = [folderId.trim()];
  }

  const boundary = `loanbazaar_boundary_${Date.now()}`;
  const metadataPart =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n`;
  const mediaHeader =
    `--${boundary}\r\n` + `Content-Type: ${effectiveMime}\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;

  const pdfBuffer = Buffer.from(base64Pdf, 'base64');
  const bodyBuffer = Buffer.concat([
    Buffer.from(metadataPart, 'utf-8'),
    Buffer.from(mediaHeader, 'utf-8'),
    pdfBuffer,
    Buffer.from(closing, 'utf-8'),
  ]);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,modifiedTime',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: bodyBuffer,
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data?.error?.message ||
        `Failed to upload study material to Google Drive (${res.status})`
    );
  }
  return data as DriveFileSummary;
}

export async function downloadDrivePdfAsBase64(
  accessToken: string,
  driveFileId: string,
  mimeType = 'application/pdf'
): Promise<string> {
  const isGoogleWorkspaceDoc = mimeType.startsWith(
    'application/vnd.google-apps.'
  );
  const url = isGoogleWorkspaceDoc
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        driveFileId
      )}/export?mimeType=${encodeURIComponent('application/pdf')}`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        driveFileId
      )}?alt=media&supportsAllDrives=true`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Unable to download study material from Google Drive (${
        res.status
      }). ${errText.slice(0, 140)}`
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

const KNOWN_FINANCE_ACRONYMS = new Set([
  'fdi',
  'ecb',
  'npa',
  'arc',
  'psu',
  'ipo',
  'pe',
  'vc',
  'gst',
  'ebitda',
  'bot',
  'ham',
  'od',
  'cc',
  'lc',
  'bg',
  'sblc',
  'lap',
  'lrd',
  'msme',
  'sme',
  'nbfc',
  'cgtmse',
  'epc',
  'spv',
  'dscr',
  'ltv',
  'roi',
  'emi',
  'inr',
  'usd',
  'fx',
  'treds',
]);

const MINOR_TITLE_WORDS = new Set([
  'and',
  'or',
  'of',
  'in',
  'for',
  'to',
  'by',
  'with',
  'on',
  'at',
]);

function smartTitleCaseWords(raw: string): string {
  const spaced = raw
    .replace(/\(/g, ' (')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = spaced.split(' ');
  return tokens
    .map((token, idx) => {
      // Handle leading parenthesis like "(domestic" or "cross-border)"
      const leadMatch = token.match(/^([([{"']*)(.*?)([)\]}"',.:;]*)$/);
      if (!leadMatch) return token;
      const [, prefix, core, suffix] = leadMatch;
      if (!core) return token;

      // Handle hyphenated compounds like "cross-border" or "FDI-foreign"
      if (core.includes('-')) {
        const subParts = core.split('-').map((part, sIdx) => {
          const lowerPart = part.toLowerCase();
          if (KNOWN_FINANCE_ACRONYMS.has(lowerPart)) {
            return lowerPart === 'treds' ? 'TReDS' : lowerPart.toUpperCase();
          }
          if (/[A-Z]{2,}/.test(part)) return part;
          if (idx > 0 && sIdx > 0 && MINOR_TITLE_WORDS.has(lowerPart)) {
            return lowerPart;
          }
          return lowerPart.charAt(0).toUpperCase() + lowerPart.slice(1);
        });
        return `${prefix}${subParts.join('-')}${suffix}`;
      }

      const lower = core.toLowerCase();
      if (KNOWN_FINANCE_ACRONYMS.has(lower)) {
        return `${prefix}${lower === 'treds' ? 'TReDS' : lower.toUpperCase()}${suffix}`;
      }
      if (/[A-Z]{2,}/.test(core)) {
        return `${prefix}${core}${suffix}`;
      }
      if (idx > 0 && !prefix && MINOR_TITLE_WORDS.has(lower)) {
        return `${prefix}${lower}${suffix}`;
      }
      return `${prefix}${lower.charAt(0).toUpperCase()}${lower.slice(1)}${suffix}`;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanDriveCategoryName(rawFolderName: string): string {
  const withoutDriveExportSuffix = rawFolderName
    .trim()
    // Strip Google Drive multi-part ZIP export suffixes like "-PDF-20261023T074744Z-1-001"
    .replace(/(?:[-_\s]+PDF)?[-_\s]+\d{8}T\d{6}Z[-_\s]+\d+[-_\s]+\d+$/i, '')
    .replace(/(?:[-_\s]+PDF)$/i, '')
    // Strip optional leading slot index like "01. " or "02 - " while keeping "2 Wheeler"
    .replace(
      /^(?:slot|cat|category|product|prod)[\s._#-]*\d{1,2}[\s._:)-]+/i,
      ''
    )
    .replace(
      /^(\d{1,2})[\s._:)-]+(?!(?:wheeler|wheelers|w\b|cr\b|crore|lakh|lac|hour|day|month|year|%))/i,
      ''
    )
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return smartTitleCaseWords(withoutDriveExportSuffix || rawFolderName.trim());
}

export function deriveSubProductNameFromDriveFile(rawFileName: string): string {
  const cleaned = rawFileName
    .trim()
    // Strip double/single document extensions like ".docx.pdf", ".doc.pdf", ".pdf", ".docx"
    .replace(/\.(docx|doc|xlsx|xls|pptx|ppt|txt|md)\.(pdf)$/i, '')
    .replace(/\.(pdf|docx|doc|xlsx|xls|pptx|ppt|txt|csv|md|png|jpe?g|webp)$/i, '')
    // Strip Google Drive duplicate suffix like " (1)" or export timestamp
    .replace(/\s*\(\d+\)$/, '')
    .replace(/[-_\s]+\d{8}T\d{6}Z[-_\s]+\d+[-_\s]+\d+$/i, '')
    // Strip study-material article prefix "what-is-" / "what is " while preserving exact product name
    .replace(/^what[-_\s]+is[-_\s]+/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return smartTitleCaseWords(cleaned || rawFileName.trim());
}

async function listAllDriveChildren(
  accessToken: string,
  parentFolderId: string
): Promise<DriveFileSummary[]> {
  const allItems: DriveFileSummary[] = [];
  let pageToken = '';

  do {
    const q = encodeURIComponent(
      `'${parentFolderId}' in parents and trashed = false`
    );
    const tokenParam = pageToken
      ? `&pageToken=${encodeURIComponent(pageToken)}`
      : '';
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${q}` +
      `&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      `&fields=nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime)` +
      tokenParam;

    const data = await googleDriveJson<{
      nextPageToken?: string;
      files?: DriveFileSummary[];
    }>(url, accessToken);

    if (data.files && data.files.length > 0) {
      allItems.push(...data.files);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return allItems;
}

function isSupportedStudyMaterialDriveFile(file: DriveFileSummary): boolean {
  if (file.mimeType === 'application/vnd.google-apps.folder') return false;
  const lowerName = (file.name || '').toLowerCase().trim();
  if (
    !lowerName ||
    lowerName === '.ds_store' ||
    lowerName === 'thumbs.db' ||
    lowerName === 'desktop.ini' ||
    lowerName.startsWith('._') ||
    lowerName.startsWith('~$')
  ) {
    return false;
  }

  const mime = (file.mimeType || '').toLowerCase();
  if (
    mime === 'application/pdf' ||
    mime === 'application/vnd.google-apps.document' ||
    mime === 'application/vnd.google-apps.spreadsheet' ||
    mime === 'application/vnd.google-apps.presentation' ||
    mime.includes('word') ||
    mime.includes('officedocument') ||
    mime.startsWith('text/') ||
    mime.startsWith('image/')
  ) {
    return true;
  }

  return /\.(pdf|docx|doc|xlsx|xls|pptx|ppt|txt|csv|md|png|jpe?g|webp)$/i.test(
    lowerName
  );
}

async function collectStudyMaterialFilesRecursively(
  accessToken: string,
  folderId: string,
  outFiles: DriveFileSummary[],
  visitedFolderIds: Set<string>,
  depth = 0
): Promise<void> {
  if (depth > 5 || visitedFolderIds.has(folderId)) return;
  visitedFolderIds.add(folderId);

  const children = await listAllDriveChildren(accessToken, folderId);
  const subFolders: DriveFileSummary[] = [];

  for (const item of children) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      if (item.name !== '__MACOSX') {
        subFolders.push(item);
      }
    } else if (isSupportedStudyMaterialDriveFile(item)) {
      outFiles.push(item);
    }
  }

  for (const sub of subFolders) {
    await collectStudyMaterialFilesRecursively(
      accessToken,
      sub.id,
      outFiles,
      visitedFolderIds,
      depth + 1
    );
  }
}

function extractDriveFolderIdFromInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{15,})/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9_-]{24,}$/.test(trimmed) && !trimmed.includes(' ')) {
    return trimmed;
  }
  return null;
}

export async function scanGoogleDriveStudyMaterialFolder(
  accessToken: string,
  folderQueryOrId = 'study material'
): Promise<{
  found: boolean;
  searchedQuery: string;
  rootFolder: DriveFileSummary | null;
  candidateFolders: DriveFileSummary[];
  productFolders: Array<{
    folderId: string;
    folderName: string;
    cleanCategoryName: string;
    slotNumber: number;
    files: Array<{
      driveFileId: string;
      fileName: string;
      cleanSubProductName: string;
      mimeType: string;
      webViewLink: string;
      modifiedTime?: string;
    }>;
  }>;
  totalFolders: number;
  totalFiles: number;
}> {
  const queryText = (folderQueryOrId || 'study material').trim() || 'study material';
  const explicitFolderId = extractDriveFolderIdFromInput(queryText);

  let candidateFolders: DriveFileSummary[] = [];
  let chosenRoot: DriveFileSummary | null = null;

  if (explicitFolderId) {
    const meta = await googleDriveJson<DriveFileSummary>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        explicitFolderId
      )}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,modifiedTime`,
      accessToken
    );
    chosenRoot = meta;
    candidateFolders = [meta];
  } else {
    const escaped = queryText.replace(/'/g, "\\'");
    const q = encodeURIComponent(
      `mimeType = 'application/vnd.google-apps.folder' and trashed = false and (name contains '${escaped}' or name contains 'study')`
    );
    const searchRes = await googleDriveJson<{ files?: DriveFileSummary[] }>(
      `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=50&orderBy=modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,webViewLink,modifiedTime)`,
      accessToken
    );
    candidateFolders = searchRes.files || [];

    if (candidateFolders.length === 0) {
      // Fallback: list recent Drive folders so user can pick if named differently
      const anyFolderQ = encodeURIComponent(
        `mimeType = 'application/vnd.google-apps.folder' and trashed = false`
      );
      const recentFolders = await googleDriveJson<{ files?: DriveFileSummary[] }>(
        `https://www.googleapis.com/drive/v3/files?q=${anyFolderQ}&pageSize=30&orderBy=modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,webViewLink,modifiedTime)`,
        accessToken
      );
      return {
        found: false,
        searchedQuery: queryText,
        rootFolder: null,
        candidateFolders: recentFolders.files || [],
        productFolders: [],
        totalFolders: 0,
        totalFiles: 0,
      };
    }

    // Score top candidate folders so we pick the user's "study material" folder containing 19 subfolders
    // instead of the flat "LoanBazaar Product Study Materials" folder with 0 subfolders!
    const topToInspect = candidateFolders.slice(0, 10);
    const scoredCandidates = await Promise.all(
      topToInspect.map(async (folder) => {
        const lower = folder.name.trim().toLowerCase();
        const isExactName =
          lower === queryText.toLowerCase() ||
          lower === 'study material' ||
          lower === 'study materials';

        let subFolderCount = 0;
        try {
          const children = await listAllDriveChildren(accessToken, folder.id);
          subFolderCount = children.filter(
            (c) =>
              c.mimeType === 'application/vnd.google-apps.folder' &&
              c.name !== '__MACOSX'
          ).length;
        } catch {
          subFolderCount = 0;
        }

        let score = 0;
        if (subFolderCount === 19) score += 1000;
        else if (subFolderCount >= 2) score += 500 - Math.abs(19 - subFolderCount) * 5;
        else if (subFolderCount === 1) score += 200;

        if (isExactName) score += 300;
        if (lower === 'loanbazaar product study materials' && subFolderCount === 0) {
          score -= 400;
        }

        return { folder, subFolderCount, score };
      })
    );

    scoredCandidates.sort((a, b) => b.score - a.score);
    chosenRoot = scoredCandidates[0]?.folder || candidateFolders[0];
  }

  if (!chosenRoot) {
    return {
      found: false,
      searchedQuery: queryText,
      rootFolder: null,
      candidateFolders,
      productFolders: [],
      totalFolders: 0,
      totalFiles: 0,
    };
  }

  // Unwrap if chosenRoot contains just 1 wrapper folder and 0 direct files
  let effectiveParent = chosenRoot;
  let rootChildren = await listAllDriveChildren(accessToken, effectiveParent.id);

  for (let unwrapStep = 0; unwrapStep < 2; unwrapStep++) {
    const childFolders = rootChildren.filter(
      (c) =>
        c.mimeType === 'application/vnd.google-apps.folder' &&
        c.name !== '__MACOSX'
    );
    const directDocs = rootChildren.filter(isSupportedStudyMaterialDriveFile);
    if (childFolders.length === 1 && directDocs.length === 0) {
      const innerChildren = await listAllDriveChildren(
        accessToken,
        childFolders[0].id
      );
      const innerSubFolders = innerChildren.filter(
        (c) =>
          c.mimeType === 'application/vnd.google-apps.folder' &&
          c.name !== '__MACOSX'
      );
      if (innerSubFolders.length >= 2) {
        effectiveParent = childFolders[0];
        rootChildren = innerChildren;
        continue;
      }
    }
    break;
  }

  const rawProductFolders = rootChildren
    .filter(
      (c) =>
        c.mimeType === 'application/vnd.google-apps.folder' &&
        c.name !== '__MACOSX'
    )
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    );

  // Scan all 19 product folders with bounded concurrency of 5
  const CONCURRENCY = 5;
  const scannedFolders: Array<{
    folderId: string;
    folderName: string;
    cleanCategoryName: string;
    slotNumber: number;
    files: Array<{
      driveFileId: string;
      fileName: string;
      cleanSubProductName: string;
      mimeType: string;
      webViewLink: string;
      modifiedTime?: string;
    }>;
  }> = new Array(rawProductFolders.length);

  for (let i = 0; i < rawProductFolders.length; i += CONCURRENCY) {
    const chunk = rawProductFolders.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (folder, offset) => {
        const globalIdx = i + offset;
        const collected: DriveFileSummary[] = [];
        await collectStudyMaterialFilesRecursively(
          accessToken,
          folder.id,
          collected,
          new Set<string>(),
          0
        );

        // Deduplicate by driveFileId and sort naturally by filename
        const uniqueMap = new Map<string, DriveFileSummary>();
        for (const f of collected) {
          if (!uniqueMap.has(f.id)) {
            uniqueMap.set(f.id, f);
          }
        }
        const sortedFiles = Array.from(uniqueMap.values()).sort((a, b) =>
          a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: 'base',
          })
        );

        scannedFolders[globalIdx] = {
          folderId: folder.id,
          folderName: folder.name,
          cleanCategoryName: cleanDriveCategoryName(folder.name),
          slotNumber: globalIdx + 1,
          files: sortedFiles.map((f) => ({
            driveFileId: f.id,
            fileName: f.name,
            cleanSubProductName: deriveSubProductNameFromDriveFile(f.name),
            mimeType: f.mimeType || 'application/pdf',
            webViewLink:
              f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
            modifiedTime: f.modifiedTime,
          })),
        };
      })
    );
  }

  const totalFiles = scannedFolders.reduce((sum, pf) => sum + pf.files.length, 0);

  return {
    found: true,
    searchedQuery: queryText,
    rootFolder: chosenRoot,
    candidateFolders,
    productFolders: scannedFolders,
    totalFolders: scannedFolders.length,
    totalFiles,
  };
}

