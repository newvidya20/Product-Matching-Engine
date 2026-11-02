/**
 * Seam between the extraction pipeline and the storage routes (docs/contracts.md section 2).
 * Stub committed by architect so storage-engineer compiles against the real signatures.
 * extraction-engineer owns this file from here on and replaces the bodies, keeping the exports.
 */
import type {
  AcceptedFileKind,
  DocumentExtractionResult,
  ExtractDocumentInput,
  MergeSessionInput,
  MergeSessionOutput,
  SpreadsheetPreview,
} from '../../src/types/documentAi.ts';

export async function extractDocument(
  input: ExtractDocumentInput
): Promise<DocumentExtractionResult> {
  return { ok: false, documentId: input.documentId, errorCode: 'llm_failed' };
}

export function mergeSessionResults(_input: MergeSessionInput): MergeSessionOutput {
  return { fields: {}, warnings: [] };
}

export async function readSpreadsheetPreview(
  _bytes: Uint8Array,
  _kind: Extract<AcceptedFileKind, 'xlsx' | 'csv'>
): Promise<SpreadsheetPreview> {
  return { sheets: [] };
}
