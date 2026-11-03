/**
 * Recognises common Indian lending documents from their own text and file name, so they skip the
 * model's classification call (one request per file instead of two). It answers only when exactly one
 * document type has a strong, specific signal; anything ambiguous returns null and goes to the model.
 */
import type { DocumentType } from '../../src/types/documentAi.ts';

const RULES: Array<{ type: DocumentType; test: (text: string) => boolean }> = [
  {
    type: 'gst_return',
    test: (t) => /\bGSTR[\s-]?(?:1|2A|2B|3B|4|9C?)\b/i.test(t) || /goods and services tax return/i.test(t),
  },
  {
    type: 'gst_certificate',
    test: (t) => /\bREG[\s-]?06\b/i.test(t) || (/certificate of registration/i.test(t) && /\bGSTIN?\b/i.test(t)),
  },
  {
    type: 'bank_statement',
    test: (t) =>
      /(statement of account|account statement|bank statement)/i.test(t) &&
      /(opening balance|closing balance|withdrawal|deposit)/i.test(t),
  },
  {
    type: 'itr',
    test: (t) => /\bITR[\s-]?(?:[1-7]|V)\b/i.test(t) || (/income tax return/i.test(t) && /assessment year/i.test(t)),
  },
  {
    type: 'credit_report',
    test: (t) => /(credit information report|\bCIBIL\b|\bCRIF\b|equifax|experian|commercial credit report)/i.test(t),
  },
  {
    type: 'financial_statement',
    test: (t) => /balance sheet/i.test(t) && /(profit (?:and|&) loss|statement of profit)/i.test(t),
  },
  {
    type: 'registration_certificate',
    test: (t) => /(certificate of incorporation|udyam registration|limited liability partnership agreement|partnership deed)/i.test(t),
  },
  {
    type: 'cma_projection',
    test: (t) => /\bCMA data\b/i.test(t) || /projected balance sheet/i.test(t),
  },
  {
    type: 'loan_application',
    test: (t) => /loan application/i.test(t),
  },
];

/** Looks at the start of the text (where titles are) plus the file name. */
export function classifyLocally(text: string, fileName: string): DocumentType | null {
  const sample = `${fileName.replace(/[_.-]+/g, ' ')}\n${text.slice(0, 6000)}`;
  const matches = RULES.filter((rule) => rule.test(sample)).map((rule) => rule.type);
  return matches.length === 1 ? matches[0] : null;
}
