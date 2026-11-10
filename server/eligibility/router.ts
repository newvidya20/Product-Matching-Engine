/**
 * Eligibility routes (docs/eligibility-contracts.md section 7). Mounted at /api/eligibility by server.ts.
 * No route calls an LLM. Error messages never contain input values. Logs carry ids, outcomes and codes only.
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  CRITERION_DEFINITIONS,
  ELIGIBILITY_RECORD_ID_PATTERN,
} from '../../src/types/eligibility.ts';
import type {
  ContinueEligibilityResponse,
  EligibilityAssessmentRecord,
  EligibilityErrorBody,
  EligibilityErrorCode,
  EligibilityInput,
  EligibilityInputSources,
  EligibilityRecordResponse,
  EligibilityRecordStatus,
  EligibilityRecordSummary,
  EligibilityResult,
  EligibilityResultSnapshot,
  EligibilityRulesResponse,
  EvaluateEligibilityResponse,
  ListEligibilityRecordsResponse,
} from '../../src/types/eligibility.ts';
import { DOCUMENT_SESSION_ID_PATTERN } from '../../src/types/documentAi.ts';
import type { FieldResult } from '../../src/types/documentAi.ts';
import type { BorrowerAssessment } from '../../src/types/domain.ts';
import { requireDocumentAuth } from '../documentAi/auth.ts';
import { findSessionByAssessment, loadSessionState } from '../documentAi/store.ts';
import { conditionRows, evaluateEligibility } from './engine.ts';
import { invalidInputSourceKeys, validateEligibilityInput } from './inputSchema.ts';
import { buildNewAssessmentPrefill, buildPrefill } from './prefill.ts';
import { canonicalJson, loadRules, seedRulesFile } from './rules.ts';
import type { LoadedRules } from './rules.ts';
import {
  StoreUnreadableError,
  getRecord,
  initRecordsStore,
  listRecords,
  mutateRecords,
  newRecordId,
  nextReferenceCode,
} from './store.ts';

export const MAX_PREVIOUS_RESULTS = 20;
const MAX_LABEL_LENGTH = 200;

export interface EligibilityRouterOptions {
  getAssessment: (assessmentId: string) => BorrowerAssessment | null | undefined;
  /** Defaults to Document AI's loadSessionState(id).fields. */
  loadSessionFields?: (sessionId: string) => Promise<Record<string, FieldResult> | null>;
  /** Defaults to Document AI's findSessionByAssessment(id).sessionId. */
  findSessionIdByAssessment?: (assessmentId: string) => Promise<string | null>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: EligibilityErrorCode,
    message: string,
    readonly fields?: string[]
  ) {
    super(message);
  }
}

function sendError(res: Response, status: number, code: EligibilityErrorCode, error: string, fields?: string[]): void {
  const body: EligibilityErrorBody = { error, code, ...(fields ? { fields } : {}) };
  res.status(status).json(body);
}

const invalid = (fields: string[]) => new HttpError(400, 'invalid_input', 'The request is not valid.', fields);

type Handler = (req: Request, res: Response) => Promise<void> | void;

const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err: unknown) => {
        if (res.headersSent) return next();
        if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message, err.fields);
        if (err instanceof StoreUnreadableError) {
          log('store_unreadable');
          return sendError(res, 500, 'internal_error', 'Eligibility records cannot be read.');
        }
        log('internal_error');
        return sendError(res, 500, 'internal_error', 'The eligibility check could not complete the request.');
      });
  };

function log(code: string, extra: Record<string, string | null> = {}): void {
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${v ?? '-'}`);
  console.info(`[eligibility] ${code}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The body as an object with only `allowed` keys. A missing body on {} routes reads as {}. */
function bodyOf(req: Request, allowed: readonly string[]): Record<string, unknown> {
  const body = req.body === undefined ? {} : req.body;
  if (!isObj(body)) throw invalid(['body']);
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw invalid(extra);
  return body;
}

function requireRules(loaded: LoadedRules): asserts loaded is LoadedRules & { ok: true } {
  if (!loaded.ok) {
    throw new HttpError(
      503,
      loaded.code,
      loaded.code === 'rules_unavailable' ? 'Eligibility rules are not available.' : 'Eligibility rules file is not valid.'
    );
  }
}

function recordId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !ELIGIBILITY_RECORD_ID_PATTERN.test(id)) {
    throw new HttpError(400, 'invalid_record_id', 'Record id is not valid.');
  }
  return id;
}

