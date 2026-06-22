/**
 * Thin SheetJS builder (QAX-5): turns the pure UATR row matrices
 * (domain/uatrExport) into the bytes of an `.xlsx` workbook. This is the only
 * place that touches SheetJS; all mapping rules live in the pure domain module
 * so they stay unit-testable. The workbook is generated on demand from the
 * stored results (no blob persistence) — an EXPORTED run is terminal and its
 * results are immutable, so every regeneration is byte-stable.
 */
import * as XLSX from 'xlsx';
import { UatrRunInput, buildUatrSheets, uatrFileName } from '../domain/uatrExport';

/** Worksheet titles, in order. SheetJS caps titles at 31 chars (all fit). */
const SHEET_TITLES = {
  amendment: 'Amendment',
  summary: 'Test Scenario Summary',
  detail: 'Detail Test Scenario Summary',
} as const;

/** A built workbook ready to stream to the client. */
export interface UatrWorkbook {
  filename: string;
  buffer: Buffer;
}

/** Builds the UATR `.xlsx` workbook (Amendment + Summary + Detail sheets). */
export function buildUatrWorkbook(run: UatrRunInput): UatrWorkbook {
  const sheets = buildUatrSheets(run);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets.amendment), SHEET_TITLES.amendment);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets.summary), SHEET_TITLES.summary);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets.detail), SHEET_TITLES.detail);
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return { filename: uatrFileName(run), buffer };
}
