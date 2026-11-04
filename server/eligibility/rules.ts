/**
 * Rules file loader (docs/eligibility-contracts.md section 5.3). The engine has no built-in thresholds: without a
 * valid live rules file it refuses to evaluate. The tracked seed is only ever copied to the live path.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITERION_DEFINITIONS, ELIGIBILITY_CRITERION_IDS } from '../../src/types/eligibility.ts';
import type { EligibilityRuleConfig } from '../../src/types/eligibility.ts';
import { ENTITY_TYPES, ENUM_INPUT_VALUES } from './inputSchema.ts';

export const SEED_RULES_FILE = fileURLToPath(new URL('./defaultRules.json', import.meta.url));

export function getRulesFile(): string {
  return path.resolve(process.cwd(), process.env.ELIGIBILITY_RULES_FILE || 'data/eligibility-rules.json');
}

/** Copies the seed to the live path when the live file is absent. Never overwrites. Returns true if copied. */
export function seedRulesFile(seed: string = SEED_RULES_FILE): boolean {
  const live = getRulesFile();
  if (fs.existsSync(live)) return false;
  fs.mkdirSync(path.dirname(live), { recursive: true });
  try {
    fs.copyFileSync(seed, live, fs.constants.COPYFILE_EXCL);
    return true;
  } catch {
    return false; // another writer won, or the seed is unreadable: the loader reports what it finds
  }
}

export type LoadedRules =
  | { ok: true; rules: EligibilityRuleConfig; rulesHash: string }
  | { ok: false; code: 'rules_unavailable' | 'rules_invalid' };

/** JSON with object keys sorted at every level; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const hashRules = (rules: unknown): string =>
  crypto.createHash('sha256').update(canonicalJson(rules)).digest('hex');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const NUMERIC_UNITS = new Set(['currency', 'years', 'score', 'rank', 'ratio', 'multiple', 'percent']);
const SKIP_FIELDS = new Set(['commercialCreditReportStatus', 'gstComplianceStatus']);

/** Section 5.3 validity. Returns a list of problems (empty when valid). Problems name ids and keys only. */
export function validateRuleConfig(raw: unknown): string[] {
  const problems: string[] = [];
  if (!isObj(raw)) return ['root'];
  if (raw.schemaVersion !== 1) problems.push('schemaVersion');
  if (typeof raw.rulesVersion !== 'string' || !raw.rulesVersion.trim()) problems.push('rulesVersion');
  if (raw.status !== 'editable_default' && raw.status !== 'confirmed') problems.push('status');
  if (raw.confirmedBy !== null && typeof raw.confirmedBy !== 'string') problems.push('confirmedBy');
  if (raw.confirmedAt !== null && typeof raw.confirmedAt !== 'string') problems.push('confirmedAt');
  if (raw.currency !== 'INR') problems.push('currency');
  if (!isObj(raw.criteria)) return [...problems, 'criteria'];
  const criteria = raw.criteria;
  const ids = new Set<string>(ELIGIBILITY_CRITERION_IDS);
  for (const key of Object.keys(criteria)) if (!ids.has(key)) problems.push(`criteria.${key}:unknown`);
  let mandatoryEnabled = 0;
  for (const id of ELIGIBILITY_CRITERION_IDS) {
    const c = criteria[id];
    const p = (what: string) => problems.push(`criteria.${id}.${what}`);
    if (!isObj(c)) {
      p('absent');
      continue;
    }
    const def = CRITERION_DEFINITIONS[id];
    if (typeof c.enabled !== 'boolean') p('enabled');
    if (typeof c.mandatory !== 'boolean') p('mandatory');
    if (c.enabled === true && c.mandatory === true) mandatoryEnabled++;
    if (typeof c.label !== 'string' || !c.label.trim()) p('label');
    if (typeof c.rationale !== 'string') p('rationale');
    if (c.kind !== def.kind) p('kind');
    if (c.appliesToEntityTypes !== 'all') {
      if (
        !isStrArr(c.appliesToEntityTypes) ||
        !c.appliesToEntityTypes.every((e) => (ENTITY_TYPES as readonly string[]).includes(e))
      )
        p('appliesToEntityTypes');
    }
    let skipValues: string[] = [];
    let skipField: string | null = null;
    if (c.skipWhen !== undefined && c.skipWhen !== null) {
      const s = c.skipWhen;
      if (!isObj(s) || typeof s.field !== 'string' || !SKIP_FIELDS.has(s.field) || !isStrArr(s.values)) p('skipWhen');
      else {
        const allowed = ENUM_INPUT_VALUES[s.field as 'gstComplianceStatus'] || [];
        if (!s.values.every((v) => allowed.includes(v))) p('skipWhen.values');
        skipField = s.field;
        skipValues = s.values;
      }
    }
    if (def.kind === 'enum') {
      if (c.unit !== 'enum') p('unit');
      if (c.strict !== undefined) p('strict');
      if (!isStrArr(c.pass) || !isStrArr(c.conditional) || !isStrArr(c.fail)) {
        p('lists');
        continue;
      }
      const field = def.requiredInputs[0];
      const allowed = ENUM_INPUT_VALUES[field] || [];
      const listed = [...c.pass, ...c.conditional, ...c.fail, ...(skipField === field ? skipValues : [])];
      for (const v of listed) if (!allowed.includes(v)) p(`lists.${v}:unknown`);
      for (const v of allowed) {
        const n = listed.filter((x) => x === v).length;
        if (n !== 1) p(`lists.${v}:${n === 0 ? 'unlisted' : 'repeated'}`);
      }
    } else {
      if (typeof c.unit !== 'string' || !NUMERIC_UNITS.has(c.unit)) p('unit');
      if (!isFiniteNum(c.passAt)) p('passAt');
      if (c.conditionalTo !== null && !isFiniteNum(c.conditionalTo)) p('conditionalTo');
      if (isFiniteNum(c.passAt) && isFiniteNum(c.conditionalTo)) {
        if (def.kind === 'number_min' && c.conditionalTo > c.passAt) p('conditionalTo:above_passAt');
        if (def.kind === 'number_max' && c.conditionalTo < c.passAt) p('conditionalTo:below_passAt');
      }
      // strict: exclusive pass bound (e.g. DSCR above 1.00, CMR below 7). No conditional band with it.
      if (c.strict !== undefined && typeof c.strict !== 'boolean') p('strict');
      if (c.strict === true && c.conditionalTo !== null) p('strict:conditionalTo_must_be_null');
    }
  }
  if (mandatoryEnabled === 0) problems.push('criteria:no_enabled_mandatory');
  return problems;
}

let cache: { file: string; mtimeMs: number; size: number; loaded: LoadedRules & { ok: true } } | null = null;

/** Re-reads when mtime or size changes; otherwise cached. A failed load caches nothing. */
export function loadRules(): LoadedRules {
  const file = getRulesFile();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = null;
    return { ok: false, code: 'rules_unavailable' };
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.loaded;
  cache = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, code: code === 'ENOENT' ? 'rules_unavailable' : 'rules_invalid' };
  }
  if (validateRuleConfig(parsed).length > 0) return { ok: false, code: 'rules_invalid' };
  const loaded = { ok: true as const, rules: parsed as EligibilityRuleConfig, rulesHash: hashRules(parsed) };
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, loaded };
  return loaded;
}

/** For tests: forget the cached rules. */
export function resetRulesCache(): void {
  cache = null;
}
