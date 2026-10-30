import { GoogleGenAI, Type } from '@google/genai';
import JSZip from 'jszip';
import type { ExtractedPdfDraft } from '../src/types/domain.ts';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server. Configure it in the Secrets panel to run study material policy extraction.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16) || 32)
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10) || 32)
    );
}

function stripXmlToReadableText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<\/(w:p|w:tr|a:p|row|p|br)>/gi, '\n')
      .replace(/<(w:br|br)\s*\/?>/gi, '\n')
      .replace(/<\/(w:tc|c|td|th)>/gi, '\t')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function extractTextFromOpenXmlBase64(
  base64Data: string,
  ext: string
): Promise<string> {
  const zip = await JSZip.loadAsync(Buffer.from(base64Data, 'base64'));
  const fileNames = Object.keys(zip.files).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );

  if (ext === '.docx') {
    const docTargets = fileNames.filter((name) =>
      /^word\/(header\d*|document|footer\d*)\.xml$/i.test(name)
    );
    const chunks: string[] = [];
    for (const target of docTargets) {
      const xml = await zip.files[target].async('string');
      const text = stripXmlToReadableText(xml);
      if (text) chunks.push(text);
    }
    return chunks.join('\n\n');
  }

  if (ext === '.pptx') {
    const slideTargets = fileNames.filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/i.test(name)
    );
    const chunks: string[] = [];
    for (const target of slideTargets) {
      const xml = await zip.files[target].async('string');
      const text = stripXmlToReadableText(xml);
      if (text) chunks.push(text);
    }
    return chunks.join('\n\n');
  }

  if (ext === '.xlsx') {
    const sharedStrings: string[] = [];
    if (zip.files['xl/sharedStrings.xml']) {
      const ssXml = await zip.files['xl/sharedStrings.xml'].async('string');
      const siMatches = ssXml.match(/<si[\s>][\s\S]*?<\/si>/gi) || [];
      for (const si of siMatches) {
        sharedStrings.push(stripXmlToReadableText(si));
      }
    }

    const sheetTargets = fileNames.filter((name) =>
      /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)
    );
    const sheetTexts: string[] = [];
    for (const target of sheetTargets) {
      const xml = await zip.files[target].async('string');
      const rowMatches = xml.match(/<row[\s>][\s\S]*?<\/row>/gi) || [];
      const renderedRows: string[] = [];
      for (const rowXml of rowMatches) {
        const cellMatches = rowXml.match(/<c[\s>][\s\S]*?<\/c>/gi) || [];
        const cellVals: string[] = [];
        for (const cellXml of cellMatches) {
          const isShared = /\bt="s"/i.test(cellXml);
          const vMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/i);
          const isMatch = cellXml.match(/<is>([\s\S]*?)<\/is>/i);
          if (isShared && vMatch) {
            const idx = parseInt(vMatch[1].trim(), 10);
            cellVals.push(sharedStrings[idx] ?? vMatch[1].trim());
          } else if (isMatch) {
            cellVals.push(stripXmlToReadableText(isMatch[1]));
          } else if (vMatch) {
            cellVals.push(decodeXmlEntities(vMatch[1].trim()));
          }
        }
        const joined = cellVals.filter(Boolean).join(' | ').trim();
        if (joined) renderedRows.push(joined);
      }
      if (renderedRows.length > 0) {
        sheetTexts.push(`--- Sheet (${target}) ---\n${renderedRows.join('\n')}`);
      }
    }
    return sheetTexts.join('\n\n');
  }

  return '';
}

function inferExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx).toLowerCase() : '';
}

/**
 * Extracts structured financial product specifications and draft eligibility rules
 * directly from a Google Drive study material (PDF, DOCX, XLSX, PPTX, TXT/CSV, or Image)
 * using Gemini. Strictly extracts only facts stated in the document; never invents policies.
 */
