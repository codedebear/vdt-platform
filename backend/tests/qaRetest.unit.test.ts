/**
 * Unit tests for the pure Full-Retest clone planner (QAX-8). No DB / HTTP.
 */
import {
  planRetestClone,
  RetestSourceScenario,
} from '../src/domain/qaExecution';

const step = (
  order: number,
  artifactSpec: unknown,
  artifactType: 'HTTP' | 'BROWSER' | null = 'HTTP',
) => ({
  order,
  stepName: `step ${order}`,
  expectedResult: `expected ${order}`,
  artifactType,
  artifactSpec,
});

const scenario = (no: number, steps: ReturnType<typeof step>[]): RetestSourceScenario => ({
  no,
  topic: `topic ${no}`,
  testName: `name ${no}`,
  system: no % 2 === 0 ? `sys ${no}` : null,
  remark: null,
  steps,
});

describe('planRetestClone', () => {
  it('clones scenarios + steps preserving artifactSpec, dropping nothing structural', () => {
    const src = [
      scenario(1, [step(1, { kind: 'HTTP', request: { method: 'GET', path: '/a' } })]),
      scenario(2, [
        step(1, { kind: 'BROWSER', actions: [] }, 'BROWSER'),
        step(2, { kind: 'HTTP', request: { method: 'POST', path: '/b' } }),
      ]),
    ];
    const plan = planRetestClone(src);

    expect(plan.totalSteps).toBe(3);
    expect(plan.uncompiledSteps).toBe(0);
    expect(plan.scenarios).toHaveLength(2);
    expect(plan.scenarios[0]).toEqual({
      no: 1,
      topic: 'topic 1',
      testName: 'name 1',
      system: null,
      remark: null,
      steps: [
        {
          order: 1,
          stepName: 'step 1',
          expectedResult: 'expected 1',
          artifactType: 'HTTP',
          artifactSpec: { kind: 'HTTP', request: { method: 'GET', path: '/a' } },
        },
      ],
    });
    expect(plan.scenarios[1].steps[0].artifactType).toBe('BROWSER');
  });

  it('sorts scenarios by no and steps by order deterministically', () => {
    const src = [
      scenario(2, [step(2, { k: 2 }), step(1, { k: 1 })]),
      scenario(1, [step(1, { k: 1 })]),
    ];
    const plan = planRetestClone(src);
    expect(plan.scenarios.map((s) => s.no)).toEqual([1, 2]);
    expect(plan.scenarios[1].steps.map((s) => s.order)).toEqual([1, 2]);
  });

  it('counts uncompiled (null artifactSpec) steps as retest blockers', () => {
    const src = [
      scenario(1, [step(1, { kind: 'HTTP' }), step(2, null)]),
      scenario(2, [step(1, null)]),
    ];
    const plan = planRetestClone(src);
    expect(plan.totalSteps).toBe(3);
    expect(plan.uncompiledSteps).toBe(2);
  });

  it('reports zero steps for an empty source', () => {
    const plan = planRetestClone([]);
    expect(plan.totalSteps).toBe(0);
    expect(plan.uncompiledSteps).toBe(0);
    expect(plan.scenarios).toEqual([]);
  });

  it('does not mutate the source arrays', () => {
    const src = [scenario(2, [step(2, {}), step(1, {})])];
    const before = JSON.stringify(src);
    planRetestClone(src);
    expect(JSON.stringify(src)).toBe(before);
  });
});
