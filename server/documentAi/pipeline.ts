/**
 * Seam between the extraction pipeline and the storage routes (docs/contracts.md section 2).
 * Handles one file at a time, and does no storage. It logs nothing: document text and extracted
 * values must not reach a log, and error paths carry only an ExtractionErrorCode.
 *
 * Order of work, so a file is read with no AI quota at all:
 * 1. The server reads the file itself: PDF text layer, Word, text, spreadsheet cells, and local OCR
 *    (ocr.ts) for scanned PDFs and images.
 * 2. The document type comes from a declared override, or the file's own title (localClassifier.ts).
 * 3. Deterministic extractors (localExtractors.ts) read labelled values from that text.
 * 4. Only if a key field is still missing, and a model is configured and not out of its daily quota,
 *    the model is asked, within its own time budget. Values found locally always win.
 * 5. Everything passes through buildCandidates / buildBankMonthlyTotals, which check each value
 *    against the server-read text. A model failure after step 3 leaves the local values standing:
 *    the file completes with what was read, and missing fields stay missing.
 */
import { DOCUMENT_AI_THRESHOLDS } from '../../src/types/documentAi.ts';
import type {
  AcceptedFileKind,
  DocumentExtractionResult,
  DocumentType,
  ExtractDocumentInput,
  ExtractionErrorCode,
  MergeSessionInput,
  MergeSessionOutput,
  SpreadsheetPreview,
} from '../../src/types/documentAi.ts';
import { FILE_KIND_MIME } from '../../src/types/documentAi.ts';
import type { Part } from '@google/genai';
import { ExtractionError, activeModelName, generateJson, isLlmConfigured } from './gemini.ts';
import { openRouterSendsPdfAsText } from '../llm/openrouter.ts';
import { activeLlmProvider } from '../llm/provider.ts';
import { buildBankMonthlyTotals, buildCandidates, mergeSession } from './merge.ts';
import {
  buildClassificationInstruction,
  buildExtractionInstruction,
  CLASSIFICATION_REQUEST,
  CLASSIFICATION_SCHEMA,
  containsInjectionPhrases,
  EXTRACTION_REQUEST,
  EXTRACTION_SCHEMA,
  fieldsToRequest,
  newDelimiter,
  parseClassificationResponse,
  parseExtractionResponse,
  wrapDocumentText,
  type RawBankMonth,
  type RawField,
} from './prompt.ts';
import { buildSpreadsheetPreview, parseSpreadsheet, readPdfSource, renderSpreadsheetText } from './spreadsheet.ts';
import { MAX_RENDERED_PDF_PAGES, readDocxLines, readPlainTextLines, renderPdfPages } from './textDocuments.ts';
import { classifyLocally } from './localClassifier.ts';
import { extractLocally, LOCAL_OCR_CONFIDENCE, type LocalContent, type LocalExtraction } from './localExtractors.ts';
import { inModelPhase, isOcrAvailable, MAX_OCR_PAGES, OcrError, ocrImages } from './ocr.ts';
import type { DocumentSource } from './validators.ts';

const asParts = (part: Part | Part[]): Part[] => (Array.isArray(part) ? part : [part]);

/** Enough to tell a balance sheet from a bank statement, and much cheaper than the whole sheet. */
const CLASSIFICATION_TEXT_CHARS = 20_000;
/**
 * The model's share of a file's time. jobs.ts allows 300 s of work a file (more for a file that may
 * need OCR); local reading needs the rest.
 */
export const LLM_BUDGET_MS = 150_000;
/**
 * Highest confidence any value from an OCR-read document may carry, whoever extracted it. OCR can
 * misread a digit (738 as 788), and the source check compares against that same OCR text, so it
 * cannot catch the error: such values must always be reviewed. Below the lowest auto-apply threshold.
 */
