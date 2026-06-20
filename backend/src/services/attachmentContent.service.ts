/**
 * Turns a phase run's stored attachments into content the Claude API can read
 * when generating that phase:
 *  - PDFs become `document` blocks (base64) so Claude reads them directly,
 *    including scanned pages via vision — no server-side OCR.
 *  - Spreadsheets (XLSX/XLS), Word (DOCX) and plain text/CSV/Markdown are
 *    extracted to text and appended to the prompt as labelled sections.
 *
 * Office parsers (`xlsx`, `mammoth`) are loaded lazily so the app and its unit
 * tests boot without them; only a real generation that includes such a file
 * pulls them in. Extracted text is capped per file to bound token cost.
 */
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { classifyAttachment, type AttachmentKind } from '../domain/attachments';
import type { DocumentBlock } from './generation.service';

/** A stored attachment with its raw bytes, ready to be prepared for the model. */
export interface RawAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

/** The result of preparing a run's attachments for a generation call. */
export interface PreparedAttachments {
  /** PDF document blocks to attach to the user message. */
  documents: DocumentBlock[];
  /** Labelled text sections (one per non-PDF file) to append to the prompt. */
  textSections: string[];
}

/** Caps a string to `cap` characters, appending a truncation marker if cut. */
export function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated — file longer than ${cap} characters]`;
}

/** Verifies a PDF actually starts with the %PDF- signature. */
function assertPdfMagic(filename: string, data: Buffer): void {
  if (data.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new AppError(`${filename} is not a valid PDF file`, 422);
  }
}

/** Minimal slice of SheetJS used here (so we do not depend on its typings). */
interface XlsxLike {
  read(data: Buffer, opts: { type: 'buffer' }): {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: { sheet_to_csv(sheet: unknown): string };
}

/** Minimal slice of mammoth used here. */
interface MammothLike {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
}

/** Extracts plain text from a spreadsheet (all sheets as CSV) via SheetJS. */
async function extractSpreadsheet(filename: string, data: Buffer): Promise<string> {
  try {
    const mod = 'xlsx';
    const XLSX = (await import(mod)) as unknown as XlsxLike;
    const wb = XLSX.read(data, { type: 'buffer' });
    return wb.SheetNames.map((name) => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      return `# Sheet: ${name}\n${csv}`;
    }).join('\n\n');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`Could not read spreadsheet ${filename}`, 422);
  }
}

/** Extracts plain text from a DOCX via mammoth. */
async function extractDocx(filename: string, data: Buffer): Promise<string> {
  try {
    const mod = 'mammoth';
    const mammoth = (await import(mod)) as unknown as MammothLike;
    const { value } = await mammoth.extractRawText({ buffer: data });
    return value;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`Could not read document ${filename}`, 422);
  }
}

/** Converts one attachment into either a PDF document block or a text section. */
async function prepareOne(
  att: RawAttachment,
  kind: AttachmentKind,
  documents: DocumentBlock[],
  textSections: string[],
): Promise<void> {
  if (kind === 'pdf') {
    assertPdfMagic(att.filename, att.data);
    documents.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: att.data.toString('base64'),
      },
    });
    return;
  }

  let text: string;
  if (kind === 'spreadsheet') {
    text = await extractSpreadsheet(att.filename, att.data);
  } else if (kind === 'document') {
    text = await extractDocx(att.filename, att.data);
  } else {
    text = att.data.toString('utf8');
  }

  textSections.push(
    `### Attached file: ${att.filename}\n${capText(text.trim(), env.attachmentTextCharCap)}`,
  );
}

/**
 * Prepares all of a run's attachments for a generation call. Unsupported types
 * are skipped defensively (uploads already enforce the allow-list). Order is
 * preserved.
 * @throws {AppError} 422 if a file's content cannot be read / is malformed.
 */
export async function prepareAttachments(
  attachments: RawAttachment[],
): Promise<PreparedAttachments> {
  const documents: DocumentBlock[] = [];
  const textSections: string[] = [];

  for (const att of attachments) {
    const kind = classifyAttachment(att.filename, att.mimeType);
    if (!kind) continue;
    await prepareOne(att, kind, documents, textSections);
  }

  return { documents, textSections };
}