const snapshot = (r: EligibilityResult): EligibilityResultSnapshot => ({
  outcome: r.outcome,
  rulesVersion: r.rulesVersion,
  rulesHash: r.rulesHash,
  evaluatedAt: r.evaluatedAt,
  counts: { ...r.counts },
});

/** Replaces the result, keeping the old one as the newest snapshot (at most MAX_PREVIOUS_RESULTS). */
export function applyNewResult(record: EligibilityAssessmentRecord, result: EligibilityResult): void {
  record.previousResults = [snapshot(record.result), ...(record.previousResults || [])].slice(0, MAX_PREVIOUS_RESULTS);
  record.result = result;
  record.rulesVersion = result.rulesVersion;
}

/** The result without its timestamp, for "would re-evaluating change anything?". */
const comparable = (r: EligibilityResult) => canonicalJson({ ...r, evaluatedAt: null });

/**
 * Re-evaluates the stored input with the current rules. When the rules hash differs from the stored result's, or
 * the fresh result differs in any other way (an engine change), the fresh result replaces the stored one and the
 * old one goes to previousResults. Returns the fresh result and whether the record changed.
 */
export function refreshResult(rec: EligibilityAssessmentRecord, loaded: LoadedRules & { ok: true }, now: Date): { result: EligibilityResult; changed: boolean } {
  const fresh = evaluateEligibility(rec.input, loaded.rules, { rulesHash: loaded.rulesHash, now });
  const changed = rec.result.rulesHash !== fresh.rulesHash || comparable(rec.result) !== comparable(fresh);
  if (changed) {
    applyNewResult(rec, fresh);
    rec.updatedAt = now.toISOString();
  }
  return { result: fresh, changed };
}

const summary = (r: EligibilityAssessmentRecord): EligibilityRecordSummary => ({
  id: r.id,
  referenceCode: r.referenceCode,
  applicantLabel: r.applicantLabel,
  rulesVersion: r.rulesVersion,
  status: r.status,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  documentSessionId: r.documentSessionId,
  linkedAssessmentId: r.linkedAssessmentId,
  outcome: r.result.outcome,
  counts: r.result.counts,
});

// ---------------------------------------------------------------- field checks

interface FieldErrors {
  fields: string[];
}

function checkLabel(v: unknown, errs: FieldErrors): string | undefined {
  if (v === undefined) return undefined;
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > MAX_LABEL_LENGTH) {
    errs.fields.push('applicantLabel');
    return undefined;
  }
  return t;
}

function checkInput(v: unknown, errs: FieldErrors): EligibilityInput | undefined {
  if (v === undefined) return undefined;
  const r = validateEligibilityInput(v);
  if (!r.ok) {
    errs.fields.push(...r.fields);
    return undefined;
  }
  return r.input;
}

function checkSources(v: unknown, errs: FieldErrors): EligibilityInputSources | undefined {
  if (v === undefined) return undefined;
  const bad = invalidInputSourceKeys(v);
  if (bad === null) errs.fields.push('inputSources');
  else if (bad.length) errs.fields.push(...bad.map((k) => `inputSources.${k}`));
  else return v as EligibilityInputSources;
  return undefined;
}

function checkStatus(v: unknown, errs: FieldErrors): EligibilityRecordStatus | undefined {
  if (v === undefined) return undefined;
  if (v === 'draft' || v === 'final') return v;
  errs.fields.push('status');
  return undefined;
}

function checkSessionId(v: unknown, errs: FieldErrors): string | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v === 'string' && DOCUMENT_SESSION_ID_PATTERN.test(v)) return v;
  errs.fields.push('documentSessionId');
  return undefined;
}

function checkAssessmentIdShape(v: unknown, errs: FieldErrors, key = 'linkedAssessmentId'): string | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v === 'string' && v.trim() && v.length <= 200) return v;
  errs.fields.push(key);
  return undefined;
}