export const OCR_CONFIDENCE_CAP = LOCAL_OCR_CONFIDENCE;
if (!(OCR_CONFIDENCE_CAP < DOCUMENT_AI_THRESHOLDS.minAutoApply)) {
  throw new Error('OCR_CONFIDENCE_CAP must be below the minimum auto-apply threshold');
}
/** Pages rendered for OCR: no more than OCR will read. */
const OCR_RENDER_PAGES = Math.min(MAX_OCR_PAGES, MAX_RENDERED_PDF_PAGES);
/** After a daily-quota answer the model is not asked again for this long. */
const LLM_QUOTA_PAUSE_MS = 15 * 60 * 1000;
const LOCAL_MODEL = 'local-rules';

const abortError = () => new DOMException('Extraction was aborted.', 'AbortError');

function isEncryptedPdf(bytes: Uint8Array): boolean {
  // Linearised files can hold the trailer near the start, so the whole file is scanned.
  return /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(Buffer.from(bytes).toString('latin1'));
}

// ------------------------------------------------------------------ Model availability

let llmPausedUntil = 0;

/** A configured model that has not reported its daily allowance used up, and fallback not switched off. */
function llmUsable(): boolean {
  if (process.env.DOCUMENT_AI_LLM_FALLBACK?.trim().toLowerCase() === 'off') return false;
  return isLlmConfigured() && Date.now() >= llmPausedUntil;
}

/** Why a file the server could not read itself got no model either. */
function modelUnavailableCode(): ExtractionErrorCode {
  return isLlmConfigured() && Date.now() < llmPausedUntil ? 'llm_quota_exhausted' : 'unreadable_document';
}

function noteLlmFailure(code: ExtractionErrorCode): void {
  if (code === 'llm_quota_exhausted') llmPausedUntil = Date.now() + LLM_QUOTA_PAUSE_MS;
}

// ------------------------------------------------------------------ Reading the file

interface PreparedDocument {
  /** What the local extractors read. Null when the server could read no text at all. */
  content: LocalContent | null;
  fromOcr: boolean;
  /** Text for the local classifier: titles sit at the start. */
  classificationText: string;
  /** Usually one part; a rendered scan is one image part per page. Built only for the model. */
  classificationPart: Part | Part[];
  extractionPart: Part | Part[];
  sheetNames: string[];
  /** What the server read itself, to check every value against. Held in memory only. */
  source: DocumentSource;
  /** Pattern scan hit on text the server read. */
  injectionInText: boolean;
}

function pagesText(pages: ReadonlyArray<readonly string[]>): string {
  return pages.map((lines, index) => `--- Page ${index + 1} ---\n${lines.join('\n')}`).join('\n\n');
}

function hasText(pages: ReadonlyArray<readonly string[]>): boolean {
  return pages.some((lines) => lines.some((line) => line.trim().length > 0));
}

/** Text the server read itself, page by page, as one prompt part. `source` is what values are checked against. */
function prepareText(
  pages: ReadonlyArray<readonly string[]>,
  source: DocumentSource,
  fromOcr = false
): PreparedDocument {
  const promptText = pagesText(pages);
  if (!hasText(pages)) throw new ExtractionError('unreadable_document');
  const delimiter = newDelimiter();
  return {
    content: { kind: 'text', pages },
    fromOcr,
    classificationText: promptText.slice(0, CLASSIFICATION_TEXT_CHARS),
    classificationPart: { text: wrapDocumentText(promptText.slice(0, CLASSIFICATION_TEXT_CHARS), delimiter) },
    extractionPart: { text: wrapDocumentText(promptText, delimiter) },
    sheetNames: [],
    source,
    injectionInText: containsInjectionPhrases(promptText),
  };
}

/** OpenRouter's free vision allowance is the scarce one: it gets text whenever the server has text. */
function modelTakesText(): boolean {
  return activeLlmProvider() === 'openrouter' && openRouterSendsPdfAsText();
}

