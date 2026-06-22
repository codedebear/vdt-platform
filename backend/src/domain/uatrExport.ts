/**
 * Pure UATR export mapping (QAX-5).
 *
 * Turns a stored QA `TestRun` (scenarios → steps → results + run metadata) into
 * the row arrays of the three meaningful sheets of the company's UATR Excel
 * template — Amendment, Test Scenario Summary, and Detail Test Scenario Summary
 * (the master). This module is **pure** (no Prisma / no SheetJS / no IO) so the
 * mapping rules — status-label vocabulary, scenario roll-up, ordering, date
 * formatting — can be unit tested in isolation; a thin builder in the service
 * layer feeds these arrays to SheetJS to produce the `.xlsx` bytes.
 *
 * The status vocabulary mirrors the template legend: the Detail sheet "Status"
 * column uses the per-step labels (Not Start / In progress / Pass / Fail /
 * Skipped); the Summary sheet "Result" column uses the rolled-up labels
 * (Pass / Fail / In progress / Not Complete / No Run).
 *
 * Sheet headers reproduce the analyzed template columns. If the team wants the
 * exact cell styling/branding of the original workbook, that is a presentation
 * concern layered on top of these rows — the data mapping here is the contract.
 */
import {
  TestStatus,
  ScenarioResult,
  rollUpScenario,
  isExecutionComplete,
} from './qaExecution';

/** A single executed step as it appears on the Detail sheet. */
export interface UatrStepInput {
  order: number;
  stepName: string;
  expectedResult: string;
  status: TestStatus;
  remark?: string | null;
  executedAt?: Date | null;
}

/** One test case (scenario) = a group of step rows on the Detail sheet and a
 * single roll-up row on the Summary sheet. */
export interface UatrScenarioInput {
  no: number;
  topic: string;
  testName: string;
  system?: string | null;
  remark?: string | null;
  /** Stored roll-up; when absent it is recomputed from the step statuses. */
  result?: ScenarioResult | null;
  steps: UatrStepInput[];
}

/** The whole run: drives the Amendment + Summary sheets and groups the Detail rows. */
export interface UatrRunInput {
  projectName: string;
  version: string;
  preparedBy?: string | null;
  reviewedBy?: string | null;
  approvedBy?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  overallResult?: ScenarioResult | null;
  scenarios: UatrScenarioInput[];
  /** When the export is produced (used for the Amendment date / file name). */
  generatedAt: Date;
}

/** A 2-D array of cell values for one worksheet (row-major). */
export type SheetMatrix = (string | number)[][];

/** The three meaningful UATR sheets as plain matrices, ready for SheetJS. */
export interface UatrSheets {
  amendment: SheetMatrix;
  summary: SheetMatrix;
  detail: SheetMatrix;
}

/** Per-step status → the Detail sheet "Status" label (template legend wording). */
export function detailStatusLabel(status: TestStatus): string {
  switch (status) {
    case 'NOT_START':
      return 'Not Start';
    case 'IN_PROGRESS':
      return 'In progress';
    case 'PASS':
      return 'Pass';
    case 'FAIL':
      return 'Fail';
    case 'SKIPPED':
      return 'Skipped';
    default:
      // Exhaustive over TestStatus; defensive fallback keeps the export resilient.
      return String(status);
  }
}

/** Rolled-up result → the Summary sheet "Result" label (template legend wording). */
export function summaryResultLabel(result: ScenarioResult | null | undefined): string {
  switch (result) {
    case 'PASS':
      return 'Pass';
    case 'FAIL':
      return 'Fail';
    case 'IN_PROGRESS':
      return 'In progress';
    case 'NOT_COMPLETE':
      return 'Not Complete';
    case 'NO_RUN':
    case null:
    case undefined:
      return 'No Run';
    default:
      return String(result);
  }
}

