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
import { buildBankMonthlyTotals, buildCandidates, buildGstReturnPeriods, mergeSession } from './merge.ts';
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
import { buildSpreadsheetPreview, pagesWithoutText, parseSpreadsheet, readPdfText, renderSpreadsheetText } from './spreadsheet.ts';
import { MAX_RENDERED_PDF_PAGES, readDocxLines, readPlainTextLines, renderPdfPageNumbers, renderPdfPages } from './textDocuments.ts';
import { classifyLocally } from './localClassifier.ts';
import { extractLocally, LOCAL_OCR_CONFIDENCE, type LocalContent, type LocalExtraction } from './localExtractors.ts';
import {
  currentExtractionObserver,
  inModelPhase,
  isOcrAvailable,
  MAX_OCR_PAGES,
  OcrError,
  ocrImages,
  type OcrPagesResult,
} from './ocr.ts';
import type { DocumentSource } from './validators.ts';

const asParts = (part: Part | Part[]): Part[] => (Array.isArray(part) ? part : [part]);
/** Base64 of the bytes without first copying them into a second buffer. */
const toBase64 = (bytes: Uint8Array): string =>
  (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).toString('base64');

/** Enough to tell a balance sheet from a bank statement, and much cheaper than the whole sheet. */
const CLASSIFICATION_TEXT_CHARS = 20_000;
/**
 * The model's share of a file's time. jobs.ts allows 300 s of work a file (more for a file that may
 * need OCR); local reading needs the rest.
 */
export const LLM_BUDGET_MS = 150_000;
/** Time kept back from a model call to finish the file with its local values if the call times out. */
export const MODEL_WRAP_UP_MS = 5_000;
/** A model call with less time than this is not started: it could not finish. */
export const MIN_MODEL_CALL_MS = 1_000;
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

const ENCRYPT_MARK = /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/;
/** Window for the encryption scan; consecutive windows overlap, so a mark across a seam is seen. */
const ENCRYPT_SCAN_WINDOW = 1024 * 1024;
const ENCRYPT_SCAN_OVERLAP = 256;

/**
 * Linearised files can hold the trailer near the start, so the whole file is scanned, but one
 * window at a time: never a whole-file string (a 50 MB PDF would be a 50 MB string per file).
 */
export function isEncryptedPdf(bytes: Uint8Array): boolean {
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const step = ENCRYPT_SCAN_WINDOW - ENCRYPT_SCAN_OVERLAP;
  for (let start = 0; start < view.length; start += step) {
    if (ENCRYPT_MARK.test(view.toString('latin1', start, Math.min(view.length, start + ENCRYPT_SCAN_WINDOW)))) return true;
    if (start + ENCRYPT_SCAN_WINDOW >= view.length) break;
  }
  return false;
}

// ------------------------------------------------------------------ Model availability

let llmPausedUntil = 0;

/**
 * Per-job circuit breaker. Once a model call in a job has timed out, been rate limited past its
 * retries, or hit the daily quota, the model is not asked again for that job for
 * JOB_MODEL_PAUSE_MS. The job's other files then finish with what the server read itself, or fail
 * at once with the code that tripped the breaker, so a job of many files never crawls for hours
 * behind a slow free model.
 */
export const JOB_MODEL_PAUSE_MS = 10 * 60 * 1000;
const BREAKER_CODES: ReadonlySet<ExtractionErrorCode> = new Set(['llm_timeout', 'llm_rate_limited', 'llm_quota_exhausted']);
const jobBreakers = new Map<string, { until: number; code: ExtractionErrorCode }>();

/** Trips the breaker for `jobId` when `code` is a timeout, rate limit or quota failure. jobs.ts calls it too. */
export function noteJobModelFailure(jobId: string | undefined, code: ExtractionErrorCode, now = Date.now()): void {
  if (!jobId || !BREAKER_CODES.has(code)) return;
  for (const [key, entry] of jobBreakers) if (entry.until <= now) jobBreakers.delete(key);
  jobBreakers.set(jobId, { until: now + JOB_MODEL_PAUSE_MS, code });
}

/** The code that tripped this job's breaker, while it is open. */
export function jobModelPaused(jobId: string | undefined, now = Date.now()): ExtractionErrorCode | null {
  if (!jobId) return null;
  const entry = jobBreakers.get(jobId);
  if (!entry) return null;
  if (entry.until <= now) {
    jobBreakers.delete(jobId);
    return null;
  }
  return entry.code;
}