/** Lines per page from local OCR. Empty when OCR is unavailable or read nothing. */
async function ocr(images: readonly Uint8Array[], signal: AbortSignal): Promise<string[][]> {
  if (images.length === 0) return [];
  try {
    const { pages } = await ocrImages(images.slice(0, MAX_OCR_PAGES), signal);
    return hasText(pages) ? pages : [];
  } catch (error) {
    if (error instanceof OcrError) return [];
    throw error; // an abort
  }
}

/** Nothing the server could read: only a model can look at the file. */
function forModelOnly(
  classificationPart: Part | Part[],
  extractionPart: Part | Part[],
  source: DocumentSource
): PreparedDocument {
  return {
    content: null,
    fromOcr: false,
    classificationText: '',
    classificationPart,
    extractionPart,
    sheetNames: [],
    source,
    injectionInText: false,
  };
}

/**
 * A digital PDF is read from its text layer, so page citations work. A scan has none: its pages are
 * rendered and read by local OCR, and OCR text is then the text values are checked against. A PDF
 * the parser rejected stays `unreadable` for the check (it fails closed), even when OCR reads it.
 */
async function preparePdf(bytes: Uint8Array, signal: AbortSignal): Promise<PreparedDocument> {
  const source = await readPdfSource(bytes, signal);
  const filePart: Part = { inlineData: { mimeType: FILE_KIND_MIME.pdf, data: Buffer.from(bytes).toString('base64') } };
  if (source.kind === 'pdf') {
    const prepared = prepareText(source.pages ?? [source.lines], source);
    return modelTakesText() ? prepared : { ...prepared, classificationPart: filePart, extractionPart: filePart };
  }

  // Pages are rendered only for a reader that will look at them: OCR reads the first
  // OCR_RENDER_PAGES; a vision model (text-only provider otherwise blind to a scan) reads up to
  // MAX_RENDERED_PDF_PAGES, and only those extra pages are rendered, only when it is asked.
  const ocrOn = isOcrAvailable();
  const visionFallback = () => modelTakesText() && llmUsable();
  if (!ocrOn && !visionFallback()) return forModelOnly(filePart, filePart, source);

  const wanted = ocrOn ? OCR_RENDER_PAGES : MAX_RENDERED_PDF_PAGES;
  let images = await renderPdfPages(bytes, signal, wanted);
  if (signal.aborted) throw abortError();
  const pages = ocrOn ? await ocr(images, signal) : [];
  if (pages.length > 0) {
    const checkedAgainst: DocumentSource =
      source.kind === 'no_text' ? { kind: 'pdf', lines: pages.flat(), pages } : source;
    const prepared = prepareText(pages, checkedAgainst, true);
    return modelTakesText() ? prepared : { ...prepared, classificationPart: filePart, extractionPart: filePart };
  }
  if (!modelTakesText()) return forModelOnly(filePart, filePart, source);
  if (visionFallback() && images.length === wanted && wanted < MAX_RENDERED_PDF_PAGES) {
    // Fewer than `wanted` means the document ended or a page failed: nothing more to render.
    const more = await renderPdfPages(bytes, signal, MAX_RENDERED_PDF_PAGES - wanted, wanted + 1);
    if (signal.aborted) throw abortError();
    images = [...images, ...more];
  }
  if (images.length === 0) throw new ExtractionError('unreadable_document');
  const parts: Part[] = images.map((image) => ({ inlineData: { mimeType: 'image/png', data: image.toString('base64') } }));
  return forModelOnly(parts.slice(0, 2), parts, source);
}

async function prepareImage(input: ExtractDocumentInput): Promise<PreparedDocument> {
  const { kind, bytes, signal } = input;
  const imagePart: Part = { inlineData: { mimeType: FILE_KIND_MIME[kind], data: Buffer.from(bytes).toString('base64') } };
  const pages = await ocr([bytes], signal);
  if (pages.length === 0) return forModelOnly(imagePart, imagePart, { kind: 'no_text' });
  const prepared = prepareText(pages, { kind: 'pdf', lines: pages.flat(), pages }, true);
  return modelTakesText() ? prepared : { ...prepared, classificationPart: imagePart, extractionPart: imagePart };
}

