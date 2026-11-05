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
      /\bGST\s+(?:annual\s+|monthly\s+|quarterly\s+)?return\b/i.test(t) ||
      /\b(?:gstr|gst)[\s-]*3b\b/i.test(t) ||
      /\b(?:aug|sep|oct|nov|dec|jan|feb|mar|apr|may|jun|jul)[\s-]*\d{2,4}\s*gstr/i.test(t),
  },
  {
    type: 'gst_certificate',
    test: (t) =>
      /\bREG[\s-]?06\b/i.test(t) ||
      (/certificate of registration/i.test(t) && /\bGSTIN?\b/i.test(t)) ||
      /gst\s+registration\s+(?:certificate|no|number)/i.test(t),
  },
  {
    type: 'bank_statement',
    test: (t) =>
      (/(statement of account|account statement|bank statement)/i.test(t) &&
        /(opening balance|closing balance|withdrawal|deposit)/i.test(t)) ||
      // A statement that heads its totals `Statement Summary` instead of naming itself.
      (/\bstatement summary\b/i.test(t) && /total deposit amount/i.test(t) && /closing balance/i.test(t)) ||
      /(?:axis|sbi|kotak|hdfc|icici|citizencredit|bank)\s+(?:statement|account)/i.test(t) ||
      /\b(?:cc|ca)\s*[-\s]*\d{2}-\d{2}-\d{4}\s*to\s*\d{2}-\d{2}-\d{4}\b/i.test(t),
  },
  {
    type: 'itr',
    test: (t) =>
      /\bITR[\s-]?(?:[1-7]|V)\b/i.test(t) ||
      (/income tax return/i.test(t) && /assessment year/i.test(t)) ||
      /\b26as\b/i.test(t) ||
      /form\s*3ca|form\s*3cb|form\s*3cd/i.test(t),
  },
  {
    type: 'credit_report',
    test: (t) =>
      /(credit information report|\bCIBIL\b|\bCMR\b|\bCRIF\b|equifax|experian|commercial credit report|credit rating report|CARE rating|ICRA rating|CRISIL rating)/i.test(t) ||
      /(?:care|icra|crisil|cibil|cmr)\s+(?:credit|rating|report)/i.test(t) ||
      /\b(?:cibil|cmr|credit report)\s*[-:]\s*\d{1,2}-\d{2}-\d{4}\b/i.test(t),
  },
  {
    type: 'financial_statement',
    test: (t) =>
      /(?:audited|provisional|consolidated)?\s*(?:financial statements?|financial statement)/i.test(t) ||
      /(balance sheet|profit and loss|profit & loss|statement of profit|p\s*&\s*l|p\s*and\s*l)/i.test(t) &&
      /(balance sheet|cash flow|notes to accounts|statement of assets|liabilities|director report)/i.test(t) ||
      /balance sheet/i.test(t) && /(profit (?:and|&) loss|statement of profit|profit\/loss)/i.test(t) ||
      /(?:audit report|auditor.*report|balance sheet|profit and loss|p\s*&\s*l|statement of profit)/i.test(t) ||
      /\b(?:fy|financial year)\s*\d{2,4}[-\s]\d{2,4}\b/i.test(t) && /(?:profit|loss|balance sheet|audit)/i.test(t),
  },
  {
    type: 'existing_sanction_letter',
    test: (t) =>
      /(sanction letter|sanctioned facility|existing debt profile|repayment obligations|outstanding balance|repayment schedule|security details|loan obligation|obligation sheet|existing debt summary)/i.test(t) ||
      /(?:existing\s+)?debt\s+profile/i.test(t) ||
      /(?:sanction|obligation|repayment|renewal)\s+(?:letter|sheet|schedule)/i.test(t) ||
      /\b(?:existing|current)\s+debt\b/i.test(t) && /\b(?:balance|profile|schedule|obligation)\b/i.test(t),
  },
  {
    type: 'registration_certificate',
    test: (t) =>
      /(certificate of incorporation|udyam registration|limited liability partnership agreement|partnership deed|company registration)/i.test(t) ||
      /(?:certificate|incorporation|registration)\s+(?:of|for)\s+(?:company|partnership|llp|society)/i.test(t),
  },
  {
    type: 'cma_projection',
    test: (t) => /\bCMA data\b/i.test(t) || /projected balance sheet/i.test(t) || /detailed project report/i.test(t),
  },
  {
    type: 'pan_card',
    test: (t) => /permanent account number/i.test(t) && /income tax department/i.test(t),
  },
  {
    type: 'loan_application',
    test: (t) =>
      /loan application/i.test(t) ||
      /(?:borrower|customer|applicant|company|corporate)\s+(?:profile|details|summary)/i.test(t) ||
      /(company profile|corporate presentation|pitch deck|investor presentation|business profile|company profile and corporate presentation|borrower profile)/i.test(t) ||
      /\b(?:company|corporate|business|borrower|customer|applicant)\s+(?:presentation|profile)\b/i.test(t) ||
      /\bprofile\b/i.test(t) && /\b(?:company|business|corporate|borrower|customer|applicant)\b/i.test(t),
  },
  {
    type: 'other',
    test: (t) =>
      /(purchase ledger|sales ledger|ledger statement|purchase and sales ledger|sales register|purchase register|sales & purchase register|register)/i.test(t) ||
      /ledger/i.test(t) && /(purchase|sales|stock|debtors|creditors)/i.test(t) ||
      /\b(?:purchase|sales)\s+(?:register|ledger)\b/i.test(t),
  },
];

/** Looks at the start of the text (where titles are) plus the file name. */
export function classifyLocally(text: string, fileName: string): DocumentType | null {
  const fileLabel = fileName.replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sample = `${fileLabel}\n${text.slice(0, 6000)}`;
  const matches = RULES.filter((rule) => rule.test(sample)).map((rule) => rule.type);
  return matches.length === 1 ? matches[0] : null;
}