/** A configured model that has not reported its daily allowance used up, and fallback not switched off. */
function llmUsable(jobId?: string): boolean {
  if (process.env.DOCUMENT_AI_LLM_FALLBACK?.trim().toLowerCase() === 'off') return false;
  return isLlmConfigured() && Date.now() >= llmPausedUntil && jobModelPaused(jobId) === null;
}

/** Why a file the server could not read itself got no model either. */
function modelUnavailableCode(jobId?: string): ExtractionErrorCode {
  if (!isLlmConfigured()) return 'unreadable_document';
  if (Date.now() < llmPausedUntil) return 'llm_quota_exhausted';
  return jobModelPaused(jobId) ?? 'unreadable_document';
}

function noteLlmFailure(code: ExtractionErrorCode, jobId?: string): void {
  if (code === 'llm_quota_exhausted') llmPausedUntil = Date.now() + LLM_QUOTA_PAUSE_MS;
  noteJobModelFailure(jobId, code);
}

// ------------------------------------------------------------------ Reading the file

interface PreparedDocument {
  /** What the local extractors read. Null when the server could read no text at all. */
  content: LocalContent | null;
  /** Every page's text came from OCR. */
  fromOcr: boolean;
  /**
   * A PDF with a text layer on some pages and scans on others: the 1-based pages whose text came
   * from OCR. Empty or absent when no page was OCR'd, or when the whole file was (`fromOcr`).
   */
  ocrPages?: ReadonlySet<number>;
  /** Text for the local classifier: titles sit at the start. */
  classificationText: string;
  /**
   * Usually one part; a rendered scan is one image part per page. Built only when the model is
   * actually asked, so a file read locally never holds a base64 copy of itself.
   */
  classificationPart: () => Part | Part[];
  extractionPart: () => Part | Part[];
  sheetNames: string[];
  /** What the server read itself, to check every value against. Held in memory only. */
  source: DocumentSource;
  /** Pattern scan hit on text the server read. */
  injectionInText: boolean;
  /**
   * Pages were left unread (a PDF past PDF_MAX_TEXT_PAGES, or a scan past the OCR page cap). Values
   * still come only from pages that were read; nothing is inferred about the rest.
   */
  partial?: boolean;
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
  if (!hasText(pages)) throw new ExtractionError('unreadable_document');
  const delimiter = newDelimiter();
  // The whole text is built only for the model (lazily) and for the one injection scan here, so
  // it is not held for the life of the file. The classifier gets a copy of its first part only.
  const injectionInText = containsInjectionPhrases(pagesText(pages));
  return {
    content: { kind: 'text', pages },
    fromOcr,
    classificationText: headText(pages, CLASSIFICATION_TEXT_CHARS),
    classificationPart: () => ({ text: wrapDocumentText(pagesText(pages).slice(0, CLASSIFICATION_TEXT_CHARS), delimiter) }),
    extractionPart: () => ({ text: wrapDocumentText(pagesText(pages), delimiter) }),
    sheetNames: [],
    source,
    injectionInText,
  };
}

/**
 * The first `max` characters of pagesText(pages), built from the first pages only, so it is a
 * string of its own and does not keep the whole document's text alive.
 */
function headText(pages: ReadonlyArray<readonly string[]>, max: number): string {
  const head: string[][] = [];
  let length = 0;
  for (const lines of pages) {
    if (length >= max) break;
    head.push([...lines]);
    length += lines.reduce((sum, line) => sum + line.length + 1, 20);
  }
  return pagesText(head).slice(0, max);
}

/** OpenRouter's free vision allowance is the scarce one: it gets text whenever the server has text. */
function modelTakesText(): boolean {
  return activeLlmProvider() === 'openrouter' && openRouterSendsPdfAsText();
}

/** Local OCR of the images, at most MAX_OCR_PAGES. Null when OCR is unavailable. */
async function ocrResult(images: readonly Uint8Array[], signal: AbortSignal): Promise<OcrPagesResult | null> {
  try {
    return await ocrImages(images.slice(0, MAX_OCR_PAGES), signal);
  } catch (error) {
    if (error instanceof OcrError) return null;
    throw error; // an abort
  }
}

/** Lines per page from local OCR. Empty when OCR is unavailable or read nothing. */
async function ocr(images: readonly Uint8Array[], signal: AbortSignal): Promise<string[][]> {
  if (images.length === 0) return [];
  const pages = (await ocrResult(images, signal))?.pages ?? [];
  return hasText(pages) ? pages : [];
}

interface FilledPages {
  pages: string[][];
  /** Pages whose text came from OCR. */
  ocrPages: Set<number>;
  /** A page with no text layer could not be read by OCR (cap, render or OCR failure, OCR off). */
  unread: boolean;
}