async function prepareDocument(input: ExtractDocumentInput): Promise<PreparedDocument> {
  const { kind, bytes, signal } = input;
  if (kind === 'docx' || kind === 'txt') {
    let lines: string[];
    try {
      lines = kind === 'docx' ? await readDocxLines(bytes) : readPlainTextLines(bytes);
    } catch {
      throw new ExtractionError('unreadable_document');
    }
    return prepareText([lines], { kind: 'pdf', lines, pages: [lines] });
  }
  if (kind === 'pdf') return preparePdf(bytes, signal);
  if (kind === 'png' || kind === 'jpeg' || kind === 'webp') return prepareImage(input);

  let text;
  try {
    text = renderSpreadsheetText(await parseSpreadsheet(bytes, kind));
  } catch {
    throw new ExtractionError('unreadable_document');
  }
  if (!text.promptText.trim()) throw new ExtractionError('unreadable_document');

  const delimiter = newDelimiter();
  return {
    content: { kind: 'sheets', fileKind: kind, sheets: text.visibleSheets },
    fromOcr: false,
    classificationText: text.promptText.slice(0, CLASSIFICATION_TEXT_CHARS),
    classificationPart: { text: wrapDocumentText(text.promptText.slice(0, CLASSIFICATION_TEXT_CHARS), delimiter) },
    extractionPart: { text: wrapDocumentText(text.promptText, delimiter) },
    sheetNames: text.visibleSheetNames,
    source: { kind: 'cells', rows: text.sourceRows },
    injectionInText: containsInjectionPhrases(text.scanText),
  };
}

// ------------------------------------------------------------------ Model calls

/** A signal for one model call: the file's own, cut short at the model's budget. */
function llmSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(LLM_BUDGET_MS)]);
}

/** Runs a model call. Returns its value, or the failure code; rejects only when the file's signal aborts. */
async function tryModel<T>(signal: AbortSignal, run: (callSignal: AbortSignal) => Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; code: ExtractionErrorCode }
> {
  try {
    // jobs.ts tells a model timeout apart from a reading (OCR or render) timeout by this phase.
    return { ok: true, value: await inModelPhase(() => run(llmSignal(signal))) };
  } catch (error) {
    if (signal.aborted) throw abortError();
    const code: ExtractionErrorCode =
      error instanceof ExtractionError ? error.code : error instanceof DOMException ? 'llm_timeout' : 'llm_failed';
    noteLlmFailure(code);
    return { ok: false, code };
  }
}

async function classifyWithModel(prepared: PreparedDocument, signal: AbortSignal) {
  const response = await generateJson({
    systemInstruction: buildClassificationInstruction(),
    parts: [...asParts(prepared.classificationPart), { text: CLASSIFICATION_REQUEST }],
    responseSchema: CLASSIFICATION_SCHEMA,
    signal,
  });
  const parsed = parseClassificationResponse(response);
  if (!parsed) throw new ExtractionError('llm_invalid_response');
  if (!parsed.readable) throw new ExtractionError('unreadable_document');
  const confident = parsed.confidence >= DOCUMENT_AI_THRESHOLDS.discardBelow;
  return {
    documentType: confident ? parsed.documentType : ('other' as DocumentType),
    confidence: Math.round(Math.min(Math.max(parsed.confidence, 0), 1) * 100) / 100,
    suspicious: parsed.suspiciousInstructions,
  };
}

async function extractWithModel(prepared: PreparedDocument, documentType: DocumentType, signal: AbortSignal) {
  const response = await generateJson({
    systemInstruction: buildExtractionInstruction(documentType),
    parts: [...asParts(prepared.extractionPart), { text: EXTRACTION_REQUEST }],
    responseSchema: EXTRACTION_SCHEMA,
    signal,
  });
  const extraction = parseExtractionResponse(response);
  if (!extraction) throw new ExtractionError('llm_invalid_response');
  return extraction;
}

