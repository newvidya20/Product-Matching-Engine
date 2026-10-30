import fs from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

interface StudyMaterialReferenceDocument {
  id: string;
  categoryName: string;
  productName: string;
  fileName: string;
  relativePath: string;
  pageCount: number;
  text: string;
  extractionError?: string;
}

const projectRoot = process.cwd();
const studyMaterialRoot = path.join(projectRoot, 'Study Material');
const outputPath = path.join(
  projectRoot,
  'src',
  'data',
  'study-material-reference.json'
);

async function findPdfFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => findPdfFiles(path.join(directory, entry.name)))
  );
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
    .map((entry) => path.join(directory, entry.name));
  return [...files, ...nested.flat()].sort((a, b) => a.localeCompare(b));
}

function getProductName(fileName: string): string {
  return fileName
    .replace(/\.pdf$/i, '')
    .replace(/\.docx$/i, '')
    .replace(/^what-is[-_ ]*/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractPdfText(filePath: string): Promise<{
  pageCount: number;
  text: string;
}> {
  const data = new Uint8Array(await fs.readFile(filePath));
  const document = await getDocument({ data, useSystemFonts: true }).promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (pageText) pages.push(pageText);
    }
    return { pageCount: document.numPages, text: pages.join('\n') };
  } finally {
    await document.destroy();
  }
}

async function main(): Promise<void> {
  const stat = await fs.stat(studyMaterialRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Local study-material folder not found: ${studyMaterialRoot}`);
  }

  const files = await findPdfFiles(studyMaterialRoot);
  if (files.length === 0) {
    throw new Error(`No PDF files found under ${studyMaterialRoot}`);
  }

  const documents: StudyMaterialReferenceDocument[] = [];
  let failedCount = 0;
  for (let index = 0; index < files.length; index += 1) {
    const filePath = files[index];
    const relativePath = path.relative(studyMaterialRoot, filePath);
    const pathParts = relativePath.split(path.sep);
    const fileName = path.basename(filePath);
    const entry: StudyMaterialReferenceDocument = {
      id: relativePath.split(path.sep).join('/'),
      categoryName: pathParts.length > 1 ? pathParts[0] : 'Uncategorized',
      productName: getProductName(fileName),
      fileName,
      relativePath: relativePath.split(path.sep).join('/'),
      pageCount: 0,
      text: '',
    };

    try {
      const extracted = await extractPdfText(filePath);
      entry.pageCount = extracted.pageCount;
      entry.text = extracted.text;
      if (!entry.text) {
        entry.extractionError = 'No selectable text found; the PDF may be image-only.';
        failedCount += 1;
      }
    } catch (error) {
      entry.extractionError =
        error instanceof Error ? error.message : 'PDF text extraction failed.';
      failedCount += 1;
    }
    documents.push(entry);
    console.log(`[${index + 1}/${files.length}] ${relativePath}`);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(documents)}\n`, 'utf8');
  console.log(
    `Indexed ${documents.length} PDFs; ${failedCount} need review. Reference saved to ${path.relative(projectRoot, outputPath)}.`
  );
  if (failedCount > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
