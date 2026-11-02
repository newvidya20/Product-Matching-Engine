/**
 * Document AI routes (docs/contracts.md section 7). Mounted at /api/document-ai by server.ts.
 * Error bodies never contain document content, values or provider error text.
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { getFieldDefinition } from '../../src/documentAi/fieldMap.ts';
import {
  DOCUMENT_AI_LIMITS,
  DOCUMENT_AI_RETENTION_RANGE,
  DOCUMENT_AI_THRESHOLDS,
  DOCUMENT_TYPES,
  FILE_KIND_EXTENSION,
  FILE_KIND_MIME,
} from '../../src/types/documentAi.ts';
import type {
  DeleteDocumentResponse,
  DocumentAiSettingsResponse,
  DocumentType,
  EditedFieldEntry,
  AppliedFieldEntry,
  StartExtractionRequest,
  UpdateDocumentRequest,
  UpdateDocumentAiSettingsRequest,
  UpdateEditsRequest,
  UploadDocumentRequest,
} from '../../src/types/documentAi.ts';
import { logActivity } from './activity.ts';
import { authStatus, createAuthSession, getActor, logout, requireDocumentAuth, sendError } from './auth.ts';
import { validateUpload } from './fileValidation.ts';
import { JobInProgressError, startExtraction } from './jobs.ts';
import { readSpreadsheetPreview } from './pipeline.ts';
import {
  addDocument,
  deleteDocumentFile,
  findSessionByAssessment,
  getDocument,
  getJob,
  getSession,
  getSettings,
  isDisabledByEnv,
  isDocumentId,
  isFeatureEnabled,
  isJobId,
  isSessionId,
  linkSessionToAssessment,
  listDocuments,
  loadSessionState,
  readFileBytes,
  sanitizeOriginalName,
  saveSettings,
  updateDocument,
  updateEdits,
} from './store.ts';

export interface DocumentAiRouterOptions {
  assessmentExists: (assessmentId: string) => boolean;
}

type Handler = (req: Request, res: Response) => Promise<void> | void;

const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'Document AI could not complete the request.');
      else next();
    });
  };

const MAX_BASE64_CHARS = Math.ceil((DOCUMENT_AI_LIMITS.maxFileBytes * 4) / 3) + 8;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function contentDisposition(kind: 'inline' | 'attachment', name: string, ext: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="document.${ext}"; filename*=UTF-8''${encoded}`;
}

export function createDocumentAiRouter(options: DocumentAiRouterOptions): express.Router {
  const router = express.Router();

  // Open endpoints (requireDocumentAuth lets these through).
  router.get('/auth/status', authStatus);
  router.post('/auth/session', createAuthSession);
  router.post('/auth/logout', logout);

  router.use(requireDocumentAuth);

  // Validate path params once. A malformed session ID is 400; others are 404.
  router.param('sessionId', (req, res, next, value) => {
    if (!isSessionId(value)) return sendError(res, 400, 'invalid_session_id', 'Invalid session ID.');
    next();
  });
  router.param('documentId', (req, res, next, value) => {
    if (!isDocumentId(value)) return sendError(res, 404, 'not_found', 'Document not found.');
    next();
  });
  router.param('jobId', (req, res, next, value) => {
    if (!isJobId(value)) return sendError(res, 404, 'not_found', 'Job not found.');
    next();
  });

  // ----------------------------------------------------------- settings
  async function settingsResponse(): Promise<DocumentAiSettingsResponse> {
    return {
      settings: await getSettings(),
      disabledByEnv: isDisabledByEnv(),
      llmConfigured: Boolean((process.env.GEMINI_API_KEY || '').trim()),
    };
  }

  router.get('/settings', wrap(async (_req, res) => {
    res.json(await settingsResponse());
  }));

  router.put('/settings', wrap(async (req, res) => {
    const actor = getActor(res);
    if (actor.role !== 'admin') return sendError(res, 403, 'forbidden', 'Only an admin can change Document AI settings.');
    const body = (req.body || {}) as UpdateDocumentAiSettingsRequest;
    const patch: UpdateDocumentAiSettingsRequest = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return sendError(res, 400, 'invalid_request', 'enabled must be true or false.');
      patch.enabled = body.enabled;
    }
    if (body.autoApplyThreshold !== undefined) {
      const t = body.autoApplyThreshold;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < DOCUMENT_AI_THRESHOLDS.minAutoApply || t > DOCUMENT_AI_THRESHOLDS.maxAutoApply) {
        return sendError(res, 400, 'invalid_request', 'autoApplyThreshold must be between 0.70 and 0.99.');
      }
      patch.autoApplyThreshold = Math.round(t * 100) / 100;
    }
    if (body.retentionDays !== undefined) {
      const d = body.retentionDays;
      if (!Number.isInteger(d) || d < DOCUMENT_AI_RETENTION_RANGE.min || d > DOCUMENT_AI_RETENTION_RANGE.max) {
        return sendError(res, 400, 'invalid_request', 'retentionDays must be a whole number from 1 to 365.');
      }
      patch.retentionDays = d;
    }
    await saveSettings(patch, actor.email);
    void logActivity({
      type: 'settings_changed',
      actor: actor.email,
      counts: {
        ...(patch.autoApplyThreshold !== undefined ? { autoApplyPercent: Math.round(patch.autoApplyThreshold * 100) } : {}),
        ...(patch.retentionDays !== undefined ? { retentionDays: patch.retentionDays } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
      },
    });
    res.json(await settingsResponse());
  }));

  // ----------------------------------------------------------- sessions
  router.get('/sessions', wrap(async (req, res) => {
    const assessmentId = typeof req.query.assessmentId === 'string' ? req.query.assessmentId : '';
    if (!assessmentId) return sendError(res, 400, 'invalid_request', 'assessmentId is required.');
    res.json({ session: await findSessionByAssessment(assessmentId) });
  }));

  router.get('/sessions/:sessionId', wrap(async (req, res) => {
    const state = await loadSessionState(req.params.sessionId);
    if (!state) return sendError(res, 404, 'not_found', 'Session not found.');
    res.json(state);
  }));

  router.post('/sessions/:sessionId/link', wrap(async (req, res) => {
    const actor = getActor(res);
    const assessmentId = typeof req.body?.assessmentId === 'string' ? req.body.assessmentId : '';
    if (!assessmentId) return sendError(res, 400, 'invalid_request', 'assessmentId is required.');
    if (!options.assessmentExists(assessmentId)) return sendError(res, 404, 'not_found', 'Assessment not found.');
    const result = await linkSessionToAssessment(req.params.sessionId, assessmentId);
    if (!result.ok) {
      if (result.reason === 'session_not_found') return sendError(res, 404, 'not_found', 'Session not found.');
      return sendError(res, 409, 'invalid_request', 'This session or assessment is already linked.');
    }
    if (result.changed) {
      void logActivity({ type: 'session_linked', actor: actor.email, sessionId: req.params.sessionId, assessmentId });
    }
    const state = await loadSessionState(req.params.sessionId);
    if (!state) return sendError(res, 404, 'not_found', 'Session not found.');
    res.json(state);
  }));

  // ---------------------------------------------------------- documents
  router.post('/sessions/:sessionId/documents', wrap(async (req, res) => {
    const actor = getActor(res);
    const { sessionId } = req.params;
    if (!(await isFeatureEnabled())) return sendError(res, 403, 'disabled', 'Document AI is turned off.');

    const body = (req.body || {}) as Partial<UploadDocumentRequest>;
    if (typeof body.fileName !== 'string' || !body.fileName.trim()) {
      return sendError(res, 400, 'invalid_request', 'fileName is required.');
    }
    if (typeof body.base64 !== 'string' || body.base64.length === 0) {
      return sendError(res, 400, 'invalid_request', 'base64 content is required.');
    }
    const originalName = sanitizeOriginalName(body.fileName);
    const reject = (status: number, code: Parameters<typeof sendError>[2], message: string, bytes = 0) => {
      void logActivity({
        type: 'file_rejected',
        actor: actor.email,
        sessionId,
        fileName: originalName,
        code,
        counts: { bytes },
      });
      sendError(res, status, code, message);
    };

    if (body.base64.length > MAX_BASE64_CHARS) {
      return reject(413, 'file_too_large', 'This file is larger than the 12 MB limit.');
    }
    if (body.base64.length % 4 !== 0 || !BASE64_PATTERN.test(body.base64)) {
      return sendError(res, 400, 'invalid_request', 'base64 content is not valid.');
    }
    const bytes = Buffer.from(body.base64, 'base64');
    if (bytes.byteLength === 0) return sendError(res, 400, 'invalid_request', 'The file is empty.');
    if (bytes.byteLength > DOCUMENT_AI_LIMITS.maxFileBytes) {
      return reject(413, 'file_too_large', 'This file is larger than the 12 MB limit.', bytes.byteLength);
    }

    const validation = await validateUpload(originalName, bytes);
    if (!validation.ok) {
      return reject(validation.status, validation.code, validation.message, bytes.byteLength);
    }

    const added = await addDocument({
      sessionId,
      actorEmail: actor.email,
      originalName,
      kind: validation.kind,
      mimeType: FILE_KIND_MIME[validation.kind],
      bytes,
    });
    if (!added.ok) return reject(added.status, added.code, added.message, bytes.byteLength);

    if (added.sessionCreated) {
      void logActivity({ type: 'session_created', actor: actor.email, sessionId });
    }
    if (!added.duplicate) {
      void logActivity({
        type: 'file_uploaded',
        actor: actor.email,
        sessionId,
        documentId: added.document.documentId,
        fileName: originalName,
        code: validation.kind,
        counts: { bytes: bytes.byteLength },
      });
    }
    res.status(201).json({ document: added.document, duplicate: added.duplicate });
  }));

  router.get('/sessions/:sessionId/documents', wrap(async (req, res) => {
    if (!(await getSession(req.params.sessionId))) return sendError(res, 404, 'not_found', 'Session not found.');
    res.json({ documents: await listDocuments(req.params.sessionId) });
  }));

  router.patch('/sessions/:sessionId/documents/:documentId', wrap(async (req, res) => {
    const actor = getActor(res);
    const { sessionId, documentId } = req.params;
    const documentType = (req.body as Partial<UpdateDocumentRequest> | undefined)?.documentType;
    if (typeof documentType !== 'string' || !(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
      return sendError(res, 400, 'invalid_request', 'documentType is not recognised.');
    }
    const updated = await updateDocument(sessionId, documentId, (d) => {
      d.documentType = documentType as DocumentType;
      d.documentTypeOverridden = true;
    });
    if (!updated) return sendError(res, 404, 'not_found', 'Document not found.');
    void logActivity({
      type: 'document_type_overridden',
      actor: actor.email,
      sessionId,
      documentId,
      fileName: updated.originalName,
      code: documentType,
    });
    res.json(await loadSessionState(sessionId));
  }));

  router.get('/sessions/:sessionId/documents/:documentId/file', wrap(async (req, res) => {
    const actor = getActor(res);
    const { sessionId, documentId } = req.params;
    const doc = await getDocument(sessionId, documentId);
    if (!doc) return sendError(res, 404, 'not_found', 'Document not found.');
    const bytes = await readFileBytes(doc);
    if (!bytes) return sendError(res, 404, 'file_missing', 'The file is no longer stored.');

    const canInline = doc.kind === 'pdf' || doc.kind === 'png' || doc.kind === 'jpeg' || doc.kind === 'webp';
    const inline = req.query.disposition === 'inline' && canInline;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Type', FILE_KIND_MIME[doc.kind]);
    res.setHeader('Content-Length', String(bytes.byteLength));
    res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', doc.originalName, FILE_KIND_EXTENSION[doc.kind]));
    if (inline) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; object-src 'self'; frame-ancestors 'self'"
      );
    }
    void logActivity({
      type: inline ? 'file_previewed' : 'file_downloaded',
      actor: actor.email,
      sessionId,
      documentId,
      fileName: doc.originalName,
    });
    res.status(200).end(bytes);
  }));

  router.get('/sessions/:sessionId/documents/:documentId/preview', wrap(async (req, res) => {
    const actor = getActor(res);
    const { sessionId, documentId } = req.params;
    const doc = await getDocument(sessionId, documentId);
    if (!doc) return sendError(res, 404, 'not_found', 'Document not found.');
    if (doc.kind !== 'xlsx' && doc.kind !== 'csv') {
      return sendError(res, 400, 'invalid_request', 'Preview is available for spreadsheets and CSV files only.');
    }
    const bytes = await readFileBytes(doc);
    if (!bytes) return sendError(res, 404, 'file_missing', 'The file is no longer stored.');
    const preview = await readSpreadsheetPreview(new Uint8Array(bytes), doc.kind);
    res.setHeader('Cache-Control', 'private, no-store');
    void logActivity({ type: 'file_previewed', actor: actor.email, sessionId, documentId, fileName: doc.originalName });
    res.json(preview);
  }));

  router.delete('/sessions/:sessionId/documents/:documentId', wrap(async (req, res) => {
    const actor = getActor(res);
    const { sessionId, documentId } = req.params;
    const mode = req.query.mode;
    if (mode !== 'file_only' && mode !== 'file_and_clear_fields') {
      return sendError(res, 400, 'invalid_request', 'mode must be file_only or file_and_clear_fields.');
    }
    const doc = await getDocument(sessionId, documentId);
    if (!doc) return sendError(res, 404, 'not_found', 'Document not found.');
    const outcome = await deleteDocumentFile(sessionId, documentId, mode);
    if (!outcome.found) return sendError(res, 404, 'not_found', 'Document not found.');
    void logActivity({
      type: 'file_deleted',
      actor: actor.email,
      sessionId,
      documentId,
      fileName: doc.originalName,
      code: mode,
    });
    if (outcome.clearFieldIds.length > 0) {
      void logActivity({
        type: 'fields_cleared',
        actor: actor.email,
        sessionId,
        documentId,
        code: mode,
        fieldIds: outcome.clearFieldIds,
      });
    }
    const state = await loadSessionState(sessionId);
    if (!state) return sendError(res, 404, 'not_found', 'Session not found.');
    const body: DeleteDocumentResponse = { clearFieldIds: outcome.clearFieldIds, state };
    res.json(body);
  }));

  // --------------------------------------------------------- extraction
  router.post('/sessions/:sessionId/extract', wrap(async (req, res) => {
    const actor = getActor(res);
    const { sessionId } = req.params;
    if (!(await isFeatureEnabled())) return sendError(res, 403, 'disabled', 'Document AI is turned off.');
    if (!(await getSession(sessionId))) return sendError(res, 404, 'not_found', 'Session not found.');
    const body = (req.body || {}) as StartExtractionRequest;
    const request: StartExtractionRequest = {};
    if (body.documentIds !== undefined) {
      if (!Array.isArray(body.documentIds) || !body.documentIds.every(isDocumentId)) {
        return sendError(res, 400, 'invalid_request', 'documentIds must be a list of document IDs.');
      }
      request.documentIds = body.documentIds;
    }
    if (body.force !== undefined) request.force = body.force === true;
    try {
      const job = await startExtraction(sessionId, request, actor);
      res.status(202).json({ job });
    } catch (err) {
      if (err instanceof JobInProgressError) {
        return sendError(res, 409, 'job_in_progress', 'An extraction is already running for this session.', { jobId: err.jobId });
      }
      throw err;
    }
  }));

  router.get('/sessions/:sessionId/jobs/:jobId', wrap(async (req, res) => {
    const job = await getJob(req.params.sessionId, req.params.jobId);
    if (!job || job.sessionId !== req.params.sessionId) return sendError(res, 404, 'not_found', 'Job not found.');
    res.json({ job });
  }));

  // -------------------------------------------------------------- edits
  router.put('/sessions/:sessionId/edits', wrap(async (req, res) => {
    const actor = getActor(res);
    const { sessionId } = req.params;
    if (!(await getSession(sessionId))) return sendError(res, 404, 'not_found', 'Session not found.');
    const body = (req.body || {}) as UpdateEditsRequest;
    const isIdList = (v: unknown): v is string[] =>
      Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && Boolean(getFieldDefinition(x)));
    const isEntryList = (v: unknown): v is Array<EditedFieldEntry | AppliedFieldEntry> =>
      Array.isArray(v) &&
      v.length <= 500 &&
      v.every((x) => x && typeof x.fieldId === 'string' && Boolean(getFieldDefinition(x.fieldId)));

    const patch: UpdateEditsRequest = {};
    if (body.clearEdited !== undefined) {
      if (!isIdList(body.clearEdited)) return sendError(res, 400, 'invalid_request', 'Unknown field ID in clearEdited.');
      patch.clearEdited = body.clearEdited;
    }
    if (body.clearApplied !== undefined) {
      if (!isIdList(body.clearApplied)) return sendError(res, 400, 'invalid_request', 'Unknown field ID in clearApplied.');
      patch.clearApplied = body.clearApplied;
    }
    const now = new Date().toISOString();
    if (body.setEdited !== undefined) {
      if (!isEntryList(body.setEdited)) return sendError(res, 400, 'invalid_request', 'Unknown field ID in setEdited.');
      const origins = ['typed', 'cleared', 'accepted_document_value', 'resolved_conflict', 'demo_sample', 'preexisting_value'];
      patch.setEdited = [];
      for (const e of body.setEdited as EditedFieldEntry[]) {
        if (!origins.includes(e.origin)) return sendError(res, 400, 'invalid_request', 'Unknown edit origin.');
        patch.setEdited.push({
          fieldId: e.fieldId,
          origin: e.origin,
          at: now,
          ...(typeof e.candidateId === 'string' ? { candidateId: e.candidateId.slice(0, 300) } : {}),
        });
      }
    }
    if (body.setApplied !== undefined) {
      if (!isEntryList(body.setApplied)) return sendError(res, 400, 'invalid_request', 'Unknown field ID in setApplied.');
      patch.setApplied = (body.setApplied as AppliedFieldEntry[]).map((a) => ({
        fieldId: a.fieldId,
        candidateId: typeof a.candidateId === 'string' ? a.candidateId.slice(0, 300) : '',
        at: now,
      }));
    }

    const edits = await updateEdits(sessionId, patch);

    const by = (origins: string[]) =>
      (patch.setEdited || []).filter((e) => origins.includes(e.origin)).map((e) => e.fieldId);
    const typed = by(['typed', 'cleared', 'demo_sample', 'preexisting_value']);
    const accepted = by(['accepted_document_value']);
    const resolved = by(['resolved_conflict']);
    if (typed.length) void logActivity({ type: 'field_edited', actor: actor.email, sessionId, fieldIds: typed });
    if (accepted.length) void logActivity({ type: 'field_accepted', actor: actor.email, sessionId, fieldIds: accepted });
    if (resolved.length) void logActivity({ type: 'conflict_resolved', actor: actor.email, sessionId, fieldIds: resolved });
    res.json(edits);
  }));

  // Anything else under this base is a 404 here and must not fall through to the SPA.
  router.use((_req, res) => sendError(res, 404, 'not_found', 'Not found.'));
  router.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) sendError(res, 400, 'invalid_request', 'The request could not be read.');
  });

  return router;
}