/**
 * The fields the eligibility check leans on, per document type: each group needs one value. While
 * every group has a local value the model is not asked, which keeps the free daily quota for files
 * the server cannot read. A type with no entry asks the model whenever nothing was read locally.
 */
const KEY_FIELDS: Partial<Record<DocumentType, ReadonlyArray<readonly string[]>>> = {
  gst_return: [['financialProfile.gstAnnualTurnover']],
  gst_certificate: [['identity.gstin']],
  pan_card: [['identity.pan']],
  credit_report: [
    ['financialProfile.personalCibilScore', 'financialProfile.promoterCibilScore', 'financialProfile.commercialCmrRank'],
  ],
  itr: [['financialProfile.annualRevenue', 'financialProfile.netProfitAfterTax']],
  financial_statement: [
    ['financialProfile.annualRevenue'],
    ['financialProfile.netProfitAfterTax'],
    ['financialProfile.currentAssets'],
    ['financialProfile.currentLiabilities'],
    ['financialProfile.tangibleNetWorth', 'financialProfile.shareholdersEquity'],
  ],
  registration_certificate: [['identity.dateOfEstablishment']],
  loan_application: [['requestedAmount']],
  bank_statement: [],
};

function keyFieldsMissing(documentType: DocumentType, local: LocalExtraction): boolean {
  if (documentType === 'bank_statement') return local.bankMonthlyTotals.length === 0;
  const groups = KEY_FIELDS[documentType];
  const found = new Set(local.fields.map((field) => field.fieldId));
  if (!groups) return found.size === 0;
  return groups.some((group) => !group.some((fieldId) => found.has(fieldId)));
}

// ------------------------------------------------------------------ One file