/**
 * A PDF whose text layer is good overall can still hold scanned pages: those pages have no
 * meaningful text of their own (pagesWithoutText). Only they are rendered and read by OCR, within
 * the OCR page cap; every other page keeps its text layer, and every page keeps its own number.
 * A page's OCR lines follow whatever text layer it had, so nothing native is ever dropped.
 */
async function ocrPagesWithoutText(
  bytes: Uint8Array,
  signal: AbortSignal,
  textPages: ReadonlyArray<readonly string[]>
): Promise<FilledPages> {
  const pages = textPages.map((lines) => [...lines]);
  const empty = pagesWithoutText(textPages);
  if (empty.length === 0) return { pages, ocrPages: new Set(), unread: false };
  if (!isOcrAvailable()) return { pages, ocrPages: new Set(), unread: true };
  const wanted = empty.slice(0, OCR_RENDER_PAGES);
  const images = await renderPdfPageNumbers(bytes, signal, wanted);
  if (signal.aborted) throw abortError();
  const result = images.length > 0 ? await ocrResult(images, signal) : null;
  const ocrPages = new Set<number>();
  result?.pages.forEach((lines, index) => {
    if (lines.length === 0) return;
    const pageNumber = wanted[index]; // image i is always wanted[i]
    const own = new Set(pages[pageNumber - 1]);
    pages[pageNumber - 1].push(...lines.filter((line) => !own.has(line)));
    ocrPages.add(pageNumber);
  });
  const read = result ? result.pages.length - result.pagesTimedOut : 0;
  return { pages, ocrPages, unread: empty.length > read };
}

/** Nothing the server could read: only a model can look at the file. */
function forModelOnly(
  classificationPart: () => Part | Part[],
  extractionPart: () => Part | Part[],
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
async function preparePdf(bytes: Uint8Array, signal: AbortSignal, jobId?: string): Promise<PreparedDocument> {
  const { source, totalPages, pagesRead } = await readPdfText(bytes, signal);
  const filePart = (): Part => ({ inlineData: { mimeType: FILE_KIND_MIME.pdf, data: toBase64(bytes) } });
  // A read that ran out of time (twice) says nothing about the file being a scan: it is a busy
  // server. It fails as unreadable, which the user can retry, and is never sent to the model or OCR
  // as if it had no text.
  if (source.kind === 'unreadable' && source.reason === 'pdf_read_timeout') throw new ExtractionError('unreadable_document');
  if (source.kind === 'pdf') {
    const filled = await ocrPagesWithoutText(bytes, signal, source.pages ?? [source.lines]);
    // OCR text joins the text the values are checked against, on its own page.
    const checkedAgainst: DocumentSource =
      filled.ocrPages.size > 0 ? { kind: 'pdf', lines: filled.pages.flat(), pages: filled.pages } : source;
    const prepared = {
      ...prepareText(filled.pages, checkedAgainst),
      ocrPages: filled.ocrPages,
      partial: pagesRead < totalPages || filled.unread,
    };
    return modelTakesText() ? prepared : { ...prepared, classificationPart: filePart, extractionPart: filePart };
  }

  // Pages are rendered only for a reader that will look at them: OCR reads the first
  // OCR_RENDER_PAGES; a vision model (text-only provider otherwise blind to a scan) reads up to
  // MAX_RENDERED_PDF_PAGES, and only those extra pages are rendered, only when it is asked.
  const ocrOn = isOcrAvailable();
  const visionFallback = () => modelTakesText() && llmUsable(jobId);
  if (!ocrOn && !visionFallback()) return forModelOnly(filePart, filePart, source);

  const wanted = ocrOn ? OCR_RENDER_PAGES : MAX_RENDERED_PDF_PAGES;
  let images = await renderPdfPages(bytes, signal, wanted);
  if (signal.aborted) throw abortError();
  const pages = ocrOn ? await ocr(images, signal) : [];
  if (pages.length > 0) {
    const checkedAgainst: DocumentSource =
      source.kind === 'no_text' ? { kind: 'pdf', lines: pages.flat(), pages } : source;
    // OCR reads the first pages only. Where the page count is unknown (the parser rejected the
    // file), as many images as were asked for means more may follow.
    const partial = totalPages > 0 ? totalPages > pages.length : images.length >= wanted;
    const prepared = { ...prepareText(pages, checkedAgainst, true), partial };
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
  images = []; // the PNG buffers are no longer needed once encoded
  return forModelOnly(() => parts.slice(0, 2), () => parts, source);
}

async function prepareImage(input: ExtractDocumentInput): Promise<PreparedDocument> {
  const { kind, bytes, signal } = input;
  const imagePart = (): Part => ({ inlineData: { mimeType: FILE_KIND_MIME[kind], data: toBase64(bytes) } });
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
  if (kind === 'pdf') return preparePdf(bytes, signal, input.jobId);
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
    classificationPart: () => ({ text: wrapDocumentText(text.promptText.slice(0, CLASSIFICATION_TEXT_CHARS), delimiter) }),
    extractionPart: () => ({ text: wrapDocumentText(text.promptText, delimiter) }),
    sheetNames: text.visibleSheetNames,
    source: { kind: 'cells', rows: text.sourceRows },
    injectionInText: containsInjectionPhrases(text.scanText),
  };
}

// ------------------------------------------------------------------ Model calls

/**
 * The model's time for one call: its own budget, but never more than the file has left, less a
 * margin to finish the file with what was read locally. Without that, a slow model would run into
 * the file's timer, and the whole file would fail as llm_timeout though local values were read.
 */
export function modelCallBudgetMs(fileRemainingMs: number | undefined): number {
  if (fileRemainingMs === undefined || !Number.isFinite(fileRemainingMs)) return LLM_BUDGET_MS;
  return Math.min(LLM_BUDGET_MS, Math.floor(fileRemainingMs - MODEL_WRAP_UP_MS));
}

/** Runs a model call. Returns its value, or the failure code; rejects only when the file's signal aborts. */
async function tryModel<T>(
  signal: AbortSignal,
  run: (callSignal: AbortSignal) => Promise<T>,
  jobId?: string
): Promise<
  { ok: true; value: T } | { ok: false; code: ExtractionErrorCode }
> {
  const budgetMs = modelCallBudgetMs(currentExtractionObserver()?.remainingMs?.());
  if (budgetMs < MIN_MODEL_CALL_MS) {
    noteJobModelFailure(jobId, 'llm_timeout');
    return { ok: false, code: 'llm_timeout' };
  }
  try {
    // jobs.ts tells a model timeout apart from a reading (OCR or render) timeout by this phase.
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]);
    return { ok: true, value: await inModelPhase(() => run(callSignal)) };
  } catch (error) {
    if (signal.aborted) throw abortError();
    const code: ExtractionErrorCode =
      error instanceof ExtractionError ? error.code : error instanceof DOMException ? 'llm_timeout' : 'llm_failed';
    noteLlmFailure(code, jobId);
    return { ok: false, code };
  }
}