/**
 * Coarse "Test status" for the Summary sheet, distinct from the Pass/Fail
 * "Result": whether the run has actually been executed yet.
 *  - every step terminal (Pass/Fail/Skipped) → "Complete"
 *  - some steps started but not all terminal → "In progress"
 *  - nothing executed                        → "Not Run"
 */
export function testStatusLabel(statuses: readonly TestStatus[]): string {
  if (statuses.length > 0 && isExecutionComplete(statuses)) {
    return 'Complete';
  }
  if (statuses.some((s) => s !== 'NOT_START')) {
    return 'In progress';
  }
  return 'Not Run';
}

/** Formats a date as `YYYY-MM-DD` (UTC) for sheet cells; empty string when null. */
export function formatDate(value: Date | null | undefined): string {
  if (!value) {
    return '';
  }
  return value.toISOString().slice(0, 10);
}

/** The effective roll-up for a scenario: the stored value, or recomputed from steps. */
function scenarioResult(scenario: UatrScenarioInput): ScenarioResult {
  if (scenario.result) {
    return scenario.result;
  }
  return rollUpScenario(scenario.steps.map((s) => s.status));
}

/** Sanitizes a string into a file-name-safe token (no spaces / separators). */
function sanitizeToken(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'project';
}

/** Suggested download file name, e.g. `UATR_MyProject_V1.0_2026-06-22.xlsx`. */
export function uatrFileName(run: UatrRunInput): string {
  return `UATR_${sanitizeToken(run.projectName)}_V${sanitizeToken(run.version)}_${formatDate(
    run.generatedAt,
  )}.xlsx`;
}

/** Builds the Amendment (document-history) sheet rows. */
export function buildAmendmentRows(run: UatrRunInput): SheetMatrix {
  return [
    ['Amendment History'],
    [],
    ['Version', 'Date', 'Description', 'Prepared By', 'Reviewed By', 'Approved By'],
    [
      run.version,
      formatDate(run.generatedAt),
      'UATR generated from executed QA run',
      run.preparedBy ?? '',
      run.reviewedBy ?? '',
      run.approvedBy ?? '',
    ],
  ];
}

/** Builds the Test Scenario Summary (roll-up) sheet rows. */
export function buildSummaryRows(run: UatrRunInput): SheetMatrix {
  const header = [
    'Run No',
    'Test Scenario',
    'Test Name',
    'Test Status',
    'Total Step',
    'Responsible Tester',
    'Result',
    'Date',
    'Remark',
  ];
  const tester = run.preparedBy ?? '';
  const rows: SheetMatrix = run.scenarios.map((scenario) => {
    const statuses = scenario.steps.map((s) => s.status);
    return [
      scenario.no,
      scenario.topic,
      scenario.testName,
      testStatusLabel(statuses),
      scenario.steps.length,
      tester,
      summaryResultLabel(scenarioResult(scenario)),
      formatDate(run.finishedAt ?? run.startedAt),
      scenario.remark ?? '',
    ];
  });
  return [header, ...rows];
}

/** Builds the Detail Test Scenario Summary (master) sheet rows — one row per step. */
export function buildDetailRows(run: UatrRunInput): SheetMatrix {
  const header = [
    'No',
    'Topic',
    'Test Name',
    'System',
    'Step Name',
    'Expected Result',
    'Status',
    'Remark',
    'Date',
  ];
  const rows: SheetMatrix = [];
  for (const scenario of run.scenarios) {
    for (const step of scenario.steps) {
      rows.push([
        scenario.no,
        scenario.topic,
        scenario.testName,
        scenario.system ?? '',
        step.stepName,
        step.expectedResult,
        detailStatusLabel(step.status),
        step.remark ?? '',
        formatDate(step.executedAt),
      ]);
    }
  }
  return [header, ...rows];
}

/** Builds all three UATR sheets from a run. */
export function buildUatrSheets(run: UatrRunInput): UatrSheets {
  return {
    amendment: buildAmendmentRows(run),
    summary: buildSummaryRows(run),
    detail: buildDetailRows(run),
  };
}