async function runExtraction(input: ExtractDocumentInput): Promise<DocumentExtractionResult> {
  const { documentId, fileName, kind, bytes, declaredDocumentType, today, signal } = input;

  if (kind === 'pdf' && isEncryptedPdf(bytes)) {
    return { ok: false, documentId, errorCode: 'password_protected' };
  }

  const prepared = await prepareDocument(input);
  if (!prepared.content && !llmUsable()) {
    // Nothing the server could read, and no model to look at it.
    return { ok: false, documentId, errorCode: modelUnavailableCode() };
  }

  // Classification: the declared type, then the file's own title, then the model, else `other`.
  let usedModel = false;
  let suspicious = false;
  let documentType: DocumentType = 'other';
  let classificationConfidence = 0;
  const localType = declaredDocumentType ? null : classifyLocally(prepared.classificationText, fileName);
  if (declaredDocumentType) {
    documentType = declaredDocumentType;
    classificationConfidence = 1;
  } else if (localType) {
    documentType = localType;
    classificationConfidence = 0.9;
  } else if (llmUsable()) {
    const classified = await tryModel(signal, (s) => classifyWithModel(prepared, s));
    if (classified.ok) {
      usedModel = true;
      ({ documentType, confidence: classificationConfidence, suspicious } = classified.value);
    } else if (!prepared.content || !['llm_quota_exhausted', 'llm_not_configured'].includes(classified.code)) {
      return { ok: false, documentId, errorCode: classified.code };
    }
  }

  // Local extraction first.
  const local: LocalExtraction = prepared.content
    ? extractLocally({ documentType, content: prepared.content, fromOcr: prepared.fromOcr })
    : { fields: [], bankMonthlyTotals: [] };
  const localFound = local.fields.length > 0 || local.bankMonthlyTotals.length > 0;

  // The model, only for what is still missing.
  let modelFields: RawField[] = [];
  let modelMonths: RawBankMonth[] = [];
  let modelSuspicious = false;
  const wantsModel = fieldsToRequest(documentType).length > 0 && keyFieldsMissing(documentType, local);
  if (wantsModel && llmUsable()) {
    const extracted = await tryModel(signal, (s) => extractWithModel(prepared, documentType, s));
    if (extracted.ok) {
      usedModel = true;
      const { value } = extracted;
      if (!value.readable && !localFound && !prepared.content) return { ok: false, documentId, errorCode: 'unreadable_document' };
      modelSuspicious = value.suspiciousInstructions;
      const localFieldIds = new Set(local.fields.map((field) => field.fieldId));
      const localMonths = new Set(local.bankMonthlyTotals.map((row) => row.month.trim()));
      // A value read straight from the file wins over the model's reading of the same field.
      modelFields = value.fields.filter((field) => !localFieldIds.has(field.fieldId));
      modelMonths = value.bankMonthlyTotals.filter((row) => !localMonths.has(row.month.trim()));
    } else if (!localFound && !['llm_quota_exhausted', 'llm_not_configured'].includes(extracted.code)) {
      // Nothing was read locally and the model failed in a way a retry can fix: say so.
      return { ok: false, documentId, errorCode: extracted.code };
    } else if (!prepared.content) {
      return { ok: false, documentId, errorCode: extracted.code };
    }
  } else if (!prepared.content && !usedModel) {
    return { ok: false, documentId, errorCode: modelUnavailableCode() };
  }

  const injectionSuspected =
    prepared.injectionInText ||
    suspicious ||
    modelSuspicious ||
    modelFields.some((field) => containsInjectionPhrases(field.snippet));

  const context = {
    documentId,
    fileName,
    documentType,
    kind,
    sheetNames: prepared.sheetNames,
    source: prepared.source,
    injectionSuspected,
    today,
  };
  // Text read by OCR: every value, local or the model's, goes to review (see OCR_CONFIDENCE_CAP).
  const capped = <T extends { confidence: number }>(rows: T[]): T[] =>
    prepared.fromOcr ? rows.map((row) => ({ ...row, confidence: Math.min(row.confidence, OCR_CONFIDENCE_CAP) })) : rows;
  const { fields, droppedLowConfidence } = buildCandidates(capped([...local.fields, ...modelFields]), context);

  return {
    ok: true,
    documentId,
    documentType,
    classificationConfidence,
    fields,
    bankMonthlyTotals: buildBankMonthlyTotals(capped([...local.bankMonthlyTotals, ...modelMonths]), context),
    injectionSuspected,
    droppedLowConfidence,
    model: usedModel ? `${activeModelName()}+${LOCAL_MODEL}` : prepared.fromOcr ? `${LOCAL_MODEL}+ocr` : LOCAL_MODEL,
  };
}

/** Settles when `run` does, or as soon as `signal` fires, even if a reader ignores the signal. */
function untilAborted<T>(run: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    run.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Document failures resolve to `{ ok: false }`. Only an aborted signal rejects. */
export async function extractDocument(input: ExtractDocumentInput): Promise<DocumentExtractionResult> {
  if (input.signal.aborted) throw abortError();
  try {
    return await untilAborted(runExtraction(input), input.signal);
  } catch (error) {
    if (input.signal.aborted) throw abortError();
    // Anything else is reduced to a code here, so no provider or parser text can leave.
    return {
      ok: false,
      documentId: input.documentId,
      errorCode: error instanceof ExtractionError ? error.code : 'llm_failed',
    };
  }
}

export function mergeSessionResults(input: MergeSessionInput): MergeSessionOutput {
  return mergeSession(input);
}

export async function readSpreadsheetPreview(
  bytes: Uint8Array,
  kind: Extract<AcceptedFileKind, 'xlsx' | 'csv'>
): Promise<SpreadsheetPreview> {
  return buildSpreadsheetPreview(await parseSpreadsheet(bytes, kind));
}
