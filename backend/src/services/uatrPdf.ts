/**
 * PDF "Test Result Report" builder (QAX-7C) — the single sign-off deliverable.
 *
 * Renders the full UATR information as a PDF: the Amendment (document history +
 * sign-off), the Test Scenario Summary table, and per-scenario Detail blocks. Each
 * step shows its result and, inline, its evidence: a BROWSER step's screenshot
 * (scaled to the content width) or an HTTP step's captured Request / Response.
 *
 * This is the only place that touches pdfkit; all label/roll-up rules are reused
 * from the pure domain module (domain/uatrExport) so they stay unit-tested and the
 * PDF/Excel outputs agree. The report is generated on demand from the stored,
 * immutable results — no blob persistence, byte-stable per run.
 */
import PDFDocument from 'pdfkit';
import {
  UatrRunInput,
  buildSummaryRows,
  detailStatusLabel,
  summaryResultLabel,
  formatDate,
  uatrFileName,
} from '../domain/uatrExport';

/** The evidence captured for one step, keyed by `${scenarioNo}.${stepOrder}`. */
export interface PdfStepEvidence {
  artifactType: 'HTTP' | 'BROWSER' | null;
  /** Inline bytes: a screenshot (BROWSER) or the response capture text (HTTP). */
  evidence?: Buffer | null;
  evidenceMime?: string | null;
  /** Pre-rendered HTTP request (method/path/headers/body), for HTTP steps. */
  httpRequestText?: string | null;
}

/** pdfkit exposes openImage() at runtime but @types/pdfkit omits it — narrow it. */
interface OpenableDoc {
  openImage(src: Buffer): { width: number; height: number };
}

/** A built report ready to stream to the client. */
export interface UatrPdf {
  filename: string;
  buffer: Buffer;
}

const PAGE = { margin: 50 } as const;
const COLORS = { text: '#1f2937', muted: '#6b7280', border: '#d1d5db', head: '#374151' };

/** The drawable content width for the current page. */
function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/** Adds a page if `needed` points don't fit before the bottom margin. */
function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

/** Draws a bordered, wrapping table (header row + data rows) at the current y. */
function drawTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: (string | number)[][],
  colWidths: number[],
): void {
  const startX = doc.page.margins.left;
  const fontSize = 7.5;
  doc.fontSize(fontSize);

  const rowHeight = (cells: (string | number)[]): number => {
    let max = 0;
    cells.forEach((c, i) => {
      const h = doc.heightOfString(String(c ?? ''), { width: colWidths[i] - 6 });
      if (h > max) max = h;
    });
    return max + 6;
  };

  const drawRow = (cells: (string | number)[], bold: boolean): void => {
    const h = rowHeight(cells);
    ensureSpace(doc, h);
    const y = doc.y;
    let x = startX;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
    cells.forEach((c, i) => {
      doc.lineWidth(0.5).rect(x, y, colWidths[i], h).stroke(COLORS.border);
      doc.fillColor(bold ? COLORS.head : COLORS.text).text(String(c ?? ''), x + 3, y + 3, {
        width: colWidths[i] - 6,
      });
      x += colWidths[i];
    });
    doc.y = y + h;
  };

  drawRow(headers, true);
  rows.forEach((r) => drawRow(r, false));
  // Cells are drawn at explicit x positions, which leaves doc.x at the last
  // column. Reset it so following text flows full-width from the left margin.
  doc.x = startX;
  doc.font('Helvetica').fillColor(COLORS.text);
}

/** Section heading. */
function heading(doc: PDFKit.PDFDocument, text: string, size = 12): void {
  ensureSpace(doc, size + 14);
  doc.x = doc.page.margins.left;
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(size).fillColor(COLORS.text).text(text);
  doc.font('Helvetica').fillColor(COLORS.text).fontSize(9);
  doc.moveDown(0.2);
}

/** A "label: value" line. */
function field(doc: PDFKit.PDFDocument, label: string, value: string): void {
  doc.fontSize(9);
  doc.font('Helvetica-Bold').fillColor(COLORS.head).text(`${label}: `, { continued: true });
  doc.font('Helvetica').fillColor(COLORS.text).text(value || '—');
}

