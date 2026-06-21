/**
 * Unit tests for the pure QA-execution state machine + roll-up (QAX-1).
 * No database or HTTP layer involved.
 */
import {
  QA_STAGE_SEQUENCE,
  QaStage,
  advanceStage,
  reviseStage,
  stageIndex,
  isTerminalStage,
  forwardEventFor,
  rollUpScenario,
  rollUpRun,
  isExecutionComplete,
} from '../src/domain/qaExecution';

describe('stage sequence', () => {
  it('defines the six stages in order', () => {
    expect(QA_STAGE_SEQUENCE).toEqual([
      'SCENARIO_DRAFT',
      'STEPS_DRAFT',
      'COMPILED',
      'EXECUTING',
      'RESULTS_REVIEW',
      'EXPORTED',
    ]);
  });

  it('orders stages by index', () => {
    expect(stageIndex('SCENARIO_DRAFT')).toBe(0);
    expect(stageIndex('EXPORTED')).toBe(5);
    expect(stageIndex('COMPILED')).toBeLessThan(stageIndex('EXECUTING'));
  });

  it('marks only EXPORTED as terminal', () => {
    expect(isTerminalStage('EXPORTED')).toBe(true);
    expect(isTerminalStage('RESULTS_REVIEW')).toBe(false);
  });
});

describe('forwardEventFor', () => {
  it('returns the single legal forward event per stage', () => {
    expect(forwardEventFor('SCENARIO_DRAFT')).toBe('CONFIRM_SCENARIOS');
    expect(forwardEventFor('STEPS_DRAFT')).toBe('CONFIRM_STEPS');
    expect(forwardEventFor('COMPILED')).toBe('START_RUN');
    expect(forwardEventFor('EXECUTING')).toBe('EXECUTION_COMPLETE');
    expect(forwardEventFor('RESULTS_REVIEW')).toBe('CONFIRM_RESULTS');
  });

  it('has no forward event from the terminal stage', () => {
    expect(forwardEventFor('EXPORTED')).toBeNull();
  });
});

describe('advanceStage', () => {
  it('walks the full happy path end to end', () => {
    let stage: QaStage = 'SCENARIO_DRAFT';
    stage = advanceStage(stage, 'CONFIRM_SCENARIOS');
    expect(stage).toBe('STEPS_DRAFT');
    stage = advanceStage(stage, 'CONFIRM_STEPS');
    expect(stage).toBe('COMPILED');
    stage = advanceStage(stage, 'START_RUN');
    expect(stage).toBe('EXECUTING');
    stage = advanceStage(stage, 'EXECUTION_COMPLETE');
    expect(stage).toBe('RESULTS_REVIEW');
    stage = advanceStage(stage, 'CONFIRM_RESULTS');
    expect(stage).toBe('EXPORTED');
  });

  it('rejects an event that is illegal from the current stage', () => {
    expect(() => advanceStage('SCENARIO_DRAFT', 'START_RUN')).toThrow(/not allowed from stage/);
    expect(() => advanceStage('COMPILED', 'CONFIRM_SCENARIOS')).toThrow(/expected stage/);
  });
});

describe('reviseStage', () => {
  it('moves back to an earlier stage', () => {
    expect(reviseStage('COMPILED', 'STEPS_DRAFT')).toBe('STEPS_DRAFT');
    expect(reviseStage('RESULTS_REVIEW', 'COMPILED')).toBe('COMPILED');
    expect(reviseStage('STEPS_DRAFT', 'SCENARIO_DRAFT')).toBe('SCENARIO_DRAFT');
  });

  it('refuses to move to the same or a later stage', () => {
    expect(() => reviseStage('STEPS_DRAFT', 'STEPS_DRAFT')).toThrow(/earlier stage/);
    expect(() => reviseStage('STEPS_DRAFT', 'COMPILED')).toThrow(/earlier stage/);
  });

  it('refuses to revise a terminal (EXPORTED) run', () => {
    expect(() => reviseStage('EXPORTED', 'RESULTS_REVIEW')).toThrow(/Cannot revise an EXPORTED run/);
  });
});

describe('rollUpScenario', () => {
  it('returns NO_RUN for no steps or all NOT_START', () => {
    expect(rollUpScenario([])).toBe('NO_RUN');
    expect(rollUpScenario(['NOT_START', 'NOT_START'])).toBe('NO_RUN');
  });

  it('returns IN_PROGRESS when any step is running', () => {
    expect(rollUpScenario(['PASS', 'IN_PROGRESS', 'NOT_START'])).toBe('IN_PROGRESS');
  });

  it('returns NOT_COMPLETE when finished steps coexist with NOT_START', () => {
    expect(rollUpScenario(['PASS', 'NOT_START'])).toBe('NOT_COMPLETE');
    expect(rollUpScenario(['FAIL', 'NOT_START'])).toBe('NOT_COMPLETE');
  });

  it('returns FAIL when all done and any failed', () => {
    expect(rollUpScenario(['PASS', 'FAIL', 'PASS'])).toBe('FAIL');
  });

  it('returns PASS only when every step passed', () => {
    expect(rollUpScenario(['PASS', 'PASS'])).toBe('PASS');
  });
});

describe('rollUpRun', () => {
  it('returns NO_RUN for no scenarios or all NO_RUN', () => {
    expect(rollUpRun([])).toBe('NO_RUN');
    expect(rollUpRun(['NO_RUN', 'NO_RUN'])).toBe('NO_RUN');
  });

  it('returns IN_PROGRESS when any scenario is running', () => {
    expect(rollUpRun(['PASS', 'IN_PROGRESS'])).toBe('IN_PROGRESS');
  });

  it('returns NOT_COMPLETE when a scenario is unfinished but progress exists', () => {
    expect(rollUpRun(['PASS', 'NO_RUN'])).toBe('NOT_COMPLETE');
    expect(rollUpRun(['PASS', 'NOT_COMPLETE'])).toBe('NOT_COMPLETE');
  });

  it('returns FAIL when all complete and any scenario failed', () => {
    expect(rollUpRun(['PASS', 'FAIL'])).toBe('FAIL');
  });

  it('returns PASS only when every scenario passed', () => {
    expect(rollUpRun(['PASS', 'PASS'])).toBe('PASS');
  });
});

describe('isExecutionComplete', () => {
  it('is true only when every step is PASS or FAIL', () => {
    expect(isExecutionComplete(['PASS', 'FAIL'])).toBe(true);
    expect(isExecutionComplete(['PASS', 'NOT_START'])).toBe(false);
    expect(isExecutionComplete(['PASS', 'IN_PROGRESS'])).toBe(false);
    expect(isExecutionComplete([])).toBe(false);
  });
});