function checkCreatedBy(v: unknown, errs: FieldErrors): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > MAX_LABEL_LENGTH) {
    errs.fields.push('createdBy');
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return t || null;
}

// ---------------------------------------------------------------- router

export function createEligibilityRouter(options: EligibilityRouterOptions): express.Router {
  try {
    seedRulesFile();
  } catch {
    /* reported per request as rules_unavailable */
  }
  void initRecordsStore().catch(() => log('store_unreadable'));

  const loadSessionFields =
    options.loadSessionFields ?? (async (id: string) => (await loadSessionState(id))?.fields ?? null);
  const findSessionIdByAssessment =
    options.findSessionIdByAssessment ?? (async (id: string) => (await findSessionByAssessment(id))?.sessionId ?? null);
  const assessmentExists = (id: string) => Boolean(options.getAssessment(id));

  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  // Open: thresholds are not borrower data.
  router.get(
    '/rules',
    wrap((_req, res) => {
      const loaded = loadRules();
      requireRules(loaded);
      const body: EligibilityRulesResponse = {
        rules: loaded.rules,
        rulesHash: loaded.rulesHash,
        definitions: CRITERION_DEFINITIONS as EligibilityRulesResponse['definitions'],
      };
      res.json(body);
    })
  );

  router.use(requireDocumentAuth);

  // Stateless: stores and logs nothing.
  router.post(
    '/evaluate',
    wrap((req, res) => {
      const body = bodyOf(req, ['input']);
      const errs: FieldErrors = { fields: [] };
      const input = body.input === undefined ? (errs.fields.push('input'), undefined) : checkInput(body.input, errs);
      if (errs.fields.length || !input) throw invalid(errs.fields);
      const loaded = loadRules();
      requireRules(loaded);
      const out: EvaluateEligibilityResponse = {
        result: evaluateEligibility(input, loaded.rules, { rulesHash: loaded.rulesHash }),
      };
      res.json(out);
    })
  );

  router.post(
    '/prefill',
    wrap(async (req, res) => {
      const body = bodyOf(req, ['assessmentId', 'documentSessionId']);
      const errs: FieldErrors = { fields: [] };
      const assessmentId = checkAssessmentIdShape(body.assessmentId, errs, 'assessmentId');
      const sessionId = checkSessionId(body.documentSessionId, errs);
      if (errs.fields.length) throw invalid(errs.fields);
      if (!assessmentId && !sessionId) throw invalid(['assessmentId', 'documentSessionId']);
      let assessment: BorrowerAssessment | null = null;
      if (assessmentId) {
        assessment = options.getAssessment(assessmentId) ?? null;
        if (!assessment) throw new HttpError(404, 'assessment_not_found', 'Assessment not found.');
      }
      const useSession = sessionId || (assessmentId ? await findSessionIdByAssessment(assessmentId) : null);
      const sessionFields = useSession ? await loadSessionFields(useSession) : null;
      res.json(buildPrefill({ assessment, documentSessionId: useSession, sessionFields }));
    })
  );

  router.get(
    '/records',
    wrap(async (_req, res) => {
      const records = await listRecords();
      const out: ListEligibilityRecordsResponse = {
        records: [...records].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)).map(summary),
      };
      res.json(out);
    })
  );

  router.get(
    '/records/:id',
    wrap(async (req, res) => {
      const id = recordId(req);
      const record = await getRecord(id);
      if (!record) throw new HttpError(404, 'record_not_found', 'Record not found.');
      const out: EligibilityRecordResponse = { record };
      res.json(out);
    })
  );

  router.post(
    '/records',
    wrap(async (req, res) => {
      const body = bodyOf(req, [
        'applicantLabel',
        'input',
        'inputSources',
        'status',
        'documentSessionId',
        'linkedAssessmentId',
        'createdBy',
      ]);
      const errs: FieldErrors = { fields: [] };
      const applicantLabel = body.applicantLabel === undefined ? (errs.fields.push('applicantLabel'), undefined) : checkLabel(body.applicantLabel, errs);
      const input = body.input === undefined ? (errs.fields.push('input'), undefined) : checkInput(body.input, errs);
      const inputSources = checkSources(body.inputSources, errs) ?? {};
      const status = checkStatus(body.status, errs) ?? 'draft';
      const documentSessionId = checkSessionId(body.documentSessionId, errs) ?? null;
      const linkedAssessmentId = checkAssessmentIdShape(body.linkedAssessmentId, errs) ?? null;
      const createdBy = checkCreatedBy(body.createdBy, errs);
      if (errs.fields.length || !input || !applicantLabel) throw invalid(errs.fields);
      if (linkedAssessmentId && !assessmentExists(linkedAssessmentId)) {
        throw new HttpError(404, 'assessment_not_found', 'Assessment not found.');
      }
      const loaded = loadRules();
      requireRules(loaded);

      const record = await mutateRecords((records) => {
        const now = new Date();
        const result = evaluateEligibility(input, loaded.rules, { rulesHash: loaded.rulesHash, now });
        const iso = now.toISOString();
        const rec: EligibilityAssessmentRecord = {
          id: newRecordId(),
          referenceCode: nextReferenceCode(records),
          applicantLabel,
          input,
          inputSources,
          result,
          rulesVersion: result.rulesVersion,
          status,
          createdAt: iso,
          updatedAt: iso,
          finalizedAt: status === 'final' ? iso : null,
          documentSessionId,
          linkedAssessmentId,
          previousResults: [],
          createdBy,
          continuedAt: null,
        };
        records.push(rec);
        return { value: rec, write: true };
      });
      log('record_created', { id: record.id, outcome: record.result.outcome, status: record.status });
      const out: EligibilityRecordResponse = { record };
      res.status(201).json(out);
    })
  );

  router.put(
    '/records/:id',
    wrap(async (req, res) => {
      const id = recordId(req);
      const body = bodyOf(req, ['applicantLabel', 'input', 'inputSources', 'status', 'documentSessionId', 'linkedAssessmentId']);
      const errs: FieldErrors = { fields: [] };
      const applicantLabel = checkLabel(body.applicantLabel, errs);
      const input = checkInput(body.input, errs);
      const inputSources = checkSources(body.inputSources, errs);
      const status = checkStatus(body.status, errs);
      const documentSessionId = checkSessionId(body.documentSessionId, errs);
      const linkedAssessmentId = checkAssessmentIdShape(body.linkedAssessmentId, errs);
      if (errs.fields.length) throw invalid(errs.fields);
      const loaded = loadRules();

      const record = await mutateRecords((records) => {
        const rec = records.find((r) => r.id === id);
        if (!rec) throw new HttpError(404, 'record_not_found', 'Record not found.');
        if (linkedAssessmentId && !assessmentExists(linkedAssessmentId)) {
          throw new HttpError(404, 'assessment_not_found', 'Assessment not found.');
        }
        const now = new Date();
        const iso = now.toISOString();
        const others = Object.keys(body).filter((k) => k !== 'linkedAssessmentId');
        if (rec.status === 'final' && others.length) {
          throw new HttpError(409, 'record_final', 'A final record can only be linked to an assessment.');
        }
        // A link-only update (draft or final) is a pure link change: no re-evaluation, so it needs no rules file.
        // The continue gate re-evaluates on its own, so linking can never bypass it.
        if (rec.status === 'final' || (others.length === 0 && linkedAssessmentId !== undefined)) {
          if (linkedAssessmentId !== undefined) {
            rec.linkedAssessmentId = linkedAssessmentId;
            rec.updatedAt = iso;
          }
          return { value: rec, write: linkedAssessmentId !== undefined };
        }
        requireRules(loaded);
        if (applicantLabel !== undefined) rec.applicantLabel = applicantLabel;
        if (input !== undefined) rec.input = input;
        if (inputSources !== undefined) rec.inputSources = inputSources;
        if (documentSessionId !== undefined) rec.documentSessionId = documentSessionId;
        if (linkedAssessmentId !== undefined) rec.linkedAssessmentId = linkedAssessmentId;
        if (status === 'final') {
          rec.status = 'final';
          rec.finalizedAt = iso;
        }
        applyNewResult(rec, evaluateEligibility(rec.input, loaded.rules, { rulesHash: loaded.rulesHash, now }));
        rec.updatedAt = iso;
        return { value: rec, write: true };
      });
      log('record_updated', { id: record.id, outcome: record.result.outcome, status: record.status });
      const out: EligibilityRecordResponse = { record };
      res.json(out);
    })
  );

  router.post(
    '/records/:id/reassess',
    wrap(async (req, res) => {
      const id = recordId(req);
      bodyOf(req, []);
      const loaded = loadRules();
      const record = await mutateRecords((records) => {
        const rec = records.find((r) => r.id === id);
        if (!rec) throw new HttpError(404, 'record_not_found', 'Record not found.');
        requireRules(loaded);
        const now = new Date();
        applyNewResult(rec, evaluateEligibility(rec.input, loaded.rules, { rulesHash: loaded.rulesHash, now }));
        rec.updatedAt = now.toISOString();
        return { value: rec, write: true };
      });
      log('record_reassessed', { id: record.id, outcome: record.result.outcome, status: record.status });
      const out: EligibilityRecordResponse = { record };
      res.json(out);
    })
  );

  router.post(
    '/records/:id/continue',
    wrap(async (req, res) => {
      const id = recordId(req);
      bodyOf(req, []);
      const loaded = loadRules();
      type Outcome = { blocked: HttpError; refreshed: boolean } | { blocked: null; refreshed: boolean; body: ContinueEligibilityResponse };
      const out = await mutateRecords<Outcome>((records) => {
        const rec = records.find((r) => r.id === id);
        if (!rec) throw new HttpError(404, 'record_not_found', 'Record not found.');
        // The stored result is not trusted: the gate is decided on the stored input evaluated against the CURRENT
        // rules by the same engine. Without valid rules there is nothing to gate on, so this is a 503.
        requireRules(loaded);
        const now = new Date();
        const { result, changed } = refreshResult(rec, loaded, now);
        // The gate is here, not only in the UI: only ELIGIBLE and CONDITIONALLY_ELIGIBLE proceed.
        // There is no override workflow, so a blocked record stays blocked until it is reassessed.
        // TEMPORARY (requested): by default a finalized check may continue to New Assessment even when a mandatory
        // criterion failed or information is missing. Set ELIGIBILITY_ENFORCE_CONTINUE_GATE=true to restore the gate.
        const enforceGate = /^(1|true|yes)$/i.test(process.env.ELIGIBILITY_ENFORCE_CONTINUE_GATE ?? '');
        if (enforceGate && result.outcome === 'INCOMPLETE_DOCUMENTS') {
          const blocked = new HttpError(409, 'continue_blocked_incomplete', 'Cannot continue: required information is missing. Add the missing documents or values and reassess.');
          return { value: { blocked, refreshed: changed }, write: changed }; // keep the fresh result, then refuse
        }
        if (enforceGate && result.outcome === 'NOT_ELIGIBLE') {
          const blocked = new HttpError(409, 'continue_blocked_not_eligible', 'Cannot continue: the borrower does not meet a mandatory lender criterion.');
          return { value: { blocked, refreshed: changed }, write: changed };
        }
        rec.continuedAt = now.toISOString();
        const linked = rec.linkedAssessmentId && assessmentExists(rec.linkedAssessmentId) ? rec.linkedAssessmentId : null;
        return {
          value: {
            blocked: null,
            refreshed: changed,
            body: {
              record: rec,
              existingAssessmentId: linked,
              prefill: linked ? null : buildNewAssessmentPrefill(rec),
              conditions: conditionRows(result.criteria),
            },
          },
          write: true,
        };
      });
      if (out.blocked) {
        log('record_continue_blocked', { id, code: out.blocked.code, refreshed: out.refreshed ? 'yes' : 'no' });
        throw out.blocked;
      }
      const outcomeNow = out.body.record.result.outcome;
      log('record_continued', {
        id: out.body.record.id,
        code: out.body.existingAssessmentId ? 'existing_assessment' : 'prefill',
        gate_override: outcomeNow === 'ELIGIBLE' || outcomeNow === 'CONDITIONALLY_ELIGIBLE' ? 'no' : outcomeNow,
        refreshed: out.refreshed ? 'yes' : 'no',
      });
      res.json(out.body);
    })
  );

  return router;
}
