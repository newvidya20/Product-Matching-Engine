/**
 * Recognises common Indian lending documents from their own text and file name, so they skip the
 * model's classification call, and let a file be read with no AI at all. It answers only when exactly
 * one document type has a strong, specific signal; anything ambiguous returns null and goes to the
 * model, or, with no model available, is treated as 'other' (nothing is extracted from it).
 */
import type { DocumentType } from '../../src/types/documentAi.ts';
import { isCreditAnalysisReportTitle } from './creditAnalysisReport.ts';

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

/**
 * Asked only when no rule above matched, so a file those rules already recognise keeps its type.
 * A statement printed as separate pages (a balance sheet alone, a P&L alone, an auditor's report on
 * the financial statements), the borrower's own schedule of existing loans, or an agency rating.
 */
const SECOND_RULES: Array<{ type: DocumentType; test: (text: string) => boolean }> = [
  {
    type: 'financial_statement',
    test: (t) =>
      /\bbalance\s+sheet\s+as\s+(?:at|on)\b/i.test(t) ||
      /\bstatement\s+of\s+profit\s+(?:and|&)\s+loss\b/i.test(t) ||
      /\bprofit\s*(?:and|&)\s*loss\s+(?:account|a\/c|statement)\b/i.test(t) ||
      /\bprovisional\s+(?:balance\s+sheet|p\s*&\s*l\b|profit\s*(?:and|&)\s*loss)/i.test(t) ||
      /\bstatement\s+of\s+assets\s+(?:and|&)\s+liabilities\b/i.test(t) ||
      (/\bindependent\s+auditor['’]?s['’]?\s+report\b/i.test(t) && /\bfinancial\s+statements\b/i.test(t)),
  },
  {
    type: 'credit_rating_report',
    test: (t) =>
      /\b(?:crisil|icra|care\s*(?:ratings|edge)|india\s+ratings|acuit[eé]|brickwork|infomerics)\b/i.test(t) &&
      /\b(?:rating\s+rationale|credit\s+rating|rating\s+action|rating\s+letter|ratings?\s+(?:assigned|reaffirmed))\b/i.test(t),
  },
  {
    type: 'debt_profile',
    test: (t) =>
      (/\b(?:loan|debt)\s+obligations?\b|\bobligation\s+(?:loan\s+)?sheet\b|\bdebt\s+profile\b/i.test(t) ||
        /\b(?:details|schedule|statement)\s+of\s+(?:existing\s+)?(?:loans|borrowings|debts?)\b/i.test(t) ||
        /\bexisting\s+(?:loans|borrowings|debts?)\s+(?:details|profile|schedule|sheet)\b/i.test(t)) &&
      /\b(?:emi|outstanding|instal+ments?)\b/i.test(t),
  },
];

/** The weakest signals: asked only when no rule above matched at all. */
const WEAK_RULES: Array<{ type: DocumentType; test: (text: string) => boolean }> = [
  {
    type: 'sales_purchase_ledger',
    test: (t) =>
      /\b(?:sales|purchases?)\s+(?:register|ledger|report|book|summary)\b|\bmonth[\s-]*wise\s+(?:sales|purchases?)\b/i.test(t),
  },
  {
    type: 'company_profile',
    test: (t) =>
      /\b(?:company|corporate|business|brief)\s+profile\b|\bcorporate\s+presentation\b|\bpitch\s+deck\b|\binvestor\s+presentation\b/i.test(t),
  },
];

/** The one type whose rule matches; null when two match; 'none' when none does. */
function onlyMatch(rules: typeof RULES, sample: string): DocumentType | null | 'none' {
  const matches = rules.filter((rule) => rule.test(sample)).map((rule) => rule.type);
  if (matches.length === 0) return 'none';
  return matches.length === 1 ? matches[0] : null;
}

/** Looks at the start of the text (where titles are) plus the file name. */
export function classifyLocally(text: string, fileName: string): DocumentType | null {
  const sample = `${fileName.replace(/[_.-]+/g, ' ')}\n${text.slice(0, 6000)}`;
  // A credit analysis report names CIBIL, GST and bank statements throughout: its own title on the
  // first page decides, before any rule that would read one of those words as the document's type.
  if (isCreditAnalysisReportTitle(text.slice(0, 1500))) return 'credit_analysis_report';
  for (const rules of [RULES, SECOND_RULES, WEAK_RULES]) {
    const found = onlyMatch(rules, sample);
    if (found !== 'none') return found; // one type, or null when two types match equally
  }
  return null;
}
