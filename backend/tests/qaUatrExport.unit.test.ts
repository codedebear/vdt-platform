/**
 * Unit tests for the pure UATR export mapping (QAX-5, domain/uatrExport).
 * No Prisma / SheetJS / IO — exercises label vocabulary, scenario roll-up,
 * ordering, date formatting, and file naming.
 */
import {
  detailStatusLabel,
  summaryResultLabel,
  testStatusLabel,
  formatDate,
  uatrFileName,
  buildAmendmentRows,
  buildSummaryRows,
  buildDetailRows,
  buildUatrSheets,
  UatrRunInput,
} from '../src/domain/uatrExport';

const GENERATED_AT = new Date('2026-06-22T08:30:00.000Z');

function makeRun(overrides: Partial<UatrRunInput> = {}): UatrRunInput {
  return {
    projectName: 'Trade In Plus',
    version: '1.0',
    preparedBy: 'qa.bot',
    startedAt: new Date('2026-06-20T01:00:00.000Z'),
    finishedAt: new Date('2026-06-20T02:00:00.000Z'),
    overallResult: 'PASS',
    generatedAt: GENERATED_AT,
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
            status: 'PASS',
            executedAt: new Date('2026-06-20T01:06:00.000Z'),
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('detailStatusLabel', () => {
  it('maps each TestStatus to its template label', () => {
    expect(detailStatusLabel('NOT_START')).toBe('Not Start');
    expect(detailStatusLabel('IN_PROGRESS')).toBe('In progress');
    expect(detailStatusLabel('PASS')).toBe('Pass');
    expect(detailStatusLabel('FAIL')).toBe('Fail');
    expect(detailStatusLabel('SKIPPED')).toBe('Skipped');
  });
});

describe('summaryResultLabel', () => {
  it('maps each ScenarioResult (and null/undefined) to its template label', () => {
    expect(summaryResultLabel('PASS')).toBe('Pass');
    expect(summaryResultLabel('FAIL')).toBe('Fail');
    expect(summaryResultLabel('IN_PROGRESS')).toBe('In progress');
    expect(summaryResultLabel('NOT_COMPLETE')).toBe('Not Complete');
    expect(summaryResultLabel('NO_RUN')).toBe('No Run');
    expect(summaryResultLabel(null)).toBe('No Run');
    expect(summaryResultLabel(undefined)).toBe('No Run');
  });
});

describe('testStatusLabel', () => {
  it('Complete when every step is terminal', () => {
    expect(testStatusLabel(['PASS', 'FAIL', 'SKIPPED'])).toBe('Complete');
  });
  it('In progress when some started but not all terminal', () => {
    expect(testStatusLabel(['PASS', 'NOT_START'])).toBe('In progress');
    expect(testStatusLabel(['IN_PROGRESS'])).toBe('In progress');
  });
  it('Not Run when nothing executed', () => {
    expect(testStatusLabel(['NOT_START', 'NOT_START'])).toBe('Not Run');
    expect(testStatusLabel([])).toBe('Not Run');
  });
});

describe('formatDate', () => {
  it('formats a Date as YYYY-MM-DD', () => {
    expect(formatDate(new Date('2026-06-22T23:59:59.000Z'))).toBe('2026-06-22');
  });
  it('returns empty string for null/undefined', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });
});

describe('uatrFileName', () => {
  it('builds a sanitized file name with version and date', () => {
    expect(uatrFileName(makeRun())).toBe('UATR_Trade_In_Plus_V1.0_2026-06-22.xlsx');
  });
  it('falls back to "project" when the name has no safe characters', () => {
    expect(uatrFileName(makeRun({ projectName: '   ' }))).toBe('UATR_project_V1.0_2026-06-22.xlsx');
  });
});

describe('buildAmendmentRows', () => {
  it('emits the version row with prepared/reviewed/approved metadata', () => {
    const rows = buildAmendmentRows(
      makeRun({ reviewedBy: 'lead', approvedBy: 'owner' }),
    );
    const header = rows[2];
    const dataRow = rows[3];
    expect(header).toContain('Version');
    expect(dataRow[0]).toBe('1.0');
    expect(dataRow[1]).toBe('2026-06-22');
    expect(dataRow[3]).toBe('qa.bot');
    expect(dataRow[4]).toBe('lead');
    expect(dataRow[5]).toBe('owner');
  });

  it('leaves reviewer/approver blank when not set', () => {
    const rows = buildAmendmentRows(makeRun({ reviewedBy: null, approvedBy: null }));
    expect(rows[3][4]).toBe('');
    expect(rows[3][5]).toBe('');
  });
});

describe('buildSummaryRows', () => {
  it('has a header and one roll-up row per scenario', () => {
    const rows = buildSummaryRows(makeRun());
    expect(rows[0][0]).toBe('Run No');
    expect(rows).toHaveLength(2); // header + 1 scenario
    const row = rows[1];
    expect(row[0]).toBe(1); // Run No
    expect(row[2]).toBe('Valid login'); // Test Name
    expect(row[3]).toBe('Complete'); // Test Status
    expect(row[4]).toBe(2); // Total Step
    expect(row[5]).toBe('qa.bot'); // Responsible Tester
    expect(row[6]).toBe('Pass'); // Result
    expect(row[7]).toBe('2026-06-20'); // Date (finishedAt)
  });

  it('recomputes the result from step statuses when no stored result (a FAIL dominates)', () => {
    const run = makeRun();
    run.scenarios[0].steps[1].status = 'FAIL';
    const rows = buildSummaryRows(run);
    expect(rows[1][6]).toBe('Fail');
  });

  it('uses the stored scenario result when present', () => {
    const run = makeRun();
    run.scenarios[0].result = 'NOT_COMPLETE';
    const rows = buildSummaryRows(run);
    expect(rows[1][6]).toBe('Not Complete');
  });

  it('marks a never-executed scenario No Run / Not Run', () => {
    const run = makeRun();
    run.scenarios[0].steps.forEach((s) => (s.status = 'NOT_START'));
    run.scenarios[0].result = null;
    const rows = buildSummaryRows(run);
    expect(rows[1][3]).toBe('Not Run'); // Test Status
    expect(rows[1][6]).toBe('No Run'); // Result
  });
});

describe('buildDetailRows', () => {
  it('emits a header then one row per step, preserving scenario/step order', () => {
    const rows = buildDetailRows(makeRun());
    expect(rows[0][0]).toBe('No');
    expect(rows).toHaveLength(3); // header + 2 steps
    expect(rows[1][4]).toBe('POST /login'); // first step name
    expect(rows[1][6]).toBe('Pass'); // status label
    expect(rows[1][8]).toBe('2026-06-20'); // executedAt date
    expect(rows[2][4]).toBe('GET /me');
  });

  it('blanks the date for a step with no executedAt', () => {
    const run = makeRun();
    run.scenarios[0].steps[0].executedAt = null;
    const rows = buildDetailRows(run);
    expect(rows[1][8]).toBe('');
  });
});

describe('buildUatrSheets', () => {
  it('returns all three sheets', () => {
    const sheets = buildUatrSheets(makeRun());
    expect(sheets.amendment.length).toBeGreaterThan(0);
    expect(sheets.summary.length).toBe(2);
    expect(sheets.detail.length).toBe(3);
  });
});