/** Renders a step's evidence (screenshot or HTTP request/response) inline. */
function renderEvidence(doc: PDFKit.PDFDocument, ev: PdfStepEvidence | undefined): void {
  if (!ev) return;
  const cw = contentWidth(doc);
  const isImage = !!ev.evidenceMime && ev.evidenceMime.startsWith('image/');

  if (isImage && ev.evidence && ev.evidence.length > 0) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.muted).text('Screenshot:');
    doc.moveDown(0.1);
    try {
      const img = (doc as unknown as OpenableDoc).openImage(ev.evidence);
      const scale = Math.min(cw / img.width, 320 / img.height, 2);
      const w = img.width * scale;
      const h = img.height * scale;
      ensureSpace(doc, h + 8);
      doc.image(ev.evidence, doc.page.margins.left, doc.y, { width: w, height: h });
      doc.y += h + 8;
    } catch {
      // Unreadable image (pdfkit's PNG/JPEG parser rejected it) — note it and move
      // on rather than re-calling doc.image (which would throw again, uncaught).
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text('[screenshot could not be rendered]');
      doc.moveDown(0.2);
    }
    doc.font('Helvetica').fillColor(COLORS.text);
    return;
  }

  // HTTP step (or any text capture): show Request then Response.
  if (ev.httpRequestText) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.muted).text('Request:');
    doc.font('Courier').fontSize(8).fillColor(COLORS.text).text(ev.httpRequestText, { width: cw });
    doc.moveDown(0.2);
  }
  if (ev.evidence && ev.evidence.length > 0) {
    const text = ev.evidence.toString('utf8').slice(0, 8000);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.muted).text('Response:');
    doc.font('Courier').fontSize(8).fillColor(COLORS.text).text(text, { width: cw });
    doc.moveDown(0.2);
  }
  doc.font('Helvetica').fillColor(COLORS.text);
}

/**
 * Builds the UATR PDF report. `evidenceByStep` maps `${scenarioNo}.${stepOrder}`
 * to that step's captured evidence (screenshot / HTTP request+response).
 */
export function buildUatrPdf(
  run: UatrRunInput,
  evidenceByStep: Map<string, PdfStepEvidence>,
): Promise<UatrPdf> {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<UatrPdf>((resolve) => {
    doc.on('end', () => {
      const filename = uatrFileName(run).replace(/\.xlsx$/i, '.pdf');
      resolve({ filename, buffer: Buffer.concat(chunks) });
    });
  });

  // Title + Amendment / sign-off.
  doc.font('Helvetica-Bold').fontSize(16).fillColor(COLORS.text).text('Test Result Report');
  doc.font('Helvetica').fontSize(11).fillColor(COLORS.muted).text(run.projectName);
  doc.moveDown(0.6);
  field(doc, 'Version', run.version);
  field(doc, 'Generated', formatDate(run.generatedAt));
  field(doc, 'Started', formatDate(run.startedAt));
  field(doc, 'Finished', formatDate(run.finishedAt));
  field(doc, 'Overall result', summaryResultLabel(run.overallResult));
  field(doc, 'Prepared by', run.preparedBy ?? '');
  field(doc, 'Reviewed by', run.reviewedBy ?? '');
  field(doc, 'Approved by', run.approvedBy ?? '');

  // Test Scenario Summary (the Excel-style overview table).
  heading(doc, 'Test Scenario Summary');
  const summary = buildSummaryRows(run);
  const cw = contentWidth(doc);
  // 9 columns; widths proportioned to fit the content width.
  const props = [0.07, 0.15, 0.17, 0.1, 0.07, 0.12, 0.09, 0.1, 0.13];
  const colWidths = props.map((p) => Math.floor(p * cw));
  drawTable(doc, summary[0] as string[], summary.slice(1), colWidths);

  // Detail per scenario — each step + its evidence inline.
  heading(doc, 'Detail Test Scenario Summary');
  for (const scenario of run.scenarios) {
    ensureSpace(doc, 40);
    doc.x = doc.page.margins.left;
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLORS.text)
      .text(`#${scenario.no}  ${scenario.testName}`);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text(
        [scenario.topic, scenario.system, summaryResultLabel(scenario.result)]
          .filter(Boolean)
          .join('  ·  '),
      );
    doc.moveDown(0.2);

    for (const step of scenario.steps) {
      ensureSpace(doc, 50);
      doc.x = doc.page.margins.left;
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLORS.text)
        .text(`Step ${step.order}: `, { continued: true })
        .font('Helvetica')
        .text(`${step.stepName}   [${detailStatusLabel(step.status)}]`);
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted);
      doc.text(`Expected: ${step.expectedResult}`, { width: cw });
      const meta = [
        formatDate(step.executedAt) ? `Date: ${formatDate(step.executedAt)}` : '',
        step.remark ? `Remark: ${step.remark}` : '',
      ]
        .filter(Boolean)
        .join('   ');
      if (meta) doc.text(meta, { width: cw });
      doc.moveDown(0.1);
      renderEvidence(doc, evidenceByStep.get(`${scenario.no}.${step.order}`));
      doc.moveDown(0.3);
    }
    doc.moveDown(0.4);
  }

  doc.end();
  return done;
}
