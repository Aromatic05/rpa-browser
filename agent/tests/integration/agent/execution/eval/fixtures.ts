import type {
    AgentEvalScenario,
    AgentEvalVerification,
} from '../../../../../src/agent/execution/eval/contracts';
import type {
    AgentExecutionMode,
    AgentRunResult,
    AgentRunner,
} from '../../../../../src/agent/execution/types';

export const fixtureProvider = 'fixture';
export const fixtureModel = 'deterministic';

export const makeTraceMetrics = (
    overrides: Partial<AgentRunResult['trace']['metrics']> = {},
): AgentRunResult['trace']['metrics'] => ({
    turns: 1,
    toolCalls: 0,
    readCalls: 0,
    controlCalls: 0,
    effectCalls: 0,
    failedToolCalls: 0,
    postErrorEffectCalls: 0,
    ...overrides,
});

export const makeProgramSummary = (
    effects: NonNullable<AgentRunResult['programs']>[number]['effects'],
    status: NonNullable<AgentRunResult['programs']>[number]['status'] = 'completed',
): NonNullable<AgentRunResult['programs']>[number] => ({
    source: '',
    input: {},
    status,
    effects,
});

export type FixtureBehavior = (mode: AgentExecutionMode) => AgentRunResult;

export const createFixtureRunner = (behavior: FixtureBehavior): AgentRunner => ({
    run: async (request) => behavior(request.executionMode ?? 'program'),
});

const alwaysVerify = (): AgentEvalVerification => ({passed: true});
const neverVerify = (): AgentEvalVerification => ({passed: false, evidence: 'fixture-expected-failure'});

export const successScenario: AgentEvalScenario = {
    version: 1,
    id: 'fixture-success',
    name: 'Deterministic success',
    description: 'Both modes complete without errors or world changes.',
    modes: ['program', 'react-baseline'],
    trials: 3,
    task: {
        id: 'success',
        prompt: 'Set the Name field to Alice and verify.',
        provider: fixtureProvider,
        model: fixtureModel,
        verify: alwaysVerify,
    },
};

export const successRunner = createFixtureRunner((mode) => ({
    provider: fixtureProvider,
    model: fixtureModel,
    text: 'done',
    executionMode: mode,
    trace: {
        metrics: makeTraceMetrics({
            turns: mode === 'program' ? 2 : 3,
            toolCalls: mode === 'program' ? 4 : 2,
            readCalls: 1,
            controlCalls: mode === 'program' ? 3 : 0,
            effectCalls: mode === 'program' ? 0 : 1,
        }),
        tools: [],
    },
    programs: mode === 'program'
        ? [makeProgramSummary([{
            sequence: 1,
            stepName: 'browser.fill',
            status: 'succeeded',
            worldBefore: {pageEpoch: 'page-1', captureRevision: 1},
            worldAfter: {pageEpoch: 'page-1', captureRevision: 2},
        }])]
        : undefined,
}));

export const recoveredFailureScenario: AgentEvalScenario = {
    version: 1,
    id: 'fixture-recovered-failure',
    name: 'Recovered side-effect failure',
    description: 'A world-changing effect fails in program mode and is compensated.',
    modes: ['program', 'react-baseline'],
    trials: 2,
    task: {
        id: 'recovered-failure',
        prompt: 'Fill the field, tolerate a post-mutation fault, and compensate.',
        provider: fixtureProvider,
        model: fixtureModel,
        verify: alwaysVerify,
    },
};

export const recoveredFailureRunner = createFixtureRunner((mode) => ({
    provider: fixtureProvider,
    model: fixtureModel,
    text: 'recovered',
    executionMode: mode,
    trace: {
        metrics: makeTraceMetrics({
            turns: 4,
            toolCalls: 5,
            readCalls: 1,
            controlCalls: 3,
            effectCalls: mode === 'program' ? 0 : 1,
            failedToolCalls: 1,
            postErrorEffectCalls: 0,
        }),
        tools: mode === 'program'
            ? [{toolCallId: '1', toolName: 'debug.rollback', classification: 'control', args: {}, startedAt: 1}]
            : [],
    },
    programs: mode === 'program'
        ? [makeProgramSummary([
            {
                sequence: 1,
                stepName: 'browser.fill',
                status: 'failed',
                worldBefore: {pageEpoch: 'page-1', captureRevision: 1},
                worldAfter: {pageEpoch: 'page-1', captureRevision: 2},
            },
            {
                sequence: 2,
                stepName: 'debug.compensate',
                status: 'succeeded',
                worldBefore: {pageEpoch: 'page-1', captureRevision: 2},
                worldAfter: {pageEpoch: 'page-1', captureRevision: 3},
                compensates: 1,
            },
        ])]
        : undefined,
}));

export const unrecoveredFailureScenario: AgentEvalScenario = {
    version: 1,
    id: 'fixture-unrecovered-failure',
    name: 'Unrecovered world-changing failure',
    description: 'A world-changing effect fails without compensation.',
    modes: ['program'],
    trials: 2,
    task: {
        id: 'unrecovered-failure',
        prompt: 'Attempt a mutation that leaves the world changed and fail.',
        provider: fixtureProvider,
        model: fixtureModel,
        verify: neverVerify,
    },
};

export const unrecoveredFailureRunner = createFixtureRunner(() => ({
    provider: fixtureProvider,
    model: fixtureModel,
    text: 'failed',
    executionMode: 'program',
    trace: {
        metrics: makeTraceMetrics({
            turns: 2,
            toolCalls: 2,
            readCalls: 1,
            controlCalls: 1,
            effectCalls: 0,
            failedToolCalls: 1,
            postErrorEffectCalls: 1,
        }),
        tools: [],
    },
    programs: [makeProgramSummary([
        {
            sequence: 1,
            stepName: 'browser.fill',
            status: 'failed',
            worldBefore: {pageEpoch: 'page-1', captureRevision: 1},
            worldAfter: {pageEpoch: 'page-1', captureRevision: 2},
        },
    ])],
}));

export const fixtureScenarios: ReadonlyArray<{
    scenario: AgentEvalScenario;
    runner: AgentRunner;
}> = [
    {scenario: successScenario, runner: successRunner},
    {scenario: recoveredFailureScenario, runner: recoveredFailureRunner},
    {scenario: unrecoveredFailureScenario, runner: unrecoveredFailureRunner},
];
