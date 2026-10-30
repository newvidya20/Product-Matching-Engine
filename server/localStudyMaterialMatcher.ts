import fs from 'node:fs';
import path from 'node:path';
import { runTwoStageProductMatching } from './ruleEngine';
import type {
  BorrowerAssessment,
  CategoryEvaluationResult,
  ConfigurableRuleField,
  MatchingEvaluationRecord,
  ProductCategory,
  ProductDocumentRecord,
  RankedSubProductMatch,
  StudyMaterialReferenceDocument,
} from '../src/types/domain.ts';

const REFERENCE_PATH = path.resolve(
  process.cwd(),
  'src',
  'data',
  'study-material-reference.json'
);

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

interface IndexedDocument {
  reference: StudyMaterialReferenceDocument;
  terms: string[];
  frequencies: Map<string, number>;
  titleFrequencies: Map<string, number>;
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (term) => term.length > 1 && !STOP_WORDS.has(term)
  );
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function validateReference(raw: unknown): StudyMaterialReferenceDocument[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      'Local study-material reference is invalid. Run "npm run index:study-material" to rebuild it.'
    );
  }
  return raw.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.id !== 'string' ||
      typeof entry.categoryName !== 'string' ||
      typeof entry.productName !== 'string' ||
      typeof entry.fileName !== 'string' ||
      typeof entry.relativePath !== 'string' ||
      typeof entry.text !== 'string'
    ) {
      throw new Error(
        `Local study-material reference entry ${index + 1} is invalid. Rebuild the reference index.`
      );
    }
    return entry as StudyMaterialReferenceDocument;
  });
}

const referenceDocuments = validateReference(
  JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8')) as unknown
);
export const localStudyMaterialReferenceDocuments = referenceDocuments;
const indexedDocuments: IndexedDocument[] = referenceDocuments.map((reference) => {
  const titleTerms = tokenize(
    `${reference.categoryName} ${reference.productName} ${reference.fileName}`
  );
  const terms = [...titleTerms, ...tokenize(reference.text)];
  const frequencies = new Map<string, number>();
  for (const term of terms) {
    frequencies.set(term, (frequencies.get(term) || 0) + 1);
  }
  const titleFrequencies = new Map<string, number>();
  for (const term of titleTerms) {
    titleFrequencies.set(term, (titleFrequencies.get(term) || 0) + 1);
  }
  return { reference, terms, frequencies, titleFrequencies };
});
const averageDocumentLength =
  indexedDocuments.reduce((sum, document) => sum + document.terms.length, 0) /
  Math.max(1, indexedDocuments.length);

const PURPOSE_ALIASES: Record<string, string[]> = {
  working_capital: ['working capital', 'working-capital', 'working capital requirement'],
  machinery_equipment: ['machinery', 'equipment finance', 'plant and machinery', 'capital equipment'],
  commercial_property: ['commercial property', 'real estate', 'property finance', 'construction finance'],
  invoice_discounting: ['invoice discounting', 'receivable finance', 'receivables financing', 'factoring'],
  debt_consolidation: ['debt consolidation', 'debt restructuring', 'restructuring'],
  project_expansion: ['project finance', 'project expansion', 'infrastructure', 'capex expansion'],
  trade_import_export: ['trade finance', 'import export', 'export finance', 'cross-border trade'],
  general_business: ['business growth', 'general business', 'corporate funding', 'business expansion'],
};

const ENTITY_ALIASES: Record<string, string[]> = {
  individual: ['individual', 'retail borrower', 'self-employed individual'],
  proprietorship: ['proprietorship', 'sole proprietorship'],
  partnership: ['partnership', 'partner-owned firm'],
  llp: ['llp', 'limited liability partnership'],
  private_limited: ['private limited', 'pvt ltd', 'private ltd', 'company'],
  public_limited: ['public limited', 'public ltd'],
  trust_society: ['trust', 'society', 'association'],
};

function formatRuleId(prefix: string, suffix: string): string {
  return `${prefix}-${slug(suffix) || 'rule'}`;
}