async function classifyWithModel(prepared: PreparedDocument, signal: AbortSignal) {
  const response = await generateJson({
    systemInstruction: buildClassificationInstruction(),
    parts: [...asParts(prepared.classificationPart()), { text: CLASSIFICATION_REQUEST }],
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
    parts: [...asParts(prepared.extractionPart()), { text: EXTRACTION_REQUEST }],
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

/**
 * True when the model should be asked because a key field was not read locally. A GSTR-3B states no
 * annual turnover by design: its Table 3.1 period, once read and checked, is all it can give, so a
 * GSTR-3B read that way never calls the model (`gstPeriodsRead`).
 */
export function keyFieldsMissing(documentType: DocumentType, local: LocalExtraction, gstPeriodsRead = 0): boolean {
  if (documentType === 'bank_statement') return local.bankMonthlyTotals.length === 0;
  if (documentType === 'gst_return' && gstPeriodsRead > 0) return false;
  // An ITR-V prints PAN and name, and no turnover or profit: once its PAN is read there is nothing
  // more the model could honestly add.
  if (
    documentType === 'itr' &&
    local.recognisedForm === 'itr_acknowledgement' &&
    local.fields.some((field) => field.fieldId === 'identity.pan')
  ) {
    return false;
  }
  const groups = KEY_FIELDS[documentType];
  const found = new Set(local.fields.map((field) => field.fieldId));
  if (!groups) return found.size === 0;
  return groups.some((group) => !group.some((fieldId) => found.has(fieldId)));
}

// ------------------------------------------------------------------ One file

async function runExtraction(input: ExtractDocumentInput): Promise<DocumentExtractionResult> {
  const { documentId, fileName, kind, bytes, declaredDocumentType, today, signal, jobId } = input;

  if (kind === 'pdf' && isEncryptedPdf(bytes)) {
    return { ok: false, documentId, errorCode: 'password_protected' };
  }

  const prepared = await prepareDocument(input);
  if (!prepared.content && !llmUsable(jobId)) {
    // Nothing the server could read, and no model to look at it.
    return { ok: false, documentId, errorCode: modelUnavailableCode(jobId) };
  }
  // Set when the model would have been asked but this job's breaker is open.
  let breakerSkipped = false;

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
  } else if (llmUsable(jobId)) {
    const classified = await tryModel(signal, (s) => classifyWithModel(prepared, s), jobId);
    if (classified.ok) {
      usedModel = true;
      ({ documentType, confidence: classificationConfidence, suspicious } = classified.value);
    } else if (!prepared.content || !['llm_quota_exhausted', 'llm_not_configured'].includes(classified.code)) {
      return { ok: false, documentId, errorCode: classified.code };
    }
  } else if (jobModelPaused(jobId)) {
    breakerSkipped = true;
  }

  // Local extraction first.
  const local: LocalExtraction = prepared.content
    ? extractLocally({
        documentType,
        content: prepared.content,
        fromOcr: prepared.fromOcr,
        complete: !prepared.partial,
        ocrPages: prepared.ocrPages,
      })
    : { fields: [], bankMonthlyTotals: [] };
  const context = {
    documentId,
    fileName,
    documentType,
    kind,
    sheetNames: prepared.sheetNames,
    source: prepared.source,
    injectionSuspected: false,
    today,
  };
  // Checked now, so a GSTR-3B whose period was read and verified never calls the model.
  const gstReturnPeriods = buildGstReturnPeriods(local.gstReturnPeriods ?? [], context);
  const localFound = local.fields.length > 0 || local.bankMonthlyTotals.length > 0 || gstReturnPeriods.length > 0;

  // The model, only for what is still missing.
  let modelFields: RawField[] = [];
  let modelMonths: RawBankMonth[] = [];
  let modelSuspicious = false;
  const wantsModel =
    fieldsToRequest(documentType).length > 0 && keyFieldsMissing(documentType, local, gstReturnPeriods.length);
  if (wantsModel && !llmUsable(jobId) && jobModelPaused(jobId)) breakerSkipped = true;
  if (wantsModel && llmUsable(jobId)) {
    const extracted = await tryModel(signal, (s) => extractWithModel(prepared, documentType, s), jobId);
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
    return { ok: false, documentId, errorCode: modelUnavailableCode(jobId) };
  }
  // The breaker kept the model away and the server read nothing itself: fail fast with its code.
  if (breakerSkipped && !usedModel && !localFound) {
    return { ok: false, documentId, errorCode: jobModelPaused(jobId) ?? 'llm_timeout' };
  }

  const injectionSuspected =
    prepared.injectionInText ||
    suspicious ||
    modelSuspicious ||
    modelFields.some((field) => containsInjectionPhrases(field.snippet));

  const checkContext = { ...context, injectionSuspected };
  // Text read by OCR: every value, local or the model's, goes to review (see OCR_CONFIDENCE_CAP).
  // In a PDF with only some pages OCR'd, a local field keeps its confidence only when it was read
  // on a text-layer page. The model's fields, bank months and GST periods are capped: their page is
  // not checked against the value, or they combine lines that may come from an OCR'd page.
  const ocrPages = prepared.ocrPages ?? new Set<number>();
  const anyOcr = prepared.fromOcr || ocrPages.size > 0;
  const cap = <T extends { confidence: number }>(row: T): T => ({ ...row, confidence: Math.min(row.confidence, OCR_CONFIDENCE_CAP) });
  const capped = <T extends { confidence: number }>(rows: T[]): T[] => (anyOcr ? rows.map(cap) : rows);
  const cappedLocal = (rows: RawField[]): RawField[] => {
    if (prepared.fromOcr) return rows.map(cap);
    if (ocrPages.size === 0) return rows;
    return rows.map((row) => (row.page === null || ocrPages.has(row.page) ? cap(row) : row));
  };
  const { fields, droppedLowConfidence } = buildCandidates([...cappedLocal(local.fields), ...capped(modelFields)], checkContext);

  return {
    ok: true,
    documentId,
    documentType,
    classificationConfidence,
    fields,
    bankMonthlyTotals: buildBankMonthlyTotals(capped([...local.bankMonthlyTotals, ...modelMonths]), checkContext),
    ...(gstReturnPeriods.length > 0 ? { gstReturnPeriods: capped(gstReturnPeriods) } : {}),
    injectionSuspected,
    droppedLowConfidence,
    // The audit name also records a partial read, so a reviewer can tell why a field may be missing.
    model: `${usedModel ? `${activeModelName()}+${LOCAL_MODEL}` : anyOcr ? `${LOCAL_MODEL}+ocr` : LOCAL_MODEL}${prepared.partial ? '+partial' : ''}`,
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