export async function extractPolicyDraftFromPdfBase64(
  base64Data: string,
  fileName: string,
  mimeType = 'application/pdf'
): Promise<ExtractedPdfDraft> {
  const ai = getAiClient();
  const ext = inferExtension(fileName);
  const lowerMime = (mimeType || '').toLowerCase();

  let documentPart:
    | { inlineData: { mimeType: string; data: string } }
    | { text: string };

  if (
    ext === '.pdf' ||
    lowerMime === 'application/pdf' ||
    (!ext && !lowerMime)
  ) {
    documentPart = {
      inlineData: {
        mimeType: 'application/pdf',
        data: base64Data,
      },
    };
  } else if (
    ext === '.png' ||
    ext === '.jpg' ||
    ext === '.jpeg' ||
    ext === '.webp' ||
    lowerMime.startsWith('image/')
  ) {
    const resolvedImageMime =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
        ? 'image/webp'
        : lowerMime.startsWith('image/')
        ? lowerMime
        : 'image/jpeg';
    documentPart = {
      inlineData: {
        mimeType: resolvedImageMime,
        data: base64Data,
      },
    };
  } else if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
    const extractedText = await extractTextFromOpenXmlBase64(base64Data, ext);
    if (!extractedText.trim()) {
      throw new Error(
        `No readable text found inside "${fileName}". Ensure the file is not password-protected or empty.`
      );
    }
    documentPart = {
      text: `STUDY MATERIAL DOCUMENT ("${fileName}"):\n\n${extractedText.slice(0, 180000)}`,
    };
  } else if (
    ext === '.txt' ||
    ext === '.csv' ||
    ext === '.md' ||
    lowerMime.startsWith('text/')
  ) {
    const plainText = Buffer.from(base64Data, 'base64').toString('utf-8');
    if (!plainText.trim()) {
      throw new Error(`Study material "${fileName}" is empty.`);
    }
    documentPart = {
      text: `STUDY MATERIAL DOCUMENT ("${fileName}"):\n\n${plainText.slice(0, 180000)}`,
    };
  } else {
    throw new Error(
      `Uploaded "${fileName}" to Google Drive, but automated AI extraction requires .pdf, .docx, .xlsx, .pptx, .txt, .csv, or image format.`
    );
  }

  const systemInstruction = [
    'You are a strict financial policy extraction engine for LoanBazaar.',
    'Analyze ONLY the attached study material document and extract structured product details and candidate eligibility rules.',
    'CRITICAL RULES:',
    '1. NEVER invent, assume, or extrapolate product names, eligibility thresholds, interest rates, or restrictions that are not explicitly written in the document.',
    '2. If a field is not mentioned in the document, return an empty string or empty array.',
    '3. Map borrower entity structures where applicable to standard identifiers when generating structuredRules: individual, proprietorship, partnership, llp, private_limited, public_limited, trust_society.',
    '4. Map funding purposes where applicable to: working_capital, machinery_equipment, commercial_property, invoice_discounting, debt_consolidation, project_expansion, trade_import_export, general_business.',
    '5. Classify each structured rule into stage: "stage1_requirement" (broad borrower type, funding purpose, facility size range) or "stage2_eligibility" (mandatory vintage, turnover, credit score, profitability, GST, collateral, or custom mandatory checks).',
    '6. Valid targetField values ONLY: requestedAmount, requestedTenureMonths, annualTurnoverOrIncome, businessVintageYears, creditScore, existingEmiObligations, profitabilityStatus, gstTaxCompliant, collateralAvailable, collateralValue, entityType, fundingPurpose, industrySector, customAttribute.',
    '7. Valid operator values ONLY: number_min, number_max, boolean_equals, text_equals, in_list, not_in_list, custom_Presence.',
  ].join('\n');

  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: {
      parts: [
        documentPart,
        {
          text: `Extract structured product information and draft eligibility rules from "${fileName}". Do not invent any information absent from the document.`,
        },
      ],
    },
    config: {
      systemInstruction,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          productName: {
            type: Type.STRING,
            description: 'Exact product or sub-product name stated in the document, or empty string.',
          },
          suggestedCategoryName: {
            type: Type.STRING,
            description: 'Parent financial product category stated in the document, or empty string.',
          },
          productDescription: {
            type: Type.STRING,
            description: 'Concise factual summary of the product from the document.',
          },
          suitableBorrowerTypes: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Borrower entity types explicitly eligible in the document.',
          },
          fundingPurposesAndUseCases: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Permitted funding purposes and use cases stated in the document.',
          },
          eligibilityCriteriaText: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Human-readable list of eligibility criteria stated in the document.',
          },
          financialRequirements: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Turnover, income, DSCR, banking, or financial requirements stated in the document.',
          },
          collateralRequirements: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Collateral, security, margin, or guarantee requirements stated in the document.',
          },
          requiredDocuments: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Required KYC, financial, legal, or property documents listed in the document.',
          },
          restrictionsAndExclusions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Negative profiles, restricted industries, or exclusions stated in the document.',
          },
          structuredRules: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                stage: {
                  type: Type.STRING,
                  description: 'stage1_requirement or stage2_eligibility',
                },
                targetField: {
                  type: Type.STRING,
                  description: 'One of the valid targetField identifiers.',
                },
                customKey: {
                  type: Type.STRING,
                  description: 'Custom field key if targetField is customAttribute, else empty string.',
                },
                label: {
                  type: Type.STRING,
                  description: 'Clear rule name citing the document criterion.',
                },
                operator: {
                  type: Type.STRING,
                  description: 'One of: number_min, number_max, boolean_equals, text_equals, in_list, not_in_list, custom_Presence.',
                },
                expectedValue: {
                  type: Type.STRING,
                  description: 'Threshold number, boolean ("true"/"false"), or comma-separated values.',
                },
                isMandatory: {
                  type: Type.BOOLEAN,
                  description: 'True if mandatory eligibility rule.',
                },
                notes: {
                  type: Type.STRING,
                  description: 'Verbatim quote or section context from the document.',
                },
              },
              required: [
                'stage',
                'targetField',
                'label',
                'operator',
                'expectedValue',
                'isMandatory',
                'notes',
              ],
            },
          },
        },
        required: [
          'productName',
          'suggestedCategoryName',
          'productDescription',
          'suitableBorrowerTypes',
          'fundingPurposesAndUseCases',
          'eligibilityCriteriaText',
          'financialRequirements',
          'collateralRequirements',
          'requiredDocuments',
          'restrictionsAndExclusions',
          'structuredRules',
        ],
      },
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('Gemini returned an empty extraction response for this study material.');
  }

  const parsed = JSON.parse(text.trim()) as Omit<ExtractedPdfDraft, 'extractedAt'>;
  return {
    extractedAt: new Date().toISOString(),
    ...parsed,
  };
}
