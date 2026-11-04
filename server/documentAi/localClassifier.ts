/**
 * Recognises common Indian lending documents from their own text and file name, so they skip the
 * model's classification call, and let a file be read with no AI at all. It answers only when exactly
 * one document type has a strong, specific signal; anything ambiguous returns null and goes to the
 * model, or, with no model available, is treated as 'other' (nothing is extracted from it).
 */
import type { DocumentType } from '../../src/types/documentAi.ts';

const RULES: Array<{ type: DocumentType; test: (text: string) => boolean }> = [
  {
    type: 'gst_return',
    // OCR reads 3B as 38 now and then.
    test: (t) =>
      /\bGSTR[\s-]?(?:1|2A|2B|3B?|38|4|9C?)\b/i.test(t) ||
      /goods and services tax return/i.test(t) ||
      /\bGST\s+(?:annual\s+|monthly\s+|quarterly\s+)?return\b/i.test(t),
  },
  {
    type: 'gst_certificate',
    test: (t) => /\bREG[\s-]?06\b/i.test(t) || (/certificate of registration/i.test(t) && /\bGSTIN?\b/i.test(t)),
  },
  {
    type: 'bank_statement',
    test: (t) =>
      (/(statement of account|account statement|bank statement)/i.test(t) &&
        /(opening balance|closing balance|withdrawal|deposit)/i.test(t)) ||
      // A statement that heads its totals `Statement Summary` instead of naming itself.
      (/\bstatement summary\b/i.test(t) && /total deposit amount/i.test(t) && /closing balance/i.test(t)),
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
    type: 'pan_card',
    test: (t) => /permanent account number/i.test(t) && /income tax department/i.test(t),
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
