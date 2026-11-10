/**
 * Eligibility API and record store. Contract: docs/eligibility-contracts.md sections 5.3, 7 and 8.
 * Runs against a temp data dir; auth is in local developer mode (loopback, no access code).
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { BorrowerAssessment } from '../src/types/domain.ts';
import type { EligibilityAssessmentRecord } from '../src/types/eligibility.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-eligibility-'));
process.env.ELIGIBILITY_DATA_DIR = path.join(TMP, 'eligibility');
process.env.ELIGIBILITY_RULES_FILE = path.join(TMP, 'eligibility-rules.json');
process.env.DOCUMENT_AI_DATA_DIR = path.join(TMP, 'document-ai');
delete process.env.DOCUMENT_AI_ACCESS_CODE;
delete process.env.DOCUMENT_AI_ADMIN_CODE;
delete process.env.NODE_ENV;

const { createEligibilityRouter } = await import('../server/eligibility/router.ts');
const { resetRulesCache } = await import('../server/eligibility/rules.ts');
const { passingInput, SEED_PATH } = await import('./helpers/eligibility.ts');

const RULES_FILE = process.env.ELIGIBILITY_RULES_FILE;
const RECORDS_FILE = path.join(process.env.ELIGIBILITY_DATA_DIR, 'records.json');
const ASSESSMENT_ID = 'asm_fictional_1';
const SESSION = 'ds_11111111-2222-4333-8444-555555555555';

const assessments = new Map<string, BorrowerAssessment>([
  [
    ASSESSMENT_ID,
    {
      id: ASSESSMENT_ID,
      applicantLabel: 'FICTIONAL Assessed Co',
      entityType: 'llp',
      requestedAmount: 2_000_000,
      annualTurnoverOrIncome: 0,
      financialProfile: { annualRevenue: 11_000_000 },
    } as BorrowerAssessment,
  ],
]);

let server: Server;
let base = '';
let seededAtBoot = false;

before(async () => {
  const app = express();
  app.use(
    '/api/eligibility',
    createEligibilityRouter({
      getAssessment: (id) => assessments.get(id),
      loadSessionFields: async () => null,
      findSessionIdByAssessment: async () => null,
    })
  );
  seededAtBoot = fs.existsSync(RULES_FILE);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/eligibility`;
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function create(extra: Record<string, unknown> = {}): Promise<EligibilityAssessmentRecord> {
  const r = await call('POST', '/records', { applicantLabel: '  FICTIONAL Co  ', input: passingInput(), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.record;
}

function restoreRules() {
  fs.copyFileSync(SEED_PATH, RULES_FILE);
  resetRulesCache();
}

describe('rules', () => {
  beforeEach(restoreRules);

  it('seeds the live file from the tracked seed at router creation and serves it openly', async () => {
    assert.ok(seededAtBoot);
    const r = await call('GET', '/rules');
    assert.equal(r.status, 200);
    assert.equal(r.json.rules.rulesVersion, '2026-11-04.1');
    assert.match(r.json.rulesHash, /^[0-9a-f]{64}$/);
    assert.equal(r.json.definitions.dscr.kind, 'number_min');
  });

  it('503 rules_invalid for an invalid file, with no fallback values', async () => {
    fs.writeFileSync(RULES_FILE, '{ not json');
    resetRulesCache();
    assert.equal((await call('GET', '/rules')).json.code, 'rules_invalid');
    const bad = JSON.parse(fs.readFileSync(SEED_PATH, 'utf-8'));
    bad.criteria.dscr.kind = 'enum';
    fs.writeFileSync(RULES_FILE, JSON.stringify(bad));
    resetRulesCache();
    const r = await call('POST', '/evaluate', { input: passingInput() });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'rules_invalid');
  });

  it('503 rules_unavailable when the live file is gone', async () => {
    fs.rmSync(RULES_FILE);
    resetRulesCache();
    const r = await call('GET', '/rules');
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'rules_unavailable');
  });
});

describe('evaluate', () => {
  beforeEach(restoreRules);

  it('is stateless and returns a result', async () => {
    const before = (await call('GET', '/records')).json.records.length;
    const r = await call('POST', '/evaluate', { input: passingInput({ businessVintageYears: 1 }) });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.outcome, 'NOT_ELIGIBLE');
    assert.equal((await call('GET', '/records')).json.records.length, before);
  });

  it('400 invalid_input for a missing or extra key, naming it, without echoing values', async () => {
    const input = passingInput() as unknown as Record<string, unknown>;
    delete input.ebit;
    const r = await call('POST', '/evaluate', { input: { ...input, secret: 'FICTIONAL-VALUE' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'invalid_input');
    assert.deepEqual(r.json.fields.sort(), ['ebit', 'secret']);
    assert.ok(!JSON.stringify(r.json).includes('FICTIONAL-VALUE'));
  });

  it('415 for a non-JSON mutation', async () => {
    const res = await fetch(`${base}/evaluate`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(res.status, 415);
  });
});

describe('prefill route', () => {
  it('needs at least one id, a known assessment and a well-formed session id', async () => {
    assert.equal((await call('POST', '/prefill', {})).status, 400);
    assert.equal((await call('POST', '/prefill', { assessmentId: 'nope' })).json.code, 'assessment_not_found');
    assert.equal((await call('POST', '/prefill', { documentSessionId: 'ds_bad' })).status, 400);
  });

  it('maps a saved assessment', async () => {
    const r = await call('POST', '/prefill', { assessmentId: ASSESSMENT_ID });
    assert.equal(r.status, 200);
    assert.equal(r.json.input.entityType, 'llp');
    assert.equal(r.json.input.annualRevenue, 11_000_000);
    assert.equal(r.json.input.dscrStated, null);
    assert.equal(r.json.applicantLabel, 'FICTIONAL Assessed Co');
  });

  it('a session with no state gives all null, not 404', async () => {
    const r = await call('POST', '/prefill', { documentSessionId: SESSION });
    assert.equal(r.status, 200);
    assert.ok(Object.values(r.json.input).every((v) => v === null));
    assert.equal(r.json.documentSessionId, SESSION);
  });
});

describe('records', () => {
  beforeEach(restoreRules);

  it('creates with a reference code, trimmed label and evaluated result', async () => {
    const a = await create();
    const b = await create();
    assert.match(a.id, /^elg_[0-9a-f-]{36}$/);
    assert.equal(a.applicantLabel, 'FICTIONAL Co');
    assert.equal(a.status, 'draft');
    assert.equal(a.finalizedAt, null);
    assert.equal(a.result.outcome, 'ELIGIBLE');
    assert.equal(a.rulesVersion, a.result.rulesVersion);
    const n = (code: string) => Number(code.replace('LB-ELG-', ''));
    assert.equal(n(b.referenceCode), n(a.referenceCode) + 1);
    const list = (await call('GET', '/records')).json.records;
    assert.equal(list[0].id, b.id); // newest updatedAt first
    assert.equal(list[0].outcome, 'ELIGIBLE');
    assert.equal((await call('GET', `/records/${a.id}`)).json.record.id, a.id);
  });

  it('validates the body', async () => {
    const r = await call('POST', '/records', { applicantLabel: '   ', input: passingInput(), status: 'done' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json.fields.sort(), ['applicantLabel', 'status']);
    const long = await call('POST', '/records', { applicantLabel: 'x'.repeat(201), input: passingInput() });
    assert.equal(long.status, 400);
    const linked = await call('POST', '/records', { applicantLabel: 'A', input: passingInput(), linkedAssessmentId: 'missing' });
    assert.equal(linked.json.code, 'assessment_not_found');
  });

  it('400 invalid_record_id and 404 record_not_found', async () => {
    assert.equal((await call('GET', '/records/abc')).json.code, 'invalid_record_id');
    const r = await call('GET', '/records/elg_00000000-0000-4000-8000-000000000000');
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'record_not_found');
  });

  it('PUT on a draft replaces input, re-evaluates and keeps the old result', async () => {
    const rec = await create();
    const r = await call('PUT', `/records/${rec.id}`, { input: passingInput({ personalCibilScore: null }) });
    assert.equal(r.status, 200);
    assert.equal(r.json.record.result.outcome, 'INCOMPLETE_DOCUMENTS');
    assert.equal(r.json.record.previousResults.length, 1);
    assert.equal(r.json.record.previousResults[0].outcome, 'ELIGIBLE');
  });

  it('reassess keeps at most 20 snapshots, newest first', async () => {
    const rec = await create();
    let last: EligibilityAssessmentRecord = rec;
    for (let i = 0; i < 23; i++) {
      const r = await call('POST', `/records/${rec.id}/reassess`, {});
      assert.equal(r.status, 200);
      last = r.json.record;
    }
    assert.equal(last.previousResults.length, 20);
    const times = last.previousResults.map((s) => s.evaluatedAt);
    assert.deepEqual([...times].sort().reverse(), times);
    assert.ok(last.result.evaluatedAt >= times[0]);
  });

  it('a final record is immutable except linkedAssessmentId; reassess and continue still work', async () => {
    const rec = await create({ status: 'final' });
    assert.equal(rec.status, 'final');
    assert.ok(rec.finalizedAt);

    for (const body of [
      { input: passingInput({ businessVintageYears: 1 }) },
      { applicantLabel: 'Changed' },
      { status: 'draft' },
      { status: 'final' },
      { linkedAssessmentId: ASSESSMENT_ID, applicantLabel: 'Changed' },
    ]) {
      const r = await call('PUT', `/records/${rec.id}`, body);
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.equal(r.json.code, 'record_final');
    }
    const stored = (await call('GET', `/records/${rec.id}`)).json.record;
    assert.deepEqual(stored.input, rec.input);
    assert.equal(stored.applicantLabel, rec.applicantLabel);

    assert.equal((await call('PUT', `/records/${rec.id}`, { linkedAssessmentId: 'missing' })).status, 404);
    const linked = await call('PUT', `/records/${rec.id}`, { linkedAssessmentId: ASSESSMENT_ID });
    assert.equal(linked.status, 200);
    assert.equal(linked.json.record.linkedAssessmentId, ASSESSMENT_ID);
    assert.equal(linked.json.record.previousResults.length, 0); // not re-evaluated

    assert.equal((await call('POST', `/records/${rec.id}/reassess`, {})).status, 200);
  });

  it('draft to final sets finalizedAt', async () => {
    const rec = await create();
    const r = await call('PUT', `/records/${rec.id}`, { status: 'final' });
    assert.equal(r.json.record.status, 'final');
    assert.ok(r.json.record.finalizedAt);
  });

  it('continue builds a prefill, or points at the linked assessment', async () => {
    const rec = await create({ documentSessionId: SESSION });
    const c1 = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(c1.status, 200);
    assert.equal(c1.json.existingAssessmentId, null);
    assert.equal(c1.json.prefill.assessment.creditScore, 750);
    assert.equal(c1.json.prefill.documentSessionId, SESSION);
    assert.ok(c1.json.record.continuedAt);

    await call('PUT', `/records/${rec.id}`, { linkedAssessmentId: ASSESSMENT_ID });
    const c2 = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(c2.json.existingAssessmentId, ASSESSMENT_ID);
    assert.equal(c2.json.prefill, null);
  });
});

describe('store safety', () => {
  beforeEach(restoreRules);

  it('an unparseable records file is never overwritten', async () => {
    await create();
    const corrupt = '{ "version": 1, "records": [ truncated';
    fs.writeFileSync(RECORDS_FILE, corrupt);
    const r1 = await call('POST', '/records', { applicantLabel: 'B', input: passingInput() });
    assert.equal(r1.status, 500);
    assert.equal(r1.json.code, 'internal_error');
    assert.equal((await call('GET', '/records')).status, 500);
    assert.equal(fs.readFileSync(RECORDS_FILE, 'utf-8'), corrupt);
    fs.writeFileSync(RECORDS_FILE, JSON.stringify({ version: 1, records: [] }));
    assert.equal((await call('GET', '/records')).status, 200);
  });

  it('writes leave no temp files behind', async () => {
    await create();
    const leftovers = fs.readdirSync(path.dirname(RECORDS_FILE)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

describe('continue is enforced by the backend for all four outcomes (gate on)', () => {
  beforeEach(() => {
    process.env.ELIGIBILITY_ENFORCE_CONTINUE_GATE = 'true';
    restoreRules();
  });
  after(() => {
    delete process.env.ELIGIBILITY_ENFORCE_CONTINUE_GATE;
  });

  const continueFor = async (input: ReturnType<typeof passingInput>) => {
    const rec = await create({ input });
    return { rec, res: await call('POST', `/records/${rec.id}/continue`, {}) };
  };

  it('ELIGIBLE proceeds', async () => {
    const { rec, res } = await continueFor(passingInput());
    assert.equal(rec.result.outcome, 'ELIGIBLE');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.conditions, []);
  });

  it('CONDITIONALLY_ELIGIBLE proceeds and returns the conditions', async () => {
    // 2.5 years is inside the conditional band (2 to below 3) for business vintage.
    const { rec, res } = await continueFor(passingInput({ businessVintageYears: 2.5 }));
    assert.equal(rec.result.outcome, 'CONDITIONALLY_ELIGIBLE');
    assert.equal(res.status, 200);
    assert.ok(res.json.conditions.some((c: { criterionId: string }) => c.criterionId === 'business_vintage'));
  });

  it('INCOMPLETE_DOCUMENTS is blocked with 409 and no prefill', async () => {
    const { rec, res } = await continueFor(passingInput({ personalCibilScore: null, promoterCibilScore: null }));
    assert.equal(rec.result.outcome, 'INCOMPLETE_DOCUMENTS');
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'continue_blocked_incomplete');
    assert.equal(res.json.prefill, undefined);
    assert.equal((await call('GET', `/records/${rec.id}`)).json.record.continuedAt, null);
  });

  it('NOT_ELIGIBLE is blocked with 409', async () => {
    const { rec, res } = await continueFor(passingInput({ businessVintageYears: 0.5 }));
    assert.equal(rec.result.outcome, 'NOT_ELIGIBLE');
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'continue_blocked_not_eligible');
  });

  it('a blocked record linked to an assessment is still blocked', async () => {
    const rec = await create({ input: passingInput({ businessVintageYears: 0.5 }) });
    await call('PUT', `/records/${rec.id}`, { linkedAssessmentId: ASSESSMENT_ID });
    assert.equal((await call('POST', `/records/${rec.id}/continue`, {})).status, 409);
  });

  it('becomes allowed only after a reassessment that changes the outcome', async () => {
    const rec = await create({ input: passingInput({ businessVintageYears: 0.5 }) });
    assert.equal((await call('POST', `/records/${rec.id}/continue`, {})).status, 409);
    const fixed = await call('PUT', `/records/${rec.id}`, { input: passingInput() });
    assert.equal(fixed.json.record.result.outcome, 'ELIGIBLE');
    assert.equal((await call('POST', `/records/${rec.id}/continue`, {})).status, 200);
  });
});

describe('continue re-evaluates against the current rules (stored result is not trusted) (gate on)', () => {
  beforeEach(() => {
    process.env.ELIGIBILITY_ENFORCE_CONTINUE_GATE = 'true';
    restoreRules();
  });
  after(() => {
    delete process.env.ELIGIBILITY_ENFORCE_CONTINUE_GATE;
    restoreRules();
  });

  /** Writes a changed copy of the seed rules as the live file. */
  function writeRules(edit: (rules: any) => void) {
    const rules = JSON.parse(fs.readFileSync(SEED_PATH, 'utf-8'));
    edit(rules);
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules));
    resetRulesCache();
  }
  const stricterVintage = (rules: any) => {
    rules.rulesVersion = '2026-11-03.2-test';
    rules.criteria.business_vintage.passAt = 10;
    rules.criteria.business_vintage.conditionalTo = null;
  };

  it('a record saved ELIGIBLE that is NOT_ELIGIBLE under the current rules is refused with 409', async () => {
    const rec = await create();
    assert.equal(rec.result.outcome, 'ELIGIBLE');
    writeRules(stricterVintage);
    const res = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'continue_blocked_not_eligible');
    assert.equal(res.json.prefill, undefined);

    const stored = (await call('GET', `/records/${rec.id}`)).json.record as EligibilityAssessmentRecord;
    assert.equal(stored.result.outcome, 'NOT_ELIGIBLE'); // the fresh result is kept even though continue was refused
    assert.notEqual(stored.result.rulesHash, rec.result.rulesHash);
    assert.equal(stored.rulesVersion, '2026-11-03.2-test');
    assert.equal(stored.previousResults.length, 1);
    assert.equal(stored.previousResults[0].outcome, 'ELIGIBLE');
    assert.equal(stored.previousResults[0].rulesHash, rec.result.rulesHash);
    assert.equal(stored.continuedAt, null);

    restoreRules();
    const again = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(again.status, 200);
    assert.equal(again.json.record.result.outcome, 'ELIGIBLE');
    assert.equal(again.json.record.result.rulesHash, rec.result.rulesHash);
    assert.equal(again.json.record.previousResults.length, 2);
  });

  it('also refuses when the record links an existing assessment', async () => {
    const rec = await create();
    assert.equal((await call('PUT', `/records/${rec.id}`, { linkedAssessmentId: ASSESSMENT_ID })).status, 200);
    writeRules(stricterVintage);
    const res = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'continue_blocked_not_eligible');
    assert.equal(res.json.existingAssessmentId, undefined);
  });

  it('INCOMPLETE under the current rules (a criterion newly made mandatory) is refused', async () => {
    const rec = await create({ input: passingInput({ totalOutsideLiabilities: null }) });
    assert.equal(rec.result.outcome, 'CONDITIONALLY_ELIGIBLE');
    writeRules((rules) => {
      rules.rulesVersion = '2026-11-03.3-test';
      rules.criteria.tol_tnw.mandatory = true;
    });
    const res = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'continue_blocked_incomplete');
  });

  it('a record saved NOT_ELIGIBLE that passes under the current rules proceeds, with the fresh result stored', async () => {
    const rec = await create({ input: passingInput({ businessVintageYears: 1 }) });
    assert.equal(rec.result.outcome, 'NOT_ELIGIBLE');
    writeRules((rules) => {
      rules.rulesVersion = '2026-11-03.4-test';
      rules.criteria.business_vintage.passAt = 1;
      rules.criteria.business_vintage.conditionalTo = null;
    });
    const res = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(res.status, 200);
    assert.equal(res.json.record.result.outcome, 'ELIGIBLE');
    assert.equal(res.json.record.previousResults[0].outcome, 'NOT_ELIGIBLE');
    assert.ok(res.json.prefill);
  });

  it('with unchanged rules nothing is pushed to previousResults', async () => {
    const rec = await create();
    const res = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(res.status, 200);
    assert.equal(res.json.record.previousResults.length, 0);
    assert.equal(res.json.record.result.evaluatedAt, rec.result.evaluatedAt);
  });

  it('503 when the current rules are invalid: there is nothing to gate on', async () => {
    const rec = await create();
    fs.writeFileSync(RULES_FILE, '{ not json');
    resetRulesCache();
    const res = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(res.status, 503);
    assert.equal(res.json.code, 'rules_invalid');
    restoreRules();
    assert.equal((await call('GET', `/records/${rec.id}`)).json.record.continuedAt, null);
  });
});

