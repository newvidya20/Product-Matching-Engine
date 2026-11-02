/**
 * applyFieldResults: the one place Document AI values reach the form (docs/contracts.md section 5).
 * Pure. Only `auto_applied` results are ever written, and a field in `editedFields` is never touched.
 * Callers pass the edited map as it stands at the moment of the call, so a result that arrives while
 * a person is typing is checked against that keystroke.
 */
import type { AppliedFieldEntry, FieldResult } from '../../types/documentAi';
import {
  FIELD_DEFINITIONS,
  FUNDING_PURPOSE_VALUES,
  getFieldDefinition,
  toFormValue,
  type FieldDefinition,
} from '../../documentAi/fieldMap';
import type { FundingPurposeCategory } from '../../types/domain';
import { isFormBacked, readField, writeField, type FormState } from './formModel';

export interface ApplyInput {
  form: FormState;
  fields: Record<string, FieldResult>;
  /** Field IDs a person owns, as of now. */
  editedFieldIds: ReadonlySet<string>;
  applied: Record<string, AppliedFieldEntry>;
  /**
   * Fields this page auto-applied itself. Only these may be reverted to the default when their source
   * result changes; a value that came from a reopened draft is never reverted or blanked.
   * Omit to allow reverting every applied field.
   */
  revertableFieldIds?: ReadonlySet<string>;
  now?: string;
}

export interface ApplyOutput {
  form: FormState;
  applied: Record<string, AppliedFieldEntry>;
  /** Applied entries that changed, for PUT .../edits. */
  setApplied: AppliedFieldEntry[];
  clearApplied: string[];
  /** Edited entries dropped because a purpose change cleared the old purpose's questions. */
  clearEdited: string[];
}

const COLLATERAL_DETAIL_IDS = ['collateralType', 'collateralValue', 'collateralDescription'];

export function dynamicFieldIdsForPurpose(purpose: FundingPurposeCategory): string[] {
  return FIELD_DEFINITIONS.filter(
    (d) => d.target.kind === 'dynamic' && d.target.purpose === purpose
  ).map((d) => d.fieldId);
}

function hasDynamicAnswer(form: FormState): boolean {
  return Object.values(form.dynamicPurposeAnswers ?? {}).some((v) => String(v ?? '').trim() !== '');
}

function defaultFor(definition: FieldDefinition): string {
  return definition.defaultValue ?? '';
}

/** True when the value is acceptable for the form input. Enums must be an exact allowed value. */
function isWritable(definition: FieldDefinition, value: FieldResult['value']): value is string | number {
  if (value === null || value === undefined) return false;
  if (definition.valueType === 'enum') return definition.allowedValues.includes(String(value));
  if (definition.valueType === 'number') return typeof value === 'number' && Number.isFinite(value);
  return String(value).length > 0;
}

function orderedFieldIds(fields: Record<string, FieldResult>): string[] {
  const ids = Object.keys(fields);
  const rank = (id: string) => (id === 'fundingPurpose' ? 0 : id === 'collateralAvailable' ? 1 : 2);
  return ids.sort((a, b) => rank(a) - rank(b));
}

export function applyFieldResults(input: ApplyInput): ApplyOutput {
  const at = input.now ?? new Date().toISOString();
  let form = input.form;
  const applied: Record<string, AppliedFieldEntry> = { ...input.applied };
  const edited = new Set(input.editedFieldIds);
  const setApplied = new Map<string, AppliedFieldEntry>();
  const clearApplied = new Set<string>();
  const clearEdited = new Set<string>();

  const canRevert = (fieldId: string) => !input.revertableFieldIds || input.revertableFieldIds.has(fieldId);
  const record = (fieldId: string, candidateId: string) => {
    const entry: AppliedFieldEntry = { fieldId, candidateId, at };
    applied[fieldId] = entry;
    setApplied.set(fieldId, entry);
    clearApplied.delete(fieldId);
  };
  const unrecord = (fieldId: string) => {
    if (!(fieldId in applied)) return;
    delete applied[fieldId];
    setApplied.delete(fieldId);
    clearApplied.add(fieldId);
  };

  for (const fieldId of orderedFieldIds(input.fields)) {
    const result = input.fields[fieldId];
    const definition = getFieldDefinition(fieldId);
    if (!definition || !isFormBacked(definition)) continue; // review_only and unknown IDs stay in Review
    if (definition.target.kind === 'ratio') continue;

    // Dynamic answers of another purpose stay in Review only.
    if (definition.target.kind === 'dynamic' && definition.target.purpose !== form.fundingPurpose) {
      continue;
    }
    if (edited.has(fieldId)) continue;

    if (result.status === 'auto_applied') {
      if (!isWritable(definition, result.value)) continue;
      const candidateId = result.suggestedCandidateId ?? result.candidates[0]?.candidateId ?? fieldId;

      if (COLLATERAL_DETAIL_IDS.includes(fieldId)) {
        // These inputs are disabled while collateral is "no". Hold them if the person chose that.
        if (form.collateralAvailable !== 'yes') {
          if (edited.has('collateralAvailable')) continue;
          form = { ...form, collateralAvailable: 'yes' };
          record('collateralAvailable', candidateId);
        }
      }

      const next = toFormValue(definition, result.value);
      if (fieldId === 'fundingPurpose') {
        if (!(FUNDING_PURPOSE_VALUES as readonly string[]).includes(next)) continue;
        if (next !== form.fundingPurpose) {
          // Only a person's change of purpose clears answers. With any answer present, leave it for review.
          if (hasDynamicAnswer(form)) continue;
          for (const oldId of dynamicFieldIdsForPurpose(form.fundingPurpose)) {
            unrecord(oldId);
            if (edited.delete(oldId)) clearEdited.add(oldId);
          }
          form = { ...form, fundingPurpose: next as FundingPurposeCategory, dynamicPurposeAnswers: {} };
        }
      } else if (readField(form, definition) !== next) {
        form = writeField(form, definition, next);
      }
      record(fieldId, candidateId);
    } else if (fieldId in applied) {
      // Contradicted or withdrawn: back to the default, shown as a conflict or suggestion.
      // A value this page did not apply stays as saved; only the stale mark goes.
      if (canRevert(fieldId)) form = writeField(form, definition, defaultFor(definition));
      unrecord(fieldId);
    }
  }

  // An applied value whose result no longer exists has lost its source: back to the default.
  for (const fieldId of Object.keys(applied)) {
    if (fieldId in input.fields || edited.has(fieldId) || fieldId === 'collateralAvailable') continue;
    const definition = getFieldDefinition(fieldId);
    if (!definition || !isFormBacked(definition)) continue;
    if (definition.target.kind === 'dynamic' && definition.target.purpose !== form.fundingPurpose) continue;
    if (canRevert(fieldId)) form = writeField(form, definition, defaultFor(definition));
    unrecord(fieldId);
  }

  // Collateral flag the apply switched on, with nothing left to justify it.
  if (
    'collateralAvailable' in applied &&
    !edited.has('collateralAvailable') &&
    canRevert('collateralAvailable') &&
    input.fields.collateralAvailable?.status !== 'auto_applied' &&
    !COLLATERAL_DETAIL_IDS.some((id) => id in applied)
  ) {
    form = { ...form, collateralAvailable: 'no' };
    unrecord('collateralAvailable');
  }

  return {
    form,
    applied,
    setApplied: [...setApplied.values()],
    clearApplied: [...clearApplied],
    clearEdited: [...clearEdited],
  };
}