function parseNumericThreshold(text: string): number | null {
  const matches = text.match(/(?:minimum|at least|>=|more than|above)\s*(₹|rs\.?|inr\.?|\$)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(crore|cr|lakh|lac|million|mn|thousand|k)?/i);
  if (!matches) return null;

  const [, , amountRaw, unitRaw] = matches;
  const amount = Number(String(amountRaw).replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;

  const unit = (unitRaw || '').toLowerCase();
  if (unit.includes('crore') || unit === 'cr') return amount * 10000000;
  if (unit.includes('lakh') || unit === 'lac') return amount * 100000;
  if (unit.includes('million') || unit === 'mn') return amount * 1000000;
  if (unit.includes('thousand') || unit === 'k') return amount * 1000;
  return amount;
}

function parseYearsThreshold(text: string): number | null {
  const match = text.match(/(?:minimum|at least|>=|more than|above)\s*(\d{1,2})\s*(?:years?|yrs?)/i);
  return match ? Number(match[1]) : null;
}

function deriveStructuredRulesFromText(reference: StudyMaterialReferenceDocument): {
  fundingPurposes: string[];
  suitableBorrowerTypes: string[];
  restrictionsAndExclusions: string[];
  baselineRules: ConfigurableRuleField[];
} {
  const text = reference.text.toLowerCase();

  const fundingPurposes = Object.entries(PURPOSE_ALIASES)
    .filter(([, aliases]) => aliases.some((alias) => text.includes(alias.toLowerCase())))
    .map(([key]) => key);

  const suitableBorrowerTypes = Object.entries(ENTITY_ALIASES)
    .filter(([, aliases]) => aliases.some((alias) => text.includes(alias.toLowerCase())))
    .map(([key]) => key);

  const restrictionsAndExclusions = Array.from(
    new Set(
      ['exclusive to', 'not for', 'restricted to', 'ineligible for', 'exclusions']
        .filter((phrase) => text.includes(phrase))
        .map((phrase) => phrase)
    )
  );

  const rules: ConfigurableRuleField[] = [];
  const addRule = (
    targetField: ConfigurableRuleField['targetField'],
    stage: ConfigurableRuleField['stage'],
    label: string,
    operator: ConfigurableRuleField['operator'],
    expectedValue: string | number | boolean,
    notes: string,
    isMandatory = true
  ) => {
    rules.push({
      id: formatRuleId(reference.id, `${targetField}-${label}`),
      subProductId: `local-${slug(reference.id)}`,
      stage,
      targetField,
      label,
      operator,
      expectedValue,
      isMandatory,
      verificationStatus: 'verified',
      sourceDocId: reference.id,
      extractedByAi: false,
      verifiedBy: 'local-study-material-rule-engine',
      verifiedAt: new Date().toISOString(),
      notes,
    });
  };

  if (fundingPurposes.length > 0) {
    addRule(
      'fundingPurpose',
      'stage1_requirement',
      'Funding purpose match',
      'in_list',
      fundingPurposes.join(','),
      'Derived from product study material use-case language.',
      true
    );
  }

  if (suitableBorrowerTypes.length > 0) {
    addRule(
      'entityType',
      'stage1_requirement',
      'Borrower entity profile',
      'in_list',
      suitableBorrowerTypes.join(','),
      'Derived from borrower eligibility language in the study material.',
      true
    );
  }

  const turnoverThreshold = parseNumericThreshold(text);
  if (turnoverThreshold !== null) {
    addRule(
      'annualTurnoverOrIncome',
      'stage2_eligibility',
      'Minimum annual turnover / income',
      'number_min',
      Math.round(turnoverThreshold),
      'Parsed from minimum turnover language in the source PDF.',
      true
    );
  }

  const vintageThreshold = parseYearsThreshold(text);
  if (vintageThreshold !== null) {
    addRule(
      'businessVintageYears',
      'stage2_eligibility',
      'Minimum business vintage',
      'number_min',
      vintageThreshold,
      'Parsed from minimum operating vintage language in the source PDF.',
      true
    );
  }

  const creditThreshold = text.match(/(?:minimum|at least|>=)\s*(\d{2,3})\s*(?:credit score|cs)/i);
  if (creditThreshold) {
    addRule(
      'creditScore',
      'stage2_eligibility',
      'Minimum credit score',
      'number_min',
      Number(creditThreshold[1]),
      'Parsed from credit-score eligibility language in the source PDF.',
      true
    );
  }

  return {
    fundingPurposes,
    suitableBorrowerTypes,
    restrictionsAndExclusions,
    baselineRules: rules,
  };
}

function makeCatalog(): ProductCategory[] {
  const byCategory = new Map<string, StudyMaterialReferenceDocument[]>();
  for (const document of referenceDocuments) {
    const docs = byCategory.get(document.categoryName) || [];
    docs.push(document);
    byCategory.set(document.categoryName, docs);
  }

  return Array.from(byCategory.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([categoryName, documents], categoryIndex) => {
      const categoryId = `local-${slug(categoryName) || categoryIndex + 1}`;
      const updatedAt = new Date().toISOString();
      const categoryRules = documents.flatMap((document) =>
        deriveStructuredRulesFromText(document).baselineRules
      );
      const categoryPurposes = Array.from(
        new Set(documents.flatMap((document) => deriveStructuredRulesFromText(document).fundingPurposes))
      );
      const categoryBorrowers = Array.from(
        new Set(documents.flatMap((document) => deriveStructuredRulesFromText(document).suitableBorrowerTypes))
      );
      const categoryRestrictions = Array.from(
        new Set(documents.flatMap((document) => deriveStructuredRulesFromText(document).restrictionsAndExclusions))
      );

      return {
        id: categoryId,
        slotNumber: categoryIndex + 1,
        code: `LOCAL-CAT-${String(categoryIndex + 1).padStart(2, '0')}`,
        name: categoryName,
        status: 'active',
        description: `${documents.length} local study-material PDF(s).`,
        studyMaterialStatus: 'configured',
        studyMaterialRef: 'Local project files',
        suitableBorrowerTypes: categoryBorrowers,
        fundingPurposes: categoryPurposes,
        restrictionsAndExclusions: categoryRestrictions,
        sourceDocumentIds: documents.map((document) => document.id),
        attributes: [],
        baselineRules: categoryRules,
        subProducts: documents.map((document, documentIndex) => {
          const documentProfile = deriveStructuredRulesFromText(document);
          return {
            id: `local-${slug(document.id)}`,
            categoryId,
            code: `LOCAL-SP-${String(documentIndex + 1).padStart(3, '0')}`,
            name: document.productName || document.fileName,
            status: 'active',
            verificationStatus: 'verified',
            description: document.text.slice(0, 500).trim(),
            studyMaterialRef: document.fileName,
            suitableBorrowerTypes: documentProfile.suitableBorrowerTypes,
            fundingPurposes: documentProfile.fundingPurposes,
            financialRequirements: [],
            collateralRequirements: [],
            requiredDocuments: [],
            restrictionsAndExclusions: documentProfile.restrictionsAndExclusions,
            sourceDocumentIds: [document.id],
            attributes: [],
            baselineRules: documentProfile.baselineRules,
            isFictionalDemo: false,
            updatedAt,
          };
        }),
        isFictionalDemo: false,
        updatedAt,
      };
    });
}

export const localStudyMaterialCatalog = makeCatalog();

export const localStudyMaterialDocuments: ProductDocumentRecord[] =
  referenceDocuments.map((document) => ({
    id: document.id,
    driveFileId: '',
    fileName: document.fileName,
    mimeType: 'application/pdf',
    webViewLink: '',
    categoryId:
      localStudyMaterialCatalog.find((category) => category.name === document.categoryName)
        ?.id || '',
    subProductId: `local-${slug(document.id)}`,
    extractionStatus: document.text ? 'extracted_draft' : 'error',
    extractedDraft: null,
    uploadedBy: 'Local project reference',
    uploadedAt: '',
  }));

function getPurposeLabel(assessment: BorrowerAssessment): string {
  return (assessment.fundingPurpose || '').replace(/_/g, ' ');
}

function getWeightedQueryTerms(assessment: BorrowerAssessment): Map<string, number> {
  const weights = new Map<string, number>();
  const addTerms = (value: string, weight: number) => {
    for (const term of tokenize(value)) {
      weights.set(term, Math.max(weights.get(term) || 0, weight));
    }
  };
  addTerms(`${assessment.statedPurpose} ${getPurposeLabel(assessment)}`, 2);
  addTerms(assessment.industrySector || '', 1.5);
  return weights;
}

function getDocumentScore(
  document: IndexedDocument,
  queryTerms: Map<string, number>
): number {
  if (queryTerms.size === 0) return 0;
  let score = 0;
  for (const [term, weight] of queryTerms) {
    const termFrequency = document.frequencies.get(term) || 0;
    if (termFrequency === 0) continue;
    const documentFrequency = indexedDocuments.reduce(
      (count, candidate) =>
        count + (candidate.frequencies.has(term) ? 1 : 0),
      0
    );
    const inverseDocumentFrequency = Math.log(
      1 + (indexedDocuments.length - documentFrequency + 0.5) /
        (documentFrequency + 0.5)
    );
    const lengthNormalization =
      0.25 + 0.75 * (document.terms.length / averageDocumentLength);
    score +=
      inverseDocumentFrequency *
      weight *
      ((termFrequency * 2.2) / (termFrequency + 1.2 * lengthNormalization));
    if (document.titleFrequencies.has(term)) {
      score += inverseDocumentFrequency * weight * 3;
    }
  }
  return score;
}

function findEvidence(text: string, queryTerms: Iterable<string>): string {
  const terms = Array.from(queryTerms);
  const sentence = text
    .split(/(?<=[.!?])\s+/)
    .find((part) =>
      terms.some((term) => tokenize(part).includes(term))
    );
  return (sentence || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

export function evaluateLocalStudyMaterialMatch(
  assessment: BorrowerAssessment
): MatchingEvaluationRecord {
  return runTwoStageProductMatching(
    assessment,
    localStudyMaterialCatalog,
    localStudyMaterialDocuments,
    'official_catalog',
    'Local study-material rule engine'
  );
}
