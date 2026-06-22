/**
 * Round-trip test for the SheetJS UATR builder (QAX-5, services/uatrWorkbook):
 * build the workbook from a run, then re-open the bytes and assert the three
 * sheet titles and a few key cells survive the encode → decode.
 */
import * as XLSX from 'xlsx';
import { buildUatrWorkbook } from '../src/services/uatrWorkbook';
import { UatrRunInput } from '../src/domain/uatrExport';

const run: UatrRunInput = {
  projectName: 'Trade In Plus',
  version: '1.0',
  preparedBy: 'qa.bot',
  startedAt: new Date('2026-06-20T01:00:00.000Z'),
  finishedAt: new Date('2026-06-20T02:00:00.000Z'),
  overallResult: 'FAIL',
  generatedAt: new Date('2026-06-22T08:30:00.000Z'),
  scenarios: [
    {
      no: 1,
      topic: 'Login',
      testName: 'Valid login',
      system: 'Auth',
      steps: [
        {
          order: 1,
          stepName: 'POST /login',
          expectedResult: '200 + token',
          status: 'PASS',
          executedAt: new Date('2026-06-20T01:05:00.000Z'),
        },
        {
          order: 2,
          stepName: 'GET /me',
          expectedResult: '200 + profile',
          status: 'FAIL',
          executedAt: new Date('2026-06-20T01:06:00.000Z'),
        },
      ],
    },
  ],
};

describe('buildUatrWorkbook', () => {
  it('produces a non-empty .xlsx buffer with the expected file name', () => {
    const wb = buildUatrWorkbook(run);
    expect(wb.filename).toBe('UATR_Trade_In_Plus_V1.0_2026-06-22.xlsx');
    expect(Buffer.isBuffer(wb.buffer)).toBe(true);
    expect(wb.buffer.length).toBeGreaterThan(0);
  });

  it('round-trips: re-opening the bytes yields the three sheets and key cells', () => {
    const { buffer } = buildUatrWorkbook(run);
    const reopened = XLSX.read(buffer, { type: 'buffer' });
    expect(reopened.SheetNames).toEqual([
      'Amendment',
      'Test Scenario Summary',
      'Detail Test Scenario Summary',
    ]);

    const summary = XLSX.utils.sheet_to_json<(string | number)[]>(
      reopened.Sheets['Test Scenario Summary'],
      { header: 1 },
    );
    expect(summary[0][0]).toBe('Run No');
    // One FAIL step dominates the scenario roll-up.
    expect(summary[1][6]).toBe('Fail');

    const detail = XLSX.utils.sheet_to_json<(string | number)[]>(
      reopened.Sheets['Detail Test Scenario Summary'],
      { header: 1 },
    );
    expect(detail[0][0]).toBe('No');
    expect(detail[1][4]).toBe('POST /login');
    expect(detail[2][6]).toBe('Fail');
  });
});
