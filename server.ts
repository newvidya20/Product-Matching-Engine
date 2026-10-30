import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import {
  createInitialEmptyCategories,
  createInitialFictionalAssessments,
  getFictionalDemoCatalogOverlay,
  loadDatabase,
  saveDatabase,
} from './server/storage.ts';
import {
  evaluateLocalStudyMaterialMatch,
  localStudyMaterialCatalog,
  localStudyMaterialDocuments,
} from './server/localStudyMaterialMatcher.ts';
import { generateSeparatedAdvisoryExplanation } from './server/aiExplanationService.ts';
import {
  ALL_REQUIRED_TAB_NAMES,
  GoogleSheetsApiClient,
  SHEET_HEADERS,
  createLoanBazaarDriveFolder,
  downloadDrivePdfAsBase64,
  isValidRequiredTabName,
  listDriveFilesByMime,
  loadConfiguredServiceAccount,
  resolveSheetsApiAuth,
  scanGoogleDriveStudyMaterialFolder,
  uploadPdfToGoogleDrive,
  verifyGoogleAccessToken,
} from './server/googleWorkspaceService.ts';
import { extractPolicyDraftFromPdfBase64 } from './server/pdfExtractionService.ts';
import type {
  AuthenticatedGoogleUser,
  BorrowerAssessment,
  ConfigurableRuleField,
  PolicyReviewLogEntry,
  ProductCategory,
  ProductDocumentRecord,
  SheetsClientStatusPayload,
  SubProduct,
  SystemSettings,
} from './src/types/domain.ts';

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Support up to 100MB JSON payloads for base64 study material uploads to Google Drive
  app.use(express.json({ limit: '100mb' }));

  let db = loadDatabase();
  const configuredSpreadsheetId = (
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID || db.workspaceConfig.spreadsheetId || ''
  ).trim();

  // Preserve a connected Google Sheets workspace for production deployments.
  // Local study-material data is only used as a fallback when no spreadsheet is configured.
  if (configuredSpreadsheetId) {
    db.workspaceConfig = {
      ...db.workspaceConfig,
      spreadsheetId: configuredSpreadsheetId,
      spreadsheetTitle:
        db.workspaceConfig.spreadsheetTitle || 'Configured LoanBazaar Sheet',
      spreadsheetUrl:
        db.workspaceConfig.spreadsheetUrl ||
        `https://docs.google.com/spreadsheets/d/${configuredSpreadsheetId}/edit`,
    };
  } else {
    db.categories = localStudyMaterialCatalog;
    db.documents = localStudyMaterialDocuments;
    db.workspaceConfig = {
      ...db.workspaceConfig,
      spreadsheetId: '',
      spreadsheetTitle: '',
      spreadsheetUrl: '',
      driveFolderId: '',
      driveFolderName: '',
      connectedByEmail: '',
      lastSyncedAt: '',
    };
  }

  async function resolveCurrentUser(req: Request): Promise<{
    oauthToken: string | null;
    sheetsClient: GoogleSheetsApiClient | null;
    effectiveDriveToken: string | null;
    user: AuthenticatedGoogleUser | null;
  }> {
    const oauthToken = extractBearerToken(req);
    let user: AuthenticatedGoogleUser | null = null;
    if (oauthToken) {
      user = await verifyGoogleAccessToken(oauthToken, db.workspaceConfig);
    }

    const resolvedSheets = await GoogleSheetsApiClient.fromRequestOrServiceAccount(
      oauthToken
    );
    const resolvedAuth = await resolveSheetsApiAuth(oauthToken);

    return {
      oauthToken,
      sheetsClient: resolvedSheets.client,
      effectiveDriveToken: resolvedAuth.accessToken,
      user,
    };
  }

  async function requireAdminIfWorkspaceActive(
    req: Request,
    res: Response
  ): Promise<{
    oauthToken: string | null;
    sheetsClient: GoogleSheetsApiClient | null;
    effectiveDriveToken: string | null;
    user: AuthenticatedGoogleUser | null;
  } | null> {
    const oauthToken = extractBearerToken(req);
    if (oauthToken) {
      const user = await verifyGoogleAccessToken(oauthToken, db.workspaceConfig);
      if (user.role !== 'admin') {
        res.status(403).json({
          error:
            'Admin access required. Employees can submit assessments and run matching, while Admins manage products, PDFs, and rule verification.',
        });
        return null;
      }
      const resolvedSheets = await GoogleSheetsApiClient.fromRequestOrServiceAccount(
        oauthToken
      );
      const resolvedAuth = await resolveSheetsApiAuth(oauthToken);
      return {
        oauthToken,
        sheetsClient: resolvedSheets.client,
        effectiveDriveToken: resolvedAuth.accessToken,
        user,
      };
    }

    // Allow Service Account auth when configured on the server
    const sa = loadConfiguredServiceAccount();
    if (sa) {
      const resolvedSheets = await GoogleSheetsApiClient.fromRequestOrServiceAccount(
        null
      );
      const resolvedAuth = await resolveSheetsApiAuth(null);
      return {
        oauthToken: null,
        sheetsClient: resolvedSheets.client,
        effectiveDriveToken: resolvedAuth.accessToken,
        user: {
          uid: sa.client_email,
          email: sa.client_email,
          displayName: 'Service Account Admin',
          role: 'admin',
        },
      };
    }

    if (db.workspaceConfig.spreadsheetId) {
      res.status(401).json({
        error:
          'Sign in with Google as an authorized Admin to modify the connected Google Sheets Product Master.',
      });
      return null;
    }

    return {
      oauthToken: null,
      sheetsClient: null,
      effectiveDriveToken: null,
      user: null,
    };
  }

  async function recordPolicyLog(
    sheetsClient: GoogleSheetsApiClient | null,
    user: AuthenticatedGoogleUser | null,
    actionType: PolicyReviewLogEntry['actionType'],
    targetEntityType: PolicyReviewLogEntry['targetEntityType'],
    targetEntityId: string,
    summary: string
  ) {
    const entry: PolicyReviewLogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      actorEmail: user?.email || 'local-admin@loanbazaar.internal',
      actorRole: user?.role || 'admin',
      actionType,
      targetEntityType,
      targetEntityId,
      summary,
    };
    db.policyLogs.unshift(entry);
    saveDatabase(db);
    if (sheetsClient && db.workspaceConfig.spreadsheetId) {
      await sheetsClient.appendPolicyLog(db.workspaceConfig.spreadsheetId, entry);
    }
  }

  // --- Bootstrap Endpoint (Syncs live from Google Sheets via OAuth or Service Account) ---
  app.get('/api/bootstrap', async (req: Request, res: Response) => {
    try {
      let currentUser: AuthenticatedGoogleUser | null = null;
      const oauthToken = extractBearerToken(req);
      if (oauthToken) {
        try {
          currentUser = await verifyGoogleAccessToken(oauthToken, db.workspaceConfig);
        } catch (authErr) {
          console.warn('Bootstrap Google user token warning:', authErr);
        }
      }

      const { client: sheetsClient } =
        await GoogleSheetsApiClient.fromRequestOrServiceAccount(
          currentUser ? oauthToken : null
        );

      if (sheetsClient && db.workspaceConfig.spreadsheetId) {
        try {
          const liveSheets = await sheetsClient.readAllWorkbookData(
            db.workspaceConfig.spreadsheetId
          );
          db.categories = liveSheets.categories;
          if (
            liveSheets.assessments.length > 0 ||
            !db.settings.showFictionalRecordsInTables
          ) {
            db.assessments = liveSheets.assessments;
          }
          db.documents = liveSheets.documents;
          db.policyLogs = liveSheets.policyLogs;
          db.workspaceConfig.lastSyncedAt = new Date().toISOString();
          saveDatabase(db);
        } catch (syncErr) {
          console.warn('Bootstrap Google Sheets sync warning:', syncErr);
        }
      }

      res.json({
        categories: db.categories,
        fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
        assessments: db.assessments,
        documents: db.documents,
        policyLogs: db.policyLogs,
        settings: db.settings,
        workspaceConfig: db.workspaceConfig,
        currentUser,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to load workspace bootstrap.',
      });
    }
  });

  // --- Dedicated Google Sheets API Client Status, Schema Repair & Direct Tab CRUD ---
  app.get('/api/sheets/status', async (req: Request, res: Response) => {
    try {
      const oauthToken = extractBearerToken(req);
      let oauthUserEmail: string | null = null;
      if (oauthToken) {
        try {
          const u = await verifyGoogleAccessToken(oauthToken, db.workspaceConfig);
          oauthUserEmail = u.email;
        } catch {
          oauthUserEmail = null;
        }
      }

      const sa = loadConfiguredServiceAccount();
      const { client, authMode } =
        await GoogleSheetsApiClient.fromRequestOrServiceAccount(
          oauthUserEmail ? oauthToken : null
        );

      const spreadsheetId = db.workspaceConfig.spreadsheetId;
      if (!client || !spreadsheetId) {
        const defaultTabs = ALL_REQUIRED_TAB_NAMES.map((tabName) => ({
          tabName,
          sheetId: null,
          exists: false,
          headersValid: false,
          missingHeaders: SHEET_HEADERS[tabName],
          rowCount: 0,
        }));

        const payload: SheetsClientStatusPayload = {
          authMode,
          serviceAccountConfigured: Boolean(sa),
          serviceAccountEmail: sa?.client_email || null,
          oauthUserEmail,
          spreadsheetConnected: Boolean(spreadsheetId),
          spreadsheetId,
          spreadsheetTitle: db.workspaceConfig.spreadsheetTitle,
          spreadsheetUrl: db.workspaceConfig.spreadsheetUrl,
          lastSyncedAt: db.workspaceConfig.lastSyncedAt,
          tabs: defaultTabs,
        };
        res.json(payload);
        return;
      }

      const inspected = await client.inspectSchemaStatus(spreadsheetId);
      db.workspaceConfig.spreadsheetTitle = inspected.spreadsheetTitle;
      db.workspaceConfig.spreadsheetUrl = inspected.spreadsheetUrl;
      saveDatabase(db);

      const payload: SheetsClientStatusPayload = {
        authMode,
        serviceAccountConfigured: Boolean(sa),
        serviceAccountEmail: sa?.client_email || null,
        oauthUserEmail,
        spreadsheetConnected: true,
        spreadsheetId,
        spreadsheetTitle: inspected.spreadsheetTitle,
        spreadsheetUrl: inspected.spreadsheetUrl,
        lastSyncedAt: db.workspaceConfig.lastSyncedAt,
        tabs: inspected.tabs,
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to inspect Google Sheets client status.',
      });
    }
  });

  app.post('/api/sheets/repair-schema', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx || !authCtx.sheetsClient) {
        if (!res.headersSent) {
          res.status(401).json({
            error:
              'Authenticate via Google OAuth or configure a Service Account before repairing sheet schema.',
          });
        }
        return;
      }

      const spreadsheetId = db.workspaceConfig.spreadsheetId;
      if (!spreadsheetId) {
        res.status(400).json({ error: 'No Google Spreadsheet is connected yet.' });
        return;
      }

      const ensured = await authCtx.sheetsClient.ensureRequiredSheetsAndHeaders(
        spreadsheetId
      );
      const inspected = await authCtx.sheetsClient.inspectSchemaStatus(
        ensured.spreadsheetId
      );

      db.workspaceConfig.spreadsheetTitle = ensured.spreadsheetTitle;
      db.workspaceConfig.spreadsheetUrl = ensured.spreadsheetUrl;
      db.workspaceConfig.lastSyncedAt = new Date().toISOString();
      saveDatabase(db);

      res.json({
        workspaceConfig: db.workspaceConfig,
        tabs: inspected.tabs,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to repair 7-sheet schema.',
      });
    }
  });

  app.get('/api/sheets/:tabName', async (req: Request, res: Response) => {
    try {
      const tabParam = String(req.params.tabName || '');
      if (!isValidRequiredTabName(tabParam)) {
        res.status(400).json({
          error: `Unsupported sheet tab "${tabParam}". Expected one of: ${ALL_REQUIRED_TAB_NAMES.join(
            ', '
          )}`,
        });
        return;
      }

      const { sheetsClient } = await resolveCurrentUser(req);
      if (!sheetsClient) {
        res.status(401).json({
          error:
            'Sign in with Google or configure a Service Account to read Google Sheets.',
        });
        return;
      }
      if (!db.workspaceConfig.spreadsheetId) {
        res.status(400).json({ error: 'No Google Spreadsheet is connected yet.' });
        return;
      }

      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const preview = await sheetsClient.readTabPreview(
        db.workspaceConfig.spreadsheetId,
        tabParam,
        limit
      );
      res.json(preview);
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to read Google Sheet tab.',
      });
    }
  });

  app.post('/api/sheets/:tabName/rows', async (req: Request, res: Response) => {
    try {
      const tabParam = String(req.params.tabName || '');
      if (!isValidRequiredTabName(tabParam)) {
        res.status(400).json({ error: `Unsupported sheet tab "${tabParam}".` });
        return;
      }

      const employeeWritable =
        tabParam === 'Borrower_Assessments' || tabParam === 'Matching_Results';
      const authCtx = employeeWritable
        ? await resolveCurrentUser(req)
        : await requireAdminIfWorkspaceActive(req, res);

      if (!authCtx || !authCtx.sheetsClient) {
        if (!res.headersSent) {
          res.status(401).json({
            error: 'Google Sheets authentication required to write rows.',
          });
        }
        return;
      }
      if (!db.workspaceConfig.spreadsheetId) {
        res.status(400).json({ error: 'No Google Spreadsheet is connected yet.' });
        return;
      }

      const recordObj = (req.body.record || {}) as Record<string, unknown>;
      const canonicalHeaders = SHEET_HEADERS[tabParam];
      const primaryKeyHeader = canonicalHeaders[0];
      const primaryId = String(
        req.body.id || recordObj[primaryKeyHeader] || ''
      ).trim();

      const serializedRow = canonicalHeaders.map((col, idx) => {
        if (idx === 0 && primaryId) return primaryId;
        const val = recordObj[col];
        if (val === undefined || val === null) return '';
        return typeof val === 'object' ? JSON.stringify(val) : String(val);
      });

      const mode = primaryId
        ? await authCtx.sheetsClient.upsertRowByPrimaryId(
            db.workspaceConfig.spreadsheetId,
            tabParam,
            primaryId,
            serializedRow
          )
        : (await authCtx.sheetsClient.appendRow(
            db.workspaceConfig.spreadsheetId,
            tabParam,
            serializedRow
          ),
          'appended');

      res.json({ success: true, operation: mode, tabName: tabParam });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to write row to Google Sheet.',
      });
    }
  });

  app.delete(
    '/api/sheets/:tabName/rows/:rowId',
    async (req: Request, res: Response) => {
      try {
        const tabParam = String(req.params.tabName || '');
        const rowId = String(req.params.rowId || '').trim();
        if (!isValidRequiredTabName(tabParam) || !rowId) {
          res.status(400).json({ error: 'Valid sheet tab and rowId are required.' });
          return;
        }

        const authCtx = await requireAdminIfWorkspaceActive(req, res);
        if (!authCtx || !authCtx.sheetsClient) {
          if (!res.headersSent) {
            res.status(401).json({
              error: 'Admin Google Sheets authentication required to delete rows.',
            });
          }
          return;
        }
        if (!db.workspaceConfig.spreadsheetId) {
          res.status(400).json({ error: 'No Google Spreadsheet is connected yet.' });
          return;
        }

        const deleted = await authCtx.sheetsClient.deleteRowByPrimaryId(
          db.workspaceConfig.spreadsheetId,
          tabParam,
          rowId
        );
        res.json({ success: deleted, tabName: tabParam, rowId });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to delete row from Google Sheet.',
        });
      }
    }
  );

  // --- Google Workspace Auth & Sheets/Drive Connection Endpoints ---
  app.get('/api/workspace/me', async (req: Request, res: Response) => {
    try {
      const { user } = await resolveCurrentUser(req);
      res.json({ currentUser: user, workspaceConfig: db.workspaceConfig });
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Authentication check failed.',
      });
    }
  });

  app.post('/api/workspace/sheets/create', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx || !authCtx.sheetsClient || !authCtx.user) {
        if (!res.headersSent) {
          res.status(401).json({
            error: 'Sign in with Google first to create a Master Spreadsheet.',
          });
        }
        return;
      }

      const title =
        (req.body.title || '').trim() || 'LoanBazaar – AI Product Matching Master';
      const created = await authCtx.sheetsClient.createMasterWorkbook(title);

      const adminList = Array.from(
        new Set([...db.workspaceConfig.adminEmails, authCtx.user.email])
      );

      db.workspaceConfig = {
        ...db.workspaceConfig,
        spreadsheetId: created.spreadsheetId,
        spreadsheetTitle: created.spreadsheetTitle,
        spreadsheetUrl: created.spreadsheetUrl,
        adminEmails: adminList,
        connectedByEmail: authCtx.user.email,
        lastSyncedAt: new Date().toISOString(),
      };

      await authCtx.sheetsClient.syncCatalogAndRules(
        created.spreadsheetId,
        db.categories
      );
      if (db.assessments.length > 0) {
        await authCtx.sheetsClient.syncAssessments(
          created.spreadsheetId,
          db.assessments
        );
      }
      await recordPolicyLog(
        authCtx.sheetsClient,
        authCtx.user,
        'sheets_initialized',
        'workspace',
        created.spreadsheetId,
        `Created and connected 7-sheet Google Spreadsheet "${created.spreadsheetTitle}".`
      );

      saveDatabase(db);
      res.json({
        workspaceConfig: db.workspaceConfig,
        categories: db.categories,
        policyLogs: db.policyLogs,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to create Google Spreadsheet.',
      });
    }
  });

  app.post('/api/workspace/sheets/connect', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx || !authCtx.sheetsClient || !authCtx.user) {
        if (!res.headersSent) {
          res.status(401).json({
            error: 'Sign in with Google first to connect a Spreadsheet.',
          });
        }
        return;
      }

      const rawIdOrUrl = (req.body.spreadsheetIdOrUrl || '').trim();
      if (!rawIdOrUrl) {
        res.status(400).json({ error: 'Provide a Google Spreadsheet ID or URL.' });
        return;
      }

      const connected = await authCtx.sheetsClient.ensureRequiredSheetsAndHeaders(
        rawIdOrUrl
      );
      const liveData = await authCtx.sheetsClient.readAllWorkbookData(
        connected.spreadsheetId
      );

      const adminList = Array.from(
        new Set([...db.workspaceConfig.adminEmails, authCtx.user.email])
      );

      db.categories = liveData.categories;
      if (liveData.assessments.length > 0) {
        db.assessments = liveData.assessments;
      }
      db.documents = liveData.documents;
      db.policyLogs = liveData.policyLogs;
      db.workspaceConfig = {
        ...db.workspaceConfig,
        spreadsheetId: connected.spreadsheetId,
        spreadsheetTitle: connected.spreadsheetTitle,
        spreadsheetUrl: connected.spreadsheetUrl,
        adminEmails: adminList,
        connectedByEmail: authCtx.user.email,
        lastSyncedAt: new Date().toISOString(),
      };

      await recordPolicyLog(
        authCtx.sheetsClient,
        authCtx.user,
        'sheets_initialized',
        'workspace',
        connected.spreadsheetId,
        `Connected existing Google Spreadsheet "${connected.spreadsheetTitle}" and verified all 7 required tabs.`
      );

      saveDatabase(db);
      res.json({
        workspaceConfig: db.workspaceConfig,
        categories: db.categories,
        fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
        assessments: db.assessments,
        documents: db.documents,
        policyLogs: db.policyLogs,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to connect Google Spreadsheet.',
      });
    }
  });

  app.post('/api/workspace/sheets/sync', async (req: Request, res: Response) => {
    try {
      const { sheetsClient } = await resolveCurrentUser(req);
      if (!sheetsClient) {
        res.status(401).json({
          error:
            'Sign in with Google or configure a Service Account to sync from Google Sheets.',
        });
        return;
      }
      if (!db.workspaceConfig.spreadsheetId) {
        res.status(400).json({ error: 'No Google Spreadsheet is connected yet.' });
        return;
      }

      const liveData = await sheetsClient.readAllWorkbookData(
        db.workspaceConfig.spreadsheetId
      );
      db.categories = liveData.categories;
      db.assessments = liveData.assessments;
      db.documents = liveData.documents;
      db.policyLogs = liveData.policyLogs;
      db.workspaceConfig.lastSyncedAt = new Date().toISOString();
      saveDatabase(db);

      res.json({
        categories: db.categories,
        fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
        assessments: db.assessments,
        documents: db.documents,
        policyLogs: db.policyLogs,
        workspaceConfig: db.workspaceConfig,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to sync from Google Sheets.',
      });
    }
  });

  // --- Google Drive Folder, Spreadsheets & PDF Browser / Upload Endpoints ---
  app.get('/api/workspace/drive/spreadsheets', async (req: Request, res: Response) => {
    try {
      const { effectiveDriveToken } = await resolveCurrentUser(req);
      if (!effectiveDriveToken) {
        res.status(401).json({
          error: 'Sign in with Google to browse Drive spreadsheets.',
        });
        return;
      }
      const q = String(req.query.q || '');
      const files = await listDriveFilesByMime(
        effectiveDriveToken,
        'application/vnd.google-apps.spreadsheet',
        q
      );
      res.json({ files });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to list spreadsheets from Drive.',
      });
    }
  });

  app.get('/api/workspace/drive/pdfs', async (req: Request, res: Response) => {
    try {
      const { effectiveDriveToken } = await resolveCurrentUser(req);
      if (!effectiveDriveToken) {
        res.status(401).json({ error: 'Sign in with Google to browse Drive PDFs.' });
        return;
      }
      const q = String(req.query.q || '');
      const onlyFolder =
        req.query.folderOnly === 'true' ? db.workspaceConfig.driveFolderId : '';
      const files = await listDriveFilesByMime(
        effectiveDriveToken,
        'application/pdf',
        q,
        onlyFolder
      );
      res.json({ files });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to list PDF files from Google Drive.',
      });
    }
  });

  app.post('/api/workspace/drive/folder', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx || !authCtx.effectiveDriveToken) {
        if (!res.headersSent) {
          res.status(401).json({
            error: 'Sign in with Google as Admin to create a Drive folder.',
          });
        }
        return;
      }
      const folderName =
        (req.body.folderName || '').trim() || 'LoanBazaar Product Study Materials';
      const created = await createLoanBazaarDriveFolder(
        authCtx.effectiveDriveToken,
        folderName
      );
      db.workspaceConfig = {
        ...db.workspaceConfig,
        driveFolderId: created.id,
        driveFolderName: created.name,
      };
      saveDatabase(db);
      res.json({ workspaceConfig: db.workspaceConfig, folder: created });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to create Google Drive folder.',
      });
    }
  });

  // Read-only scan of the user's Google Drive "study material" folder (discovers all 19 product folders & PDFs)
  app.get(
    '/api/workspace/drive/scan-study-material',
    async (req: Request, res: Response) => {
      try {
        const authCtx = await resolveCurrentUser(req);
        if (!authCtx.effectiveDriveToken) {
          res.status(401).json({
            error:
              'Sign in with Google to scan your "study material" folder in Google Drive.',
          });
          return;
        }
        const folderQuery =
          typeof req.query.folder === 'string' && req.query.folder.trim()
            ? req.query.folder.trim()
            : 'study material';

        const scanResult = await scanGoogleDriveStudyMaterialFolder(
          authCtx.effectiveDriveToken,
          folderQuery
        );
        res.json(scanResult);
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to scan "study material" folder in Google Drive.',
        });
      }
    }
  );

  // Imports all 19 product folders & all PDFs inside Google Drive "study material" into Dashboard + Google Sheets
  app.post(
    '/api/workspace/drive/import-study-material',
    async (req: Request, res: Response) => {
      try {
        const authCtx = await requireAdminIfWorkspaceActive(req, res);
        if (!authCtx || !authCtx.effectiveDriveToken || !authCtx.user) {
          if (!res.headersSent) {
            res.status(401).json({
              error:
                'Sign in with Google as Admin to import the "study material" folder from Google Drive.',
            });
          }
          return;
        }

        const folderQueryOrId =
          (typeof req.body?.folderId === 'string' && req.body.folderId.trim()) ||
          (typeof req.body?.folderQuery === 'string' &&
            req.body.folderQuery.trim()) ||
          'study material';

        const scanResult = await scanGoogleDriveStudyMaterialFolder(
          authCtx.effectiveDriveToken,
          folderQueryOrId
        );

        if (!scanResult.found || !scanResult.rootFolder) {
          res.status(404).json({
            error: `Could not find a folder matching "${folderQueryOrId}" in your Google Drive.`,
            scan: scanResult,
          });
          return;
        }

        if (scanResult.productFolders.length === 0) {
          res.status(400).json({
            error: `Folder "${scanResult.rootFolder.name}" was found in Google Drive, but it contains 0 product subfolders.`,
            scan: scanResult,
          });
          return;
        }

        const nowIso = new Date().toISOString();

        // Index any previously extracted/verified documents & sub-products so re-syncing never loses verified rules
        const prevDocByDriveId = new Map<string, ProductDocumentRecord>();
        for (const d of db.documents) {
          if (d.driveFileId && !prevDocByDriveId.has(d.driveFileId)) {
            prevDocByDriveId.set(d.driveFileId, d);
          }
        }

        const prevSubByDriveId = new Map<string, SubProduct>();
        const prevCatByCleanName = new Map<string, ProductCategory>();
        for (const c of db.categories) {
          if (c.name.trim()) {
            prevCatByCleanName.set(c.name.trim().toLowerCase(), c);
          }
          for (const sp of c.subProducts) {
            for (const docId of sp.sourceDocumentIds || []) {
              const linkedDoc = db.documents.find((d) => d.id === docId);
              if (linkedDoc?.driveFileId) {
                prevSubByDriveId.set(linkedDoc.driveFileId, sp);
              }
            }
          }
        }

        const totalSlots = Math.max(19, scanResult.productFolders.length);
        const nextCategories: ProductCategory[] = [];
        const nextDocuments: ProductDocumentRecord[] = [];

        for (let i = 0; i < totalSlots; i++) {
          const slotNum = i + 1;
          const padded = String(slotNum).padStart(2, '0');
          const existingSlotCat = db.categories.find(
            (c) => c.slotNumber === slotNum
          );
          const catId = existingSlotCat?.id || `cat-${padded}`;
          const catCode = existingSlotCat?.code || `LB-CAT-${padded}`;
          const pf = scanResult.productFolders[i];

          if (!pf) {
            nextCategories.push({
              id: catId,
              slotNumber: slotNum,
              code: catCode,
              name: '',
              status: 'placeholder',
              description: '',
              studyMaterialStatus: 'pending_upload',
              studyMaterialRef: '',
              suitableBorrowerTypes: [],
              fundingPurposes: [],
              restrictionsAndExclusions: [],
              attributes: [],
              sourceDocumentIds: [],
              baselineRules: [],
              subProducts: [],
              isFictionalDemo: false,
              updatedAt: nowIso,
            });
            continue;
          }

          const prevCat = prevCatByCleanName.get(
            pf.cleanCategoryName.toLowerCase()
          );
          const catDocIds: string[] = [];
          const catSubProducts: SubProduct[] = [];

          pf.files.forEach((f, fIdx) => {
            const prevDoc = prevDocByDriveId.get(f.driveFileId);
            const prevSub = prevSubByDriveId.get(f.driveFileId);

            const docId =
              prevDoc?.id ||
              `doc-drv-${padded}-${String(fIdx + 1).padStart(2, '0')}-${f.driveFileId
                .slice(-5)
                .replace(/[^a-zA-Z0-9]/g, '')
                .toLowerCase()}`;

            const spId =
              prevSub?.id ||
              `sp-${padded}-${String(fIdx + 1).padStart(2, '0')}-${f.driveFileId
                .slice(-5)
                .replace(/[^a-zA-Z0-9]/g, '')
                .toLowerCase()}`;

            const docRecord: ProductDocumentRecord = {
              id: docId,
              driveFileId: f.driveFileId,
              fileName: f.fileName,
              mimeType: f.mimeType || 'application/pdf',
              webViewLink: f.webViewLink,
              categoryId: catId,
              subProductId: spId,
              extractionStatus:
                prevDoc?.extractionStatus === 'verified' ||
                prevDoc?.extractionStatus === 'extracted_draft'
                  ? prevDoc.extractionStatus
                  : 'uploaded',
              extractedDraft: prevDoc?.extractedDraft || null,
              uploadedBy: authCtx.user!.email,
              uploadedAt: prevDoc?.uploadedAt || f.modifiedTime || nowIso,
            };

            const subProduct: SubProduct = {
              id: spId,
              categoryId: catId,
              code: `${catCode}-SP-${String(fIdx + 1).padStart(2, '0')}`,
              name: f.cleanSubProductName,
              status: 'active',
              verificationStatus: prevSub?.verificationStatus || 'verified',
              description:
                prevSub?.description ||
                `Official ${pf.cleanCategoryName} sub-product imported from Google Drive study material (${f.fileName}).`,
              studyMaterialRef: f.fileName,
              suitableBorrowerTypes: prevSub?.suitableBorrowerTypes || [],
              fundingPurposes: prevSub?.fundingPurposes || [],
              financialRequirements: prevSub?.financialRequirements || [],
              collateralRequirements: prevSub?.collateralRequirements || [],
              requiredDocuments: prevSub?.requiredDocuments || [],
              restrictionsAndExclusions:
                prevSub?.restrictionsAndExclusions || [],
              sourceDocumentIds: [docId],
              attributes: prevSub?.attributes || [],
              baselineRules: (prevSub?.baselineRules || []).map((r) => ({
                ...r,
                categoryId: catId,
                subProductId: spId,
              })),
              isFictionalDemo: false,
              updatedAt: nowIso,
            };

            nextDocuments.push(docRecord);
            catDocIds.push(docId);
            catSubProducts.push(subProduct);
          });

          const hasVerifiedRules =
            (prevCat?.baselineRules || []).some(
              (r) => r.verificationStatus === 'verified'
            ) ||
            catSubProducts.some((sp) =>
              sp.baselineRules.some((r) => r.verificationStatus === 'verified')
            );
          const hasDraftRules =
            (prevCat?.baselineRules || []).some(
              (r) => r.verificationStatus === 'draft'
            ) ||
            catSubProducts.some((sp) =>
              sp.baselineRules.some((r) => r.verificationStatus === 'draft')
            );

          nextCategories.push({
            id: catId,
            slotNumber: slotNum,
            code: catCode,
            name: pf.cleanCategoryName,
            status: pf.files.length > 0 ? 'active' : 'placeholder',
            description:
              prevCat?.description ||
              `${pf.files.length} sub-product study material PDF(s) synced from Google Drive folder "${pf.folderName}".`,
            studyMaterialStatus: pf.files.length > 0 ? 'configured' : 'pending_upload',
            studyMaterialRef: pf.files[0]?.fileName || '',
            suitableBorrowerTypes: prevCat?.suitableBorrowerTypes || [],
            fundingPurposes: prevCat?.fundingPurposes || [],
            restrictionsAndExclusions: prevCat?.restrictionsAndExclusions || [],
            attributes: prevCat?.attributes || [],
            sourceDocumentIds: catDocIds,
            baselineRules: (prevCat?.baselineRules || []).map((r) => ({
              ...r,
              categoryId: catId,
            })),
            subProducts: catSubProducts,
            isFictionalDemo: false,
            updatedAt: nowIso,
          });
        }

        db.categories = nextCategories;
        db.documents = nextDocuments;
        db.workspaceConfig = {
          ...db.workspaceConfig,
          driveFolderId: scanResult.rootFolder.id,
          driveFolderName: scanResult.rootFolder.name,
        };
        saveDatabase(db);

        if (authCtx.sheetsClient) {
          if (!db.workspaceConfig.spreadsheetId) {
            const createdSheet = await authCtx.sheetsClient.createMasterWorkbook(
              'LoanBazaar – AI Product Matching Master'
            );
            db.workspaceConfig.spreadsheetId = createdSheet.spreadsheetId;
            db.workspaceConfig.spreadsheetTitle = createdSheet.spreadsheetTitle;
            db.workspaceConfig.spreadsheetUrl = createdSheet.spreadsheetUrl;
          }

          await authCtx.sheetsClient.syncCatalogAndRules(
            db.workspaceConfig.spreadsheetId,
            db.categories
          );
          await authCtx.sheetsClient.syncDocuments(
            db.workspaceConfig.spreadsheetId,
            db.documents
          );
          db.workspaceConfig.lastSyncedAt = nowIso;
        }

        await recordPolicyLog(
          authCtx.sheetsClient,
          authCtx.user,
          'product_updated',
          'workspace',
          scanResult.rootFolder.id,
          `Auto-imported ${scanResult.totalFolders} product folder(s) and ${scanResult.totalFiles} study material PDF(s) from Google Drive folder "${scanResult.rootFolder.name}" into Dashboard & Google Sheets.`
        );

        saveDatabase(db);

        res.json({
          scan: scanResult,
          categories: db.categories,
          fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
          documents: db.documents,
          policyLogs: db.policyLogs,
          workspaceConfig: db.workspaceConfig,
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to import "study material" folders from Google Drive.',
        });
      }
    }
  );

  app.put('/api/workspace/access', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx) return;

      const adminEmails = Array.isArray(req.body.adminEmails)
        ? req.body.adminEmails
            .map((e: string) => String(e).toLowerCase().trim())
            .filter(Boolean)
        : db.workspaceConfig.adminEmails;

      const employeeEmails = Array.isArray(req.body.employeeEmails)
        ? req.body.employeeEmails
            .map((e: string) => String(e).toLowerCase().trim())
            .filter(Boolean)
        : db.workspaceConfig.employeeEmails;

      if (!adminEmails.includes('viloanbazzar@gmail.com')) {
        adminEmails.push('viloanbazzar@gmail.com');
      }

      db.workspaceConfig = {
        ...db.workspaceConfig,
        adminEmails: Array.from(new Set(adminEmails)),
        employeeEmails: Array.from(new Set(employeeEmails)),
      };
      saveDatabase(db);
      res.json({ workspaceConfig: db.workspaceConfig });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to update access control list.',
      });
    }
  });

  // --- PDF Upload / Link & AI Extraction / Admin Verification ---
  app.post('/api/documents/upload', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx || !authCtx.effectiveDriveToken || !authCtx.user) {
        if (!res.headersSent) {
          res.status(401).json({
            error:
              'Sign in with Google as Admin to upload product PDFs to Google Drive.',
          });
        }
        return;
      }

      const {
        fileName,
        base64Pdf,
        mimeType = 'application/pdf',
        categoryId,
        subProductId = '',
        suggestedCategoryName = '',
        overwriteCategoryName = false,
        deferSheetsSync = false,
      } = req.body;
      if (!fileName || !base64Pdf || !categoryId) {
        res.status(400).json({
          error: 'fileName, base64Pdf, and target categoryId are required.',
        });
        return;
      }

      // Automatically provision the dedicated LoanBazaar Drive folder if not yet created
      if (!db.workspaceConfig.driveFolderId) {
        try {
          const createdFolder = await createLoanBazaarDriveFolder(
            authCtx.effectiveDriveToken,
            'LoanBazaar Product Study Materials'
          );
          db.workspaceConfig = {
            ...db.workspaceConfig,
            driveFolderId: createdFolder.id,
            driveFolderName: createdFolder.name,
          };
        } catch (folderErr) {
          console.warn('Auto-create Drive folder fallback to root:', folderErr);
        }
      }

      const resolvedMime =
        typeof mimeType === 'string' && mimeType.trim()
          ? mimeType.trim()
          : 'application/pdf';

      const uploaded = await uploadPdfToGoogleDrive(
        authCtx.effectiveDriveToken,
        fileName,
        base64Pdf,
        db.workspaceConfig.driveFolderId,
        resolvedMime
      );

      const docRecord: ProductDocumentRecord = {
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        driveFileId: uploaded.id,
        fileName: uploaded.name || fileName,
        mimeType: uploaded.mimeType || resolvedMime,
        webViewLink:
          uploaded.webViewLink ||
          `https://drive.google.com/file/d/${uploaded.id}/view`,
        categoryId,
        subProductId,
        extractionStatus: 'uploaded',
        extractedDraft: null,
        uploadedBy: authCtx.user.email,
        uploadedAt: new Date().toISOString(),
      };

      db.documents.unshift(docRecord);
      attachDocIdToProduct(db.categories, categoryId, subProductId, docRecord.id);

      const targetCatForMeta = db.categories.find((c) => c.id === categoryId);
      if (targetCatForMeta) {
        if (
          (Boolean(overwriteCategoryName) || !targetCatForMeta.name.trim()) &&
          typeof suggestedCategoryName === 'string' &&
          suggestedCategoryName.trim()
        ) {
          targetCatForMeta.name = suggestedCategoryName.trim();
        }
        if (targetCatForMeta.studyMaterialStatus === 'pending_upload') {
          targetCatForMeta.studyMaterialStatus = 'in_review';
        }
        if (!targetCatForMeta.studyMaterialRef) {
          targetCatForMeta.studyMaterialRef = docRecord.fileName;
        }
        targetCatForMeta.updatedAt = new Date().toISOString();
      }

      if (
        !deferSheetsSync &&
        authCtx.sheetsClient &&
        db.workspaceConfig.spreadsheetId
      ) {
        await authCtx.sheetsClient.upsertDocument(
          db.workspaceConfig.spreadsheetId,
          docRecord
        );
        const targetCat = db.categories.find((c) => c.id === categoryId);
        if (targetCat) {
          await authCtx.sheetsClient.upsertCategoryAndRules(
            db.workspaceConfig.spreadsheetId,
            targetCat
          );
          if (subProductId) {
            const targetSp = targetCat.subProducts.find(
              (s) => s.id === subProductId
            );
            if (targetSp) {
              await authCtx.sheetsClient.upsertSubProductAndRules(
                db.workspaceConfig.spreadsheetId,
                targetSp
              );
            }
          }
        }
      }

      await recordPolicyLog(
        deferSheetsSync ? null : authCtx.sheetsClient,
        authCtx.user,
        'pdf_uploaded',
        'document',
        docRecord.id,
        `Uploaded study material "${docRecord.fileName}" to Google Drive and linked to ${categoryId}.`
      );

      saveDatabase(db);
      res.status(201).json({
        document: docRecord,
        documents: db.documents,
        categories: db.categories,
        policyLogs: db.policyLogs,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'PDF upload to Google Drive failed.',
      });
    }
  });

  app.post('/api/documents/link-drive', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx || !authCtx.effectiveDriveToken || !authCtx.user) {
        if (!res.headersSent) {
          res.status(401).json({
            error:
              'Sign in with Google as Admin to link PDFs from Google Drive.',
          });
        }
        return;
      }

      const {
        driveFileId,
        fileName,
        webViewLink,
        categoryId,
        subProductId = '',
      } = req.body;

      if (!driveFileId || !categoryId) {
        res
          .status(400)
          .json({ error: 'driveFileId and categoryId are required.' });
        return;
      }

      const docRecord: ProductDocumentRecord = {
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        driveFileId,
        fileName: fileName || 'Linked Study Material.pdf',
        mimeType: 'application/pdf',
        webViewLink:
          webViewLink || `https://drive.google.com/file/d/${driveFileId}/view`,
        categoryId,
        subProductId,
        extractionStatus: 'uploaded',
        extractedDraft: null,
        uploadedBy: authCtx.user.email,
        uploadedAt: new Date().toISOString(),
      };

      db.documents.unshift(docRecord);
      attachDocIdToProduct(db.categories, categoryId, subProductId, docRecord.id);

      if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
        await authCtx.sheetsClient.upsertDocument(
          db.workspaceConfig.spreadsheetId,
          docRecord
        );
        const targetCat = db.categories.find((c) => c.id === categoryId);
        if (targetCat) {
          await authCtx.sheetsClient.upsertCategoryAndRules(
            db.workspaceConfig.spreadsheetId,
            targetCat
          );
          if (subProductId) {
            const targetSp = targetCat.subProducts.find(
              (s) => s.id === subProductId
            );
            if (targetSp) {
              await authCtx.sheetsClient.upsertSubProductAndRules(
                db.workspaceConfig.spreadsheetId,
                targetSp
              );
            }
          }
        }
      }

      await recordPolicyLog(
        authCtx.sheetsClient,
        authCtx.user,
        'pdf_linked',
        'document',
        docRecord.id,
        `Linked Google Drive PDF "${docRecord.fileName}" to ${categoryId}.`
      );

      saveDatabase(db);
      res.status(201).json({
        document: docRecord,
        documents: db.documents,
        categories: db.categories,
        policyLogs: db.policyLogs,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to link Drive PDF.',
      });
    }
  });

  // Run AI Policy Extraction on a linked Google Drive PDF and save as DRAFT in Google Sheets
  app.post(
    '/api/documents/:documentId/extract',
    async (req: Request, res: Response) => {
      try {
        const authCtx = await requireAdminIfWorkspaceActive(req, res);
        if (!authCtx || !authCtx.effectiveDriveToken || !authCtx.user) {
          if (!res.headersSent) {
            res.status(401).json({
              error:
                'Sign in with Google as Admin to extract rules from Google Drive PDFs.',
            });
          }
          return;
        }

        const { documentId } = req.params;
        const deferSheetsSync = Boolean(req.body?.deferSheetsSync);
        const docIdx = db.documents.findIndex((d) => d.id === documentId);
        if (docIdx === -1) {
          res.status(404).json({ error: 'Product document record not found.' });
          return;
        }

        const docRecord = db.documents[docIdx];
        const base64Pdf = await downloadDrivePdfAsBase64(
          authCtx.effectiveDriveToken,
          docRecord.driveFileId,
          docRecord.mimeType || 'application/pdf'
        );
        const extractedDraft = await extractPolicyDraftFromPdfBase64(
          base64Pdf,
          docRecord.fileName,
          docRecord.mimeType || 'application/pdf'
        );

        db.documents[docIdx] = {
          ...docRecord,
          extractionStatus: 'extracted_draft',
          extractedDraft,
        };

        let affectedSubProduct: SubProduct | undefined;
        const cat = db.categories.find((c) => c.id === docRecord.categoryId);
        if (cat) {
          if (!cat.name.trim() && extractedDraft.suggestedCategoryName.trim()) {
            cat.name = extractedDraft.suggestedCategoryName.trim();
          }
          if (cat.studyMaterialStatus === 'pending_upload') {
            cat.studyMaterialStatus = 'draft_extracted';
          }

          let targetSub: SubProduct | undefined = docRecord.subProductId
            ? cat.subProducts.find((s) => s.id === docRecord.subProductId)
            : undefined;

          if (!targetSub) {
            const nextNum = cat.subProducts.length + 1;
            const newSub: SubProduct = {
              id: `sp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              categoryId: cat.id,
              code: `${cat.code}-SP-${String(nextNum).padStart(2, '0')}`,
              name:
                extractedDraft.productName.trim() ||
                `Draft Extracted Product (${docRecord.fileName})`,
              status: 'placeholder',
              verificationStatus: 'draft',
              description: extractedDraft.productDescription,
              studyMaterialRef: docRecord.fileName,
              suitableBorrowerTypes: extractedDraft.suitableBorrowerTypes,
              fundingPurposes: extractedDraft.fundingPurposesAndUseCases,
              financialRequirements: extractedDraft.financialRequirements,
              collateralRequirements: extractedDraft.collateralRequirements,
              requiredDocuments: extractedDraft.requiredDocuments,
              restrictionsAndExclusions: extractedDraft.restrictionsAndExclusions,
              sourceDocumentIds: [docRecord.id],
              attributes: [],
              baselineRules: [],
              isFictionalDemo: false,
              updatedAt: new Date().toISOString(),
            };
            cat.subProducts.push(newSub);
            targetSub = newSub;
            db.documents[docIdx].subProductId = newSub.id;
          } else {
            if (!targetSub.description && extractedDraft.productDescription) {
              targetSub.description = extractedDraft.productDescription;
            }
            targetSub.suitableBorrowerTypes = Array.from(
              new Set([
                ...(targetSub.suitableBorrowerTypes || []),
                ...extractedDraft.suitableBorrowerTypes,
              ])
            );
            targetSub.fundingPurposes = Array.from(
              new Set([
                ...(targetSub.fundingPurposes || []),
                ...extractedDraft.fundingPurposesAndUseCases,
              ])
            );
            targetSub.financialRequirements = Array.from(
              new Set([
                ...(targetSub.financialRequirements || []),
                ...extractedDraft.financialRequirements,
              ])
            );
            targetSub.collateralRequirements = Array.from(
              new Set([
                ...(targetSub.collateralRequirements || []),
                ...extractedDraft.collateralRequirements,
              ])
            );
            targetSub.requiredDocuments = Array.from(
              new Set([
                ...(targetSub.requiredDocuments || []),
                ...extractedDraft.requiredDocuments,
              ])
            );
            targetSub.restrictionsAndExclusions = Array.from(
              new Set([
                ...(targetSub.restrictionsAndExclusions || []),
                ...extractedDraft.restrictionsAndExclusions,
              ])
            );
            targetSub.sourceDocumentIds = Array.from(
              new Set([...(targetSub.sourceDocumentIds || []), docRecord.id])
            );
          }

          const draftRules: ConfigurableRuleField[] =
            extractedDraft.structuredRules.map((cand, rIdx) => {
              let parsedVal: string | number | boolean = cand.expectedValue;
              if (
                cand.operator === 'number_min' ||
                cand.operator === 'number_max'
              ) {
                parsedVal =
                  Number(String(cand.expectedValue).replace(/[^0-9.-]/g, '')) || 0;
              } else if (cand.operator === 'boolean_equals') {
                parsedVal = String(cand.expectedValue).toLowerCase() === 'true';
              }
              return {
                id: `rule-ai-${Date.now()}-${rIdx}`,
                categoryId: cat.id,
                subProductId: targetSub!.id,
                stage: cand.stage || 'stage2_eligibility',
                targetField: cand.targetField || 'customAttribute',
                customKey: cand.customKey || '',
                label: cand.label,
                operator: cand.operator || 'text_equals',
                expectedValue: parsedVal,
                isMandatory: cand.isMandatory !== false,
                verificationStatus: 'draft',
                sourceDocId: docRecord.id,
                extractedByAi: true,
                notes: cand.notes || `Extracted from ${docRecord.fileName}`,
              };
            });

          targetSub.baselineRules = [
            ...targetSub.baselineRules.filter(
              (r) =>
                !(
                  r.sourceDocId === docRecord.id &&
                  r.verificationStatus === 'draft'
                )
            ),
            ...draftRules,
          ];
          targetSub.updatedAt = new Date().toISOString();
          affectedSubProduct = targetSub;
          cat.updatedAt = new Date().toISOString();
        }

        if (
          !deferSheetsSync &&
          authCtx.sheetsClient &&
          db.workspaceConfig.spreadsheetId
        ) {
          await authCtx.sheetsClient.upsertDocument(
            db.workspaceConfig.spreadsheetId,
            db.documents[docIdx]
          );
          if (cat) {
            await authCtx.sheetsClient.upsertCategoryAndRules(
              db.workspaceConfig.spreadsheetId,
              cat
            );
          }
          if (affectedSubProduct) {
            await authCtx.sheetsClient.upsertSubProductAndRules(
              db.workspaceConfig.spreadsheetId,
              affectedSubProduct
            );
          }
        }

        await recordPolicyLog(
          deferSheetsSync ? null : authCtx.sheetsClient,
          authCtx.user,
          'ai_draft_extracted',
          'document',
          docRecord.id,
          `Extracted ${extractedDraft.structuredRules.length} draft eligibility rules from "${docRecord.fileName}" awaiting Admin verification.`
        );

        saveDatabase(db);
        res.json({
          document: db.documents[docIdx],
          documents: db.documents,
          categories: db.categories,
          fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
          policyLogs: db.policyLogs,
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : 'Study material AI extraction failed.',
        });
      }
    }
  );

  // Atomic batch flush of all 19 Category Slots, Sub-Products, Draft Rules, and Documents to Google Sheets
  app.post(
    '/api/workspace/sheets/push-batch',
    async (req: Request, res: Response) => {
      try {
        const authCtx = await requireAdminIfWorkspaceActive(req, res);
        if (!authCtx) return;

        const slotCategoryNames: Array<{ categoryId: string; name: string }> =
          Array.isArray(req.body?.slotCategoryNames)
            ? req.body.slotCategoryNames
            : [];
        const summaryMessage =
          typeof req.body?.summary === 'string' && req.body.summary.trim()
            ? req.body.summary.trim()
            : 'Synchronized bulk 19-slot product archive import to Google Sheets.';

        const nowIso = new Date().toISOString();
        for (const entry of slotCategoryNames) {
          if (!entry?.categoryId || typeof entry.name !== 'string') continue;
          const trimmed = entry.name.trim();
          if (!trimmed) continue;
          const targetCat = db.categories.find((c) => c.id === entry.categoryId);
          if (targetCat && targetCat.name !== trimmed) {
            targetCat.name = trimmed;
            targetCat.updatedAt = nowIso;
          }
        }

        saveDatabase(db);

        if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
          await authCtx.sheetsClient.syncCatalogAndRules(
            db.workspaceConfig.spreadsheetId,
            db.categories
          );
          await authCtx.sheetsClient.syncDocuments(
            db.workspaceConfig.spreadsheetId,
            db.documents
          );
          db.workspaceConfig.lastSyncedAt = nowIso;
          await recordPolicyLog(
            authCtx.sheetsClient,
            authCtx.user,
            'product_updated',
            'workspace',
            db.workspaceConfig.spreadsheetId,
            summaryMessage
          );
          saveDatabase(db);
        }

        res.json({
          categories: db.categories,
          fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
          documents: db.documents,
          policyLogs: db.policyLogs,
          workspaceConfig: db.workspaceConfig,
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to batch sync catalog and documents to Google Sheets.',
        });
      }
    }
  );

  // Admin Rule Verification Endpoint (Approve / Reject Draft Rules & Activate Product)
  app.post('/api/admin/rules/verify', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx) return;

      const {
        categoryId,
        subProductId,
        ruleId,
        decision,
        updatedRule,
        activateProduct = true,
      } = req.body as {
        categoryId: string;
        subProductId?: string;
        ruleId?: string;
        decision: 'verified' | 'rejected';
        updatedRule?: Partial<ConfigurableRuleField>;
        activateProduct?: boolean;
      };

      const cat = db.categories.find((c) => c.id === categoryId);
      if (!cat) {
        res.status(404).json({ error: 'Category not found.' });
        return;
      }

      const actorEmail = authCtx.user?.email || 'admin@loanbazaar.internal';
      const now = new Date().toISOString();
      let verifiedCount = 0;

      const applyVerification = (rules: ConfigurableRuleField[]) =>
        rules.map((r) => {
          if (ruleId && r.id !== ruleId) return r;
          if (!ruleId && r.verificationStatus !== 'draft') return r;
          verifiedCount += 1;
          return {
            ...r,
            ...(updatedRule || {}),
            verificationStatus: decision,
            verifiedBy: actorEmail,
            verifiedAt: now,
          };
        });

      let targetSubRef: SubProduct | undefined;
      if (subProductId) {
        const sp = cat.subProducts.find((s) => s.id === subProductId);
        if (!sp) {
          res.status(404).json({ error: 'Sub-product not found.' });
          return;
        }
        sp.baselineRules = applyVerification(sp.baselineRules);
        if (decision === 'verified' && activateProduct) {
          sp.status = 'active';
          sp.verificationStatus = 'verified';
          cat.status = 'active';
          cat.studyMaterialStatus = 'configured';
        }
        sp.updatedAt = now;
        targetSubRef = sp;
      } else {
        cat.baselineRules = applyVerification(cat.baselineRules);
        if (decision === 'verified' && activateProduct) {
          cat.status = 'active';
          cat.studyMaterialStatus = 'configured';
        }
      }

      cat.updatedAt = now;

      const updatedDocs: ProductDocumentRecord[] = [];
      for (const doc of db.documents) {
        if (
          doc.categoryId === categoryId &&
          (!subProductId || doc.subProductId === subProductId) &&
          doc.extractionStatus === 'extracted_draft' &&
          decision === 'verified'
        ) {
          doc.extractionStatus = 'verified';
          updatedDocs.push(doc);
        }
      }

      if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
        await authCtx.sheetsClient.upsertCategoryAndRules(
          db.workspaceConfig.spreadsheetId,
          cat
        );
        if (targetSubRef) {
          await authCtx.sheetsClient.upsertSubProductAndRules(
            db.workspaceConfig.spreadsheetId,
            targetSubRef
          );
        }
        for (const uDoc of updatedDocs) {
          await authCtx.sheetsClient.upsertDocument(
            db.workspaceConfig.spreadsheetId,
            uDoc
          );
        }
      }

      await recordPolicyLog(
        authCtx.sheetsClient,
        authCtx.user,
        decision === 'verified' ? 'rule_verified' : 'rule_rejected',
        subProductId ? 'sub_product' : 'category',
        subProductId || categoryId,
        `${
          decision === 'verified' ? 'Verified and activated' : 'Rejected'
        } ${verifiedCount} rule(s) on ${cat.code}.`
      );

      saveDatabase(db);
      res.json({
        categories: db.categories,
        fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
        documents: db.documents,
        policyLogs: db.policyLogs,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to verify rule.',
      });
    }
  });

  // Bulk Verify & Activate All Pending Draft Rules across all 18 Categories
  app.post('/api/admin/rules/verify-all', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx) return;

      const actorEmail = authCtx.user?.email || 'admin@loanbazaar.internal';
      const now = new Date().toISOString();
      let totalVerifiedRules = 0;
      const touchedCategories: ProductCategory[] = [];
      const touchedSubProducts: SubProduct[] = [];
      const touchedDocs: ProductDocumentRecord[] = [];

      for (const cat of db.categories) {
        let catChanged = false;
        cat.baselineRules = cat.baselineRules.map((r) => {
          if (r.verificationStatus === 'draft') {
            totalVerifiedRules += 1;
            catChanged = true;
            return {
              ...r,
              verificationStatus: 'verified',
              verifiedBy: actorEmail,
              verifiedAt: now,
            };
          }
          return r;
        });

        for (const sp of cat.subProducts) {
          let spChanged = false;
          sp.baselineRules = sp.baselineRules.map((r) => {
            if (r.verificationStatus === 'draft') {
              totalVerifiedRules += 1;
              spChanged = true;
              return {
                ...r,
                verificationStatus: 'verified',
                verifiedBy: actorEmail,
                verifiedAt: now,
              };
            }
            return r;
          });
          if (spChanged || sp.verificationStatus === 'draft') {
            sp.status = 'active';
            sp.verificationStatus = 'verified';
            sp.updatedAt = now;
            cat.status = 'active';
            cat.studyMaterialStatus = 'configured';
            catChanged = true;
            touchedSubProducts.push(sp);
          }
        }

        if (catChanged) {
          cat.status = 'active';
          cat.studyMaterialStatus = 'configured';
          cat.updatedAt = now;
          touchedCategories.push(cat);
        }
      }

      for (const doc of db.documents) {
        if (doc.extractionStatus === 'extracted_draft') {
          doc.extractionStatus = 'verified';
          touchedDocs.push(doc);
        }
      }

      if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
        for (const cat of touchedCategories) {
          await authCtx.sheetsClient.upsertCategoryAndRules(
            db.workspaceConfig.spreadsheetId,
            cat
          );
        }
        for (const sp of touchedSubProducts) {
          await authCtx.sheetsClient.upsertSubProductAndRules(
            db.workspaceConfig.spreadsheetId,
            sp
          );
        }
        for (const doc of touchedDocs) {
          await authCtx.sheetsClient.upsertDocument(
            db.workspaceConfig.spreadsheetId,
            doc
          );
        }
      }

      await recordPolicyLog(
        authCtx.sheetsClient,
        authCtx.user,
        'rule_verified',
        'category',
        'all-draft-rules',
        `Bulk verified and activated ${totalVerifiedRules} draft rule(s) across ${touchedCategories.length} product category slot(s).`
      );

      saveDatabase(db);
      res.json({
        verifiedRulesCount: totalVerifiedRules,
        categories: db.categories,
        fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
        documents: db.documents,
        policyLogs: db.policyLogs,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to bulk verify draft rules.',
      });
    }
  });

  // --- Categories CRUD (Row-level Google Sheets Upsert) ---
  app.get('/api/categories', (_req: Request, res: Response) => {
    res.json({
      categories: db.categories,
      fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
    });
  });

  app.post('/api/categories', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx) return;

      if (db.settings.strict18CategorySlots && db.categories.length >= 19) {
        res.status(400).json({
          error:
            'Strict 19 Main Category Slots governance is enabled in Settings.',
        });
        return;
      }

      const nextSlot =
        db.categories.reduce((max, c) => Math.max(max, c.slotNumber), 0) + 1;
      const padded = String(nextSlot).padStart(2, '0');
      const now = new Date().toISOString();

      const newCategory: ProductCategory = {
        id: `cat-${padded}-${Date.now()}`,
        slotNumber: nextSlot,
        code: req.body.code?.trim() || `LB-CAT-${padded}`,
        name: req.body.name?.trim() || '',
        status: req.body.status || 'placeholder',
        description: req.body.description?.trim() || '',
        studyMaterialStatus: req.body.studyMaterialStatus || 'pending_upload',
        studyMaterialRef: req.body.studyMaterialRef?.trim() || '',
        suitableBorrowerTypes: req.body.suitableBorrowerTypes || [],
        fundingPurposes: req.body.fundingPurposes || [],
        restrictionsAndExclusions: req.body.restrictionsAndExclusions || [],
        sourceDocumentIds: [],
        attributes: Array.isArray(req.body.attributes) ? req.body.attributes : [],
        baselineRules: Array.isArray(req.body.baselineRules)
          ? req.body.baselineRules
          : [],
        subProducts: [],
        isFictionalDemo: false,
        updatedAt: now,
      };

      db.categories.push(newCategory);
      if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
        await authCtx.sheetsClient.upsertCategoryAndRules(
          db.workspaceConfig.spreadsheetId,
          newCategory
        );
      }
      saveDatabase(db);
      res.status(201).json({ category: newCategory });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to create category.',
      });
    }
  });

  app.put('/api/categories/:categoryId', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx) return;

      const { categoryId } = req.params;
      const idx = db.categories.findIndex((c) => c.id === categoryId);
      if (idx === -1) {
        res.status(404).json({ error: 'Product category slot not found.' });
        return;
      }

      const existing = db.categories[idx];
      const updated: ProductCategory = {
        ...existing,
        code:
          typeof req.body.code === 'string' ? req.body.code.trim() : existing.code,
        name: typeof req.body.name === 'string' ? req.body.name : existing.name,
        status: req.body.status ?? existing.status,
        description:
          typeof req.body.description === 'string'
            ? req.body.description
            : existing.description,
        studyMaterialStatus:
          req.body.studyMaterialStatus ?? existing.studyMaterialStatus,
        studyMaterialRef:
          typeof req.body.studyMaterialRef === 'string'
            ? req.body.studyMaterialRef
            : existing.studyMaterialRef,
        suitableBorrowerTypes: Array.isArray(req.body.suitableBorrowerTypes)
          ? req.body.suitableBorrowerTypes
          : existing.suitableBorrowerTypes,
        fundingPurposes: Array.isArray(req.body.fundingPurposes)
          ? req.body.fundingPurposes
          : existing.fundingPurposes,
        restrictionsAndExclusions: Array.isArray(
          req.body.restrictionsAndExclusions
        )
          ? req.body.restrictionsAndExclusions
          : existing.restrictionsAndExclusions,
        attributes: Array.isArray(req.body.attributes)
          ? req.body.attributes
          : existing.attributes,
        baselineRules: Array.isArray(req.body.baselineRules)
          ? req.body.baselineRules
          : existing.baselineRules,
        updatedAt: new Date().toISOString(),
      };

      db.categories[idx] = updated;
      if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
        await authCtx.sheetsClient.upsertCategoryAndRules(
          db.workspaceConfig.spreadsheetId,
          updated
        );
      }

      await recordPolicyLog(
        authCtx.sheetsClient,
        authCtx.user,
        'product_updated',
        'category',
        updated.id,
        `Updated category slot ${updated.code} (${updated.name || 'Placeholder'}).`
      );

      saveDatabase(db);
      res.json({
        category: updated,
        fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
        policyLogs: db.policyLogs,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to save category.',
      });
    }
  });

  // --- Unlimited Sub-Products CRUD (Row-level Google Sheets Upsert/Delete) ---
  app.post(
    '/api/categories/:categoryId/sub-products',
    async (req: Request, res: Response) => {
      try {
        const authCtx = await requireAdminIfWorkspaceActive(req, res);
        if (!authCtx) return;

        const { categoryId } = req.params;
        const category = db.categories.find((c) => c.id === categoryId);
        if (!category) {
          res.status(404).json({ error: 'Parent product category not found.' });
          return;
        }

        const subIndex = category.subProducts.length + 1;
        const subCodeDefault = `${category.code}-SP-${String(subIndex).padStart(
          2,
          '0'
        )}`;
        const now = new Date().toISOString();

        const newSubProduct: SubProduct = {
          id: `sp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          categoryId: category.id,
          code: req.body.code?.trim() || subCodeDefault,
          name: req.body.name?.trim() || '',
          status: req.body.status || 'placeholder',
          verificationStatus: req.body.verificationStatus || 'verified',
          description: req.body.description?.trim() || '',
          studyMaterialRef: req.body.studyMaterialRef?.trim() || '',
          suitableBorrowerTypes: req.body.suitableBorrowerTypes || [],
          fundingPurposes: req.body.fundingPurposes || [],
          financialRequirements: req.body.financialRequirements || [],
          collateralRequirements: req.body.collateralRequirements || [],
          requiredDocuments: req.body.requiredDocuments || [],
          restrictionsAndExclusions: req.body.restrictionsAndExclusions || [],
          sourceDocumentIds: req.body.sourceDocumentIds || [],
          attributes: Array.isArray(req.body.attributes) ? req.body.attributes : [],
          baselineRules: Array.isArray(req.body.baselineRules)
            ? req.body.baselineRules
            : [],
          isFictionalDemo: false,
          updatedAt: now,
        };

        category.subProducts.push(newSubProduct);
        category.updatedAt = now;

        if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
          await authCtx.sheetsClient.upsertSubProductAndRules(
            db.workspaceConfig.spreadsheetId,
            newSubProduct
          );
        }

        saveDatabase(db);
        res.status(201).json({
          category,
          subProduct: newSubProduct,
          fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : 'Failed to create sub-product.',
        });
      }
    }
  );

  app.put(
    '/api/categories/:categoryId/sub-products/:subProductId',
    async (req: Request, res: Response) => {
      try {
        const authCtx = await requireAdminIfWorkspaceActive(req, res);
        if (!authCtx) return;

        const { categoryId, subProductId } = req.params;
        const category = db.categories.find((c) => c.id === categoryId);
        if (!category) {
          res.status(404).json({ error: 'Parent product category not found.' });
          return;
        }

        const spIdx = category.subProducts.findIndex(
          (s) => s.id === subProductId
        );
        if (spIdx === -1) {
          res.status(404).json({ error: 'Sub-product record not found.' });
          return;
        }

        const existing = category.subProducts[spIdx];
        const now = new Date().toISOString();
        const updatedSub: SubProduct = {
          ...existing,
          code:
            typeof req.body.code === 'string'
              ? req.body.code.trim()
              : existing.code,
          name: typeof req.body.name === 'string' ? req.body.name : existing.name,
          status: req.body.status ?? existing.status,
          verificationStatus:
            req.body.verificationStatus ?? existing.verificationStatus,
          description:
            typeof req.body.description === 'string'
              ? req.body.description
              : existing.description,
          studyMaterialRef:
            typeof req.body.studyMaterialRef === 'string'
              ? req.body.studyMaterialRef
              : existing.studyMaterialRef,
          suitableBorrowerTypes: Array.isArray(req.body.suitableBorrowerTypes)
            ? req.body.suitableBorrowerTypes
            : existing.suitableBorrowerTypes,
          fundingPurposes: Array.isArray(req.body.fundingPurposes)
            ? req.body.fundingPurposes
            : existing.fundingPurposes,
          financialRequirements: Array.isArray(req.body.financialRequirements)
            ? req.body.financialRequirements
            : existing.financialRequirements,
          collateralRequirements: Array.isArray(req.body.collateralRequirements)
            ? req.body.collateralRequirements
            : existing.collateralRequirements,
          requiredDocuments: Array.isArray(req.body.requiredDocuments)
            ? req.body.requiredDocuments
            : existing.requiredDocuments,
          restrictionsAndExclusions: Array.isArray(
            req.body.restrictionsAndExclusions
          )
            ? req.body.restrictionsAndExclusions
            : existing.restrictionsAndExclusions,
          attributes: Array.isArray(req.body.attributes)
            ? req.body.attributes
            : existing.attributes,
          baselineRules: Array.isArray(req.body.baselineRules)
            ? req.body.baselineRules
            : existing.baselineRules,
          updatedAt: now,
        };

        category.subProducts[spIdx] = updatedSub;
        category.updatedAt = now;

        if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
          await authCtx.sheetsClient.upsertSubProductAndRules(
            db.workspaceConfig.spreadsheetId,
            updatedSub
          );
        }

        await recordPolicyLog(
          authCtx.sheetsClient,
          authCtx.user,
          'product_updated',
          'sub_product',
          updatedSub.id,
          `Updated sub-product ${updatedSub.code} (${
            updatedSub.name || 'Unnamed'
          }).`
        );

        saveDatabase(db);
        res.json({
          category,
          subProduct: updatedSub,
          fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
          policyLogs: db.policyLogs,
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : 'Failed to update sub-product.',
        });
      }
    }
  );

  app.delete(
    '/api/categories/:categoryId/sub-products/:subProductId',
    async (req: Request, res: Response) => {
      try {
        const authCtx = await requireAdminIfWorkspaceActive(req, res);
        if (!authCtx) return;

        const { categoryId, subProductId } = req.params;
        const category = db.categories.find((c) => c.id === categoryId);
        if (!category) {
          res.status(404).json({ error: 'Parent product category not found.' });
          return;
        }

        category.subProducts = category.subProducts.filter(
          (s) => s.id !== subProductId
        );
        category.updatedAt = new Date().toISOString();

        if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
          await authCtx.sheetsClient.deleteSubProductAndRules(
            db.workspaceConfig.spreadsheetId,
            categoryId,
            subProductId
          );
        }

        saveDatabase(db);
        res.json({
          category,
          fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : 'Failed to delete sub-product.',
        });
      }
    }
  );

  // --- Admin Catalog Bulk Operations (Atomic Batch Overwrite) ---
  app.post('/api/admin/import-catalog', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx) return;

      const incoming = req.body.categories;
      if (!Array.isArray(incoming) || incoming.length === 0) {
        res.status(400).json({
          error:
            'Invalid catalog JSON payload: expected non-empty categories array.',
        });
        return;
      }
      if (db.settings.strict18CategorySlots && incoming.length !== 19) {
        res.status(400).json({
          error: `Strict 19-category slot mode is active, but imported payload contained ${incoming.length} categories.`,
        });
        return;
      }

      db.categories = incoming;
      if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
        await authCtx.sheetsClient.syncCatalogAndRules(
          db.workspaceConfig.spreadsheetId,
          db.categories
        );
      }
      saveDatabase(db);
      res.json({
        categories: db.categories,
        fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to import catalog JSON.',
      });
    }
  });

  app.post('/api/admin/reset-placeholders', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx) return;

      db.categories = createInitialEmptyCategories();
      if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
        await authCtx.sheetsClient.syncCatalogAndRules(
          db.workspaceConfig.spreadsheetId,
          db.categories
        );
      }
      saveDatabase(db);
      res.json({
        categories: db.categories,
        fictionalDemoCategories: getFictionalDemoCatalogOverlay(db.categories),
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to reset placeholders.',
      });
    }
  });

  // --- Borrower Assessments CRUD (Row-level Google Sheets Upsert/Delete) ---
  app.get('/api/assessments', (_req: Request, res: Response) => {
    res.json({ assessments: db.assessments });
  });

  app.post('/api/assessments', async (req: Request, res: Response) => {
    try {
      const { sheetsClient, user } = await resolveCurrentUser(req);
      const now = new Date().toISOString();
      const isDemo = Boolean(req.body.isFictionalDemo);
      const seq = 1001 + db.assessments.length;
      const referenceCode = isDemo ? `LB-DEMO-${seq}` : `LB-CASE-${seq}`;

      const rawLabel = (req.body.applicantLabel || '').trim();
      if (!rawLabel) {
        res
          .status(400)
          .json({ error: 'Company or applicant name is required.' });
        return;
      }

      const normalizedLabel =
        isDemo && !rawLabel.toUpperCase().includes('FICTIONAL')
          ? `[FICTIONAL DEMO] ${rawLabel}`
          : rawLabel;

      const newAssessment: BorrowerAssessment = {
        id: `asmt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        referenceCode,
        applicantLabel: normalizedLabel,
        entityType: req.body.entityType || 'private_limited',
        industrySector: (req.body.industrySector || '').trim(),
        businessVintageYears:
          req.body.businessVintageYears !== '' &&
          req.body.businessVintageYears != null
            ? Number(req.body.businessVintageYears)
            : null,
        creditScore:
          req.body.creditScore !== '' && req.body.creditScore != null
            ? Number(req.body.creditScore)
            : null,
        existingEmiObligations:
          req.body.existingEmiObligations !== '' &&
          req.body.existingEmiObligations != null
            ? Number(req.body.existingEmiObligations)
            : null,
        profitabilityStatus: req.body.profitabilityStatus || 'not_provided',
        gstTaxCompliant: req.body.gstTaxCompliant || 'not_provided',
        fundingPurpose: req.body.fundingPurpose || 'general_business',
        dynamicPurposeAnswers: req.body.dynamicPurposeAnswers || {},
        assignedOfficer:
          (req.body.assignedOfficer || '').trim() ||
          user?.displayName ||
          user?.email ||
          'Internal Desk Officer',
        branchOrDesk: (req.body.branchOrDesk || 'Central Advisory Desk').trim(),
        requestedAmount: Math.max(0, Number(req.body.requestedAmount) || 0),
        currency: (
          req.body.currency ||
          db.settings.defaultCurrency ||
          'INR'
        ).trim(),
        requestedTenureMonths: Math.max(
          1,
          Number(req.body.requestedTenureMonths) || 12
        ),
        annualTurnoverOrIncome: Math.max(
          0,
          Number(req.body.annualTurnoverOrIncome) || 0
        ),
        collateralAvailable: Boolean(req.body.collateralAvailable),
        collateralType: (req.body.collateralType || '').trim(),
        collateralValue:
          req.body.collateralValue !== '' && req.body.collateralValue != null
            ? Number(req.body.collateralValue)
            : null,
        collateralDescription: (req.body.collateralDescription || '').trim(),
        statedPurpose: (req.body.statedPurpose || '').trim(),
        advisorNotes: (req.body.advisorNotes || '').trim(),
        customAttributes: Array.isArray(req.body.customAttributes)
          ? req.body.customAttributes
          : [],
        status: req.body.status === 'draft' ? 'draft' : 'submitted',
        isFictionalDemo: isDemo,
        createdAt: now,
        updatedAt: now,
        latestEvaluation: null,
      };

      db.assessments.unshift(newAssessment);
      if (sheetsClient && db.workspaceConfig.spreadsheetId) {
        await sheetsClient.upsertAssessment(
          db.workspaceConfig.spreadsheetId,
          newAssessment
        );
      }
      saveDatabase(db);
      res.status(201).json({ assessment: newAssessment });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to save borrower assessment.',
      });
    }
  });

  app.put('/api/assessments/:assessmentId', async (req: Request, res: Response) => {
    try {
      const { sheetsClient } = await resolveCurrentUser(req);
      const { assessmentId } = req.params;
      const idx = db.assessments.findIndex((a) => a.id === assessmentId);
      if (idx === -1) {
        res.status(404).json({ error: 'Borrower assessment record not found.' });
        return;
      }

      const existing = db.assessments[idx];
      const updated: BorrowerAssessment = {
        ...existing,
        ...req.body,
        id: existing.id,
        referenceCode: existing.referenceCode,
        updatedAt: new Date().toISOString(),
      };

      db.assessments[idx] = updated;
      if (sheetsClient && db.workspaceConfig.spreadsheetId) {
        await sheetsClient.upsertAssessment(
          db.workspaceConfig.spreadsheetId,
          updated
        );
      }
      saveDatabase(db);
      res.json({ assessment: updated });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to update assessment.',
      });
    }
  });

  app.delete(
    '/api/assessments/:assessmentId',
    async (req: Request, res: Response) => {
      try {
        const authCtx = await requireAdminIfWorkspaceActive(req, res);
        if (!authCtx) return;

        const { assessmentId } = req.params;
        db.assessments = db.assessments.filter((a) => a.id !== assessmentId);
        if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
          await authCtx.sheetsClient.deleteAssessment(
            db.workspaceConfig.spreadsheetId,
            assessmentId
          );
        }
        saveDatabase(db);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : 'Failed to delete assessment.',
        });
      }
    }
  );

  app.post(
    '/api/admin/reset-demo-assessments',
    async (req: Request, res: Response) => {
      try {
        const authCtx = await requireAdminIfWorkspaceActive(req, res);
        if (!authCtx) return;

        const nonDemo = db.assessments.filter((a) => !a.isFictionalDemo);
        db.assessments = [...createInitialFictionalAssessments(), ...nonDemo];
        if (authCtx.sheetsClient && db.workspaceConfig.spreadsheetId) {
          await authCtx.sheetsClient.syncAssessments(
            db.workspaceConfig.spreadsheetId,
            db.assessments
          );
        }
        saveDatabase(db);
        res.json({ assessments: db.assessments });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to restore demo records.',
        });
      }
    }
  );

  // --- Two-Stage Product Matching Pipeline ---
  app.post(
    '/api/assessments/:assessmentId/evaluate',
    async (req: Request, res: Response) => {
      try {
        const { assessmentId } = req.params;
        const idx = db.assessments.findIndex((a) => a.id === assessmentId);
        if (idx === -1) {
          res.status(404).json({ error: 'Borrower assessment not found.' });
          return;
        }

        const evaluation = evaluateLocalStudyMaterialMatch(db.assessments[idx]);

        db.assessments[idx] = {
          ...db.assessments[idx],
          status: 'evaluated',
          updatedAt: new Date().toISOString(),
          latestEvaluation: evaluation,
        };

        saveDatabase(db);
        res.json({
          assessment: db.assessments[idx],
          evaluation,
          categories: localStudyMaterialCatalog,
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : 'Two-stage matching failed.',
        });
      }
    }
  );

  // --- Separated AI Advisory Explanation Endpoint ---
  app.post(
    '/api/assessments/:assessmentId/explain',
    async (req: Request, res: Response) => {
      try {
        if (!db.settings.enableAiExplanationService) {
          res.status(400).json({
            error:
              'AI Advisory Explanation service is currently disabled in System Settings.',
          });
          return;
        }

        const { assessmentId } = req.params;
        const idx = db.assessments.findIndex((a) => a.id === assessmentId);
        if (idx === -1) {
          res.status(404).json({ error: 'Borrower assessment not found.' });
          return;
        }

        const assessment = db.assessments[idx];
        if (!assessment.latestEvaluation) {
          res.status(400).json({
            error:
              'Run Two-Stage Product Matching first before generating an AI explanation.',
          });
          return;
        }

        const explanation = await generateSeparatedAdvisoryExplanation(
          assessment,
          assessment.latestEvaluation
        );

        const updatedEvaluation = {
          ...assessment.latestEvaluation,
          aiExplanation: explanation,
        };

        db.assessments[idx] = {
          ...assessment,
          updatedAt: new Date().toISOString(),
          latestEvaluation: updatedEvaluation,
        };

        saveDatabase(db);
        res.json({
          assessment: db.assessments[idx],
          aiExplanation: explanation,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to generate AI advisory explanation on the server.';
        res.status(500).json({ error: message });
      }
    }
  );

  // --- System Settings ---
  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json({ settings: db.settings, workspaceConfig: db.workspaceConfig });
  });

  app.put('/api/settings', async (req: Request, res: Response) => {
    try {
      const authCtx = await requireAdminIfWorkspaceActive(req, res);
      if (!authCtx) return;

      const nextSettings: SystemSettings = {
        ...db.settings,
        ...req.body,
        updatedAt: new Date().toISOString(),
      };
      db.settings = nextSettings;
      saveDatabase(db);
      res.json({ settings: db.settings });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to update settings.',
      });
    }
  });

  // --- Frontend Mounting ---
  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.resolve(process.cwd(), 'dist');

  if (!isProd || !fs.existsSync(distPath)) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LoanBazaar server listening on http://0.0.0.0:${PORT}`);
  });
}

function attachDocIdToProduct(
  categories: ProductCategory[],
  categoryId: string,
  subProductId: string,
  docId: string
) {
  const cat = categories.find((c) => c.id === categoryId);
  if (!cat) return;
  if (subProductId) {
    const sp = cat.subProducts.find((s) => s.id === subProductId);
    if (sp) {
      sp.sourceDocumentIds = Array.from(
        new Set([...(sp.sourceDocumentIds || []), docId])
      );
      return;
    }
  }
  cat.sourceDocumentIds = Array.from(
    new Set([...(cat.sourceDocumentIds || []), docId])
  );
}

startServer().catch((err) => {
  console.error('Failed to start LoanBazaar server:', err);
  process.exit(1);
});
