/**
 * The user's five core credit rules, as named constants and pure helpers. The Initial Eligibility Check reads its
 * thresholds from its rules file (server/eligibility/defaultRules.json, never from code);
 * tests/core-credit-rules.test.ts asserts that file's five criteria equal these constants. The matching engine
 * (server/ruleEngine.ts) does not use this file yet: applying the rules there is a pending decision.
 *
 * 1. CIBIL: 750 or above eligible; 700 to 749 conditionally eligible; below 700 not eligible.
 * 2. CMR rank: below 7 satisfies; 7 or above does not.
 * 3. TOL/TNW: at most 4.00.
 * 4. DSCR: strictly above 1.00.
 * 5. Banking turnover: at least 80% of annual revenue.
 * A missing input is reported as missing, never assumed. Pure: no I/O, no AI.
 *
 * Callers pass values already rounded the way they display them (ratios to 2 dp); scores and ranks are compared
 * exactly. So a DSCR shown as 1.00 does not satisfy "strictly above 1.00".
 */

export const CIBIL_ELIGIBLE_MIN = 750;
export const CIBIL_CONDITIONAL_MIN = 700;
/** CMR rank must be strictly below this (1 is best, 10 worst). */
export const CMR_RANK_BELOW = 7;
export const TOL_TNW_MAX = 4;
/** DSCR must be strictly above this. */
export const DSCR_ABOVE = 1;
export const BANKING_TURNOVER_MIN_PERCENT = 80;

/** Entity types a commercial (CMR) report applies to; same list as commercial_cmr in the eligibility rules. */
export const CMR_APPLIES_TO_ENTITY_TYPES: readonly string[] = [
  'partnership',
  'llp',
  'private_limited',
  'public_limited',
  'trust_society',
];
/** commercialCreditReportStatus value that skips the CMR rule; same as commercial_cmr skipWhen. */
export const CMR_REPORT_NOT_APPLICABLE = 'not_applicable';

export type CibilClass = 'eligible' | 'conditional' | 'not_eligible' | 'missing';
export type CoreRuleStatus = 'satisfied' | 'not_satisfied' | 'missing';

/** Exact rule text, built from the constants above. */
export const CORE_RULE_TEXT = {
  cibil: `CIBIL score must be ${CIBIL_ELIGIBLE_MIN} or above to be eligible (${CIBIL_CONDITIONAL_MIN} to ${CIBIL_ELIGIBLE_MIN - 1} is conditionally eligible; below ${CIBIL_CONDITIONAL_MIN} is not eligible)`,
  cmr: `CMR rank must be below ${CMR_RANK_BELOW}`,
  tolTnw: `TOL/TNW must be at most ${TOL_TNW_MAX.toFixed(2)}`,
  dscr: `DSCR must be strictly above ${DSCR_ABOVE.toFixed(2)}`,
  bankingTurnover: `Banking turnover must be at least ${BANKING_TURNOVER_MIN_PERCENT}% of annual revenue`,
} as const;

/** A finite number, else null. null, undefined, '' and NaN are "not provided"; 0 is a real value. */
export function presentNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = value.replace(/,/g, '').trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Scores compared exactly, never rounded. */
export function classifyCibil(score: number | null | undefined): CibilClass {
  const s = presentNumber(score);
  if (s === null) return 'missing';
  if (s >= CIBIL_ELIGIBLE_MIN) return 'eligible';
  if (s >= CIBIL_CONDITIONAL_MIN) return 'conditional';
  return 'not_eligible';
}

/** Rank compared exactly: 6 satisfies, 7 does not. */
export function classifyCmr(rank: number | null | undefined): CoreRuleStatus {
  const r = presentNumber(rank);
  if (r === null) return 'missing';
  return r < CMR_RANK_BELOW ? 'satisfied' : 'not_satisfied';
}

/** Ratio as computed (2 dp). Zero or negative TNW must be decided by the caller before this (it fails). */
export function classifyTolTnw(ratio: number | null | undefined): CoreRuleStatus {
  const r = presentNumber(ratio);
  if (r === null) return 'missing';
  return r >= 0 && r <= TOL_TNW_MAX ? 'satisfied' : 'not_satisfied';
}

/** DSCR as computed (2 dp). 1.00 does not satisfy; 1.01 does. */
export function classifyDscr(dscr: number | null | undefined): CoreRuleStatus {
  const d = presentNumber(dscr);
  if (d === null) return 'missing';
  return d > DSCR_ABOVE ? 'satisfied' : 'not_satisfied';
}

/** Banking turnover percent as computed (2 dp). 79.99 does not satisfy; 80 does. */
export function classifyBankingTurnover(percent: number | null | undefined): CoreRuleStatus {
  const p = presentNumber(percent);
  if (p === null) return 'missing';
  return p >= BANKING_TURNOVER_MIN_PERCENT ? 'satisfied' : 'not_satisfied';
}