describe('continue conditions list every reason for CONDITIONALLY_ELIGIBLE', () => {
  beforeEach(restoreRules);

  it('includes conditional rows and non-mandatory failed and missing rows', async () => {
    const rec = await create({
      input: passingInput({ businessVintageYears: 2.5, totalOutsideLiabilities: 20_000_000, commercialCmrRank: null }),
    });
    assert.equal(rec.result.outcome, 'CONDITIONALLY_ELIGIBLE');
    const res = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(res.status, 200);
    const byId = new Map<string, string>(
      res.json.conditions.map((c: { criterionId: string; status: string }) => [c.criterionId, c.status])
    );
    assert.equal(byId.get('business_vintage'), 'conditional'); // mandatory, conditional band
    assert.equal(byId.get('tol_tnw'), 'failed'); // non-mandatory failed (5.00 > 4.00)
    assert.equal(byId.get('commercial_cmr'), 'missing'); // non-mandatory missing
    assert.equal(byId.size, 3);
  });

  it('a non-mandatory failure alone is listed', async () => {
    const rec = await create({ input: passingInput({ totalOutsideLiabilities: 20_000_000 }) });
    assert.equal(rec.result.outcome, 'CONDITIONALLY_ELIGIBLE');
    const res = await call('POST', `/records/${rec.id}/continue`, {});
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.json.conditions.map((c: { criterionId: string }) => c.criterionId),
      ['tol_tnw']
    );
  });
});

describe('linking is a pure link update', () => {
  beforeEach(restoreRules);
  after(restoreRules);

  it('PUT { linkedAssessmentId } on a draft does not re-evaluate', async () => {
    const rec = await create();
    const r = await call('PUT', `/records/${rec.id}`, { linkedAssessmentId: ASSESSMENT_ID });
    assert.equal(r.status, 200);
    assert.equal(r.json.record.linkedAssessmentId, ASSESSMENT_ID);
    assert.equal(r.json.record.previousResults.length, 0);
    assert.deepEqual(r.json.record.result, rec.result);
  });

  it('succeeds with an invalid or missing rules file, on draft and final records', async () => {
    const draft = await create();
    const final = await create({ status: 'final' });
    fs.writeFileSync(RULES_FILE, '{ not json');
    resetRulesCache();
    for (const rec of [draft, final]) {
      const r = await call('PUT', `/records/${rec.id}`, { linkedAssessmentId: ASSESSMENT_ID });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.record.result, rec.result);
      const unlink = await call('PUT', `/records/${rec.id}`, { linkedAssessmentId: null });
      assert.equal(unlink.status, 200);
      assert.equal(unlink.json.record.linkedAssessmentId, null);
    }
    fs.rmSync(RULES_FILE);
    resetRulesCache();
    assert.equal((await call('PUT', `/records/${draft.id}`, { linkedAssessmentId: ASSESSMENT_ID })).status, 200);
    // Anything beyond the link still needs the rules.
    const edit = await call('PUT', `/records/${draft.id}`, { applicantLabel: 'Changed' });
    assert.equal(edit.status, 503);
    assert.equal(edit.json.code, 'rules_unavailable');
  });

  it('an unknown assessment is still 404', async () => {
    const rec = await create();
    const r = await call('PUT', `/records/${rec.id}`, { linkedAssessmentId: 'missing' });
    assert.equal(r.json.code, 'assessment_not_found');
  });
});

describe('continue with the gate off (the default): failed mandatory criteria do not block', () => {
  beforeEach(() => {
    delete process.env.ELIGIBILITY_ENFORCE_CONTINUE_GATE;
    restoreRules();
  });

  const continueFor = async (input: ReturnType<typeof passingInput>) => {
    const rec = await create({ input });
    return { rec, res: await call('POST', `/records/${rec.id}/continue`, {}) };
  };

  it('NOT_ELIGIBLE continues, keeps its result and returns the prefill', async () => {
    const { rec, res } = await continueFor(passingInput({ businessVintageYears: 0.5 }));
    assert.equal(rec.result.outcome, 'NOT_ELIGIBLE');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.record.result.outcome, 'NOT_ELIGIBLE');
    assert.ok(res.json.record.continuedAt);
    assert.ok(res.json.prefill);
  });

  it('INCOMPLETE_DOCUMENTS continues too', async () => {
    const { rec, res } = await continueFor(passingInput({ personalCibilScore: null, promoterCibilScore: null }));
    assert.equal(rec.result.outcome, 'INCOMPLETE_DOCUMENTS');
    assert.equal(res.status, 200, JSON.stringify(res.json));
  });
});
