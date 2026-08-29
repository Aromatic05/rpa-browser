import type {
    AgentProgramEffectSummary,
    AgentProgramExecutionSummary,
    AgentRunResult,
} from '../../../../src/agent/execution/types';
import type {AgentToolTrace, AgentTraceSnapshot} from '../../../../src/agent/trace/collector';

export const tool = (
    base: Pick<AgentToolTrace, 'toolCallId' | 'toolName' | 'classification' | 'startedAt'>,
    rest?: Partial<AgentToolTrace>,
): AgentToolTrace => {
    const trace: AgentToolTrace = {args: {}, ...base, ...rest};
    return trace.endedAt !== undefined && trace.isError === undefined
        ? {...trace, isError: false}
        : trace;
};

export const traceOf = (
    tools: readonly AgentToolTrace[],
    turns = 1,
): AgentTraceSnapshot => ({
    metrics: {
        turns,
        toolCalls: tools.length,
        readCalls: tools.filter((item) => item.classification === 'read').length,
        controlCalls: tools.filter((item) => item.classification === 'control').length,
        effectCalls: tools.filter((item) => item.classification === 'effect').length,
        failedToolCalls: tools.filter((item) => item.isError === true).length,
        postErrorEffectCalls: 0,
    },
    tools: [...tools],
});

export const effect = (
    base: Pick<AgentProgramEffectSummary, 'sequence' | 'stepName' | 'status'>,
    rest?: Partial<AgentProgramEffectSummary>,
): AgentProgramEffectSummary => ({
    worldBefore: {pageEpoch: 'page-1', captureRevision: 1},
    worldAfter: {pageEpoch: 'page-1', captureRevision: 2},
    ...base,
    ...rest,
});

export const program = (
    base: Pick<AgentProgramExecutionSummary, 'source' | 'status'>,
    rest?: Partial<AgentProgramExecutionSummary>,
): AgentProgramExecutionSummary => ({
    input: {},
    ...base,
    ...rest,
});

export const revision = (captureRevision: number, pageEpoch = 'page-1') =>
    ({pageEpoch, captureRevision});

export const successResult = (): AgentRunResult => ({
    provider: 'faux',
    model: 'model-x',
    text: 'verified',
    executionMode: 'program',
    trace: {
        ...traceOf([
            tool({toolCallId: 't1', toolName: 'browser.snapshot', classification: 'read', startedAt: 100}, {
                endedAt: 110,
                args: {tabName: 'main'},
                worldBefore: {pageEpoch: 'page-1', captureRevision: 1, freshness: 'fresh'},
                worldAfter: {pageEpoch: 'page-1', captureRevision: 1, freshness: 'fresh'},
            }),
            tool({toolCallId: 't2', toolName: 'agent.execute_program', classification: 'control', startedAt: 200}, {
                endedAt: 220,
                args: {source: 'fill order.orderForm.buyer with input.value', input: {value: 'new value'}},
            }),
            tool({toolCallId: 't3', toolName: 'debug.continue', classification: 'control', startedAt: 300}, {endedAt: 305}),
            tool({toolCallId: 't4', toolName: 'browser.snapshot', classification: 'read', startedAt: 400}, {
                endedAt: 430,
                worldBefore: {pageEpoch: 'page-1', captureRevision: 2, freshness: 'fresh'},
                worldAfter: {pageEpoch: 'page-1', captureRevision: 2, freshness: 'fresh'},
            }),
        ], 3),
        context: {
            turns: [
                {turn: 1, chars: 120, bytes: 120},
                {turn: 2, chars: 260, bytes: 268},
                {turn: 3, chars: 400, bytes: 412},
            ],
            lastChars: 400,
            lastBytes: 412,
            peakChars: 400,
            peakBytes: 412,
        },
    },
    programs: [program({
        source: 'fill order.orderForm.buyer with input.value\noutput done = input.done',
        status: 'completed',
    }, {
        materializedSource: 'fill order.orderForm.buyer with input.value\noutput done = input.done',
        input: {value: 'new value', done: true},
        text: '{"done":true}',
        effects: [
            effect({sequence: 1, stepName: 'browser.fill', status: 'succeeded'}),
        ],
    })],
    savedPrograms: [{name: 'order-fill', artifactRevision: 'artifact-rev-3'}],
});

export const compileInvalidResult = (): AgentRunResult => ({
    provider: 'faux',
    model: 'model-x',
    text: 'the program failed to compile',
    executionMode: 'program',
    trace: traceOf([
        tool({toolCallId: 't1', toolName: 'browser.snapshot', classification: 'read', startedAt: 100}, {endedAt: 110}),
        tool({toolCallId: 't2', toolName: 'agent.execute_program', classification: 'control', startedAt: 200}, {
            endedAt: 210,
            isError: true,
            args: {source: 'fill ??? with input.value'},
        }),
    ], 2),
    programs: [program({source: 'fill ??? with input.value', status: 'invalid'}, {
        input: {value: 'x'},
        error: {
            code: 'ERR_DSL_COMPILE',
            message: 'unexpected token in fill statement',
            details: {
                sourceLine: 'fill ??? with input.value',
                scope: {value: 'x', password: 'hunter2'},
            },
        },
    })],
});

export const baselineResult = (): AgentRunResult => ({
    provider: 'faux',
    model: 'model-x',
    text: 'clicked the submit button',
    executionMode: 'react-baseline',
    trace: traceOf([
        tool({toolCallId: 't1', toolName: 'browser.snapshot', classification: 'read', startedAt: 100}, {endedAt: 110}),
        tool({toolCallId: 't2', toolName: 'browser.click', classification: 'effect', startedAt: 200}, {
            endedAt: 240,
            args: {selector: '#submit', sessionToken: 'live-session-secret'},
            worldBefore: {pageEpoch: 'page-9', captureRevision: 4, freshness: 'dirty'},
            worldAfter: {pageEpoch: 'page-9', captureRevision: 5, freshness: 'fresh'},
        }),
    ], 2),
});

export const compensatedRollbackResult = (): AgentRunResult => ({
    provider: 'faux',
    model: 'model-x',
    text: 'rolled back to the savepoint',
    executionMode: 'program',
    trace: traceOf([
        tool({toolCallId: 't1', toolName: 'agent.execute_program', classification: 'control', startedAt: 100}, {endedAt: 110}),
        tool({toolCallId: 't2', toolName: 'debug.rollback', classification: 'control', startedAt: 200}, {endedAt: 260}),
        tool({toolCallId: 't3', toolName: 'debug.abort', classification: 'control', startedAt: 300}, {endedAt: 310}),
    ], 3),
    programs: [program({source: 'fill order.orderForm.buyer with input.value\nclick order.submit', status: 'failed'}, {
        input: {value: 'new value'},
        error: {code: 'ERR_ENSURE_VIOLATED', message: 'postcondition not satisfied'},
        effects: [
            effect({sequence: 1, stepName: 'browser.fill', status: 'succeeded'}, {
                worldBefore: revision(1),
                worldAfter: revision(2),
            }),
            effect({sequence: 2, stepName: 'browser.click', status: 'failed'}, {
                worldBefore: revision(2),
                worldAfter: revision(3),
            }),
            effect({sequence: 3, stepName: 'browser.fill', status: 'succeeded'}, {
                worldBefore: revision(3),
                worldAfter: revision(2),
                compensates: 2,
            }),
            effect({sequence: 4, stepName: 'browser.fill', status: 'succeeded'}, {
                worldBefore: revision(2),
                worldAfter: revision(1),
                compensates: 1,
            }),
        ],
    })],
});

export const verifiedRewindRepairResult = (): AgentRunResult => ({
    provider: 'faux',
    model: 'model-x',
    text: 'verified',
    executionMode: 'program',
    trace: traceOf([
        tool({toolCallId: 't1', toolName: 'agent.execute_program', classification: 'control', startedAt: 100}, {endedAt: 110}),
        tool({toolCallId: 't2', toolName: 'debug.rewind', classification: 'control', startedAt: 200}, {endedAt: 230}),
        tool({toolCallId: 't3', toolName: 'debug.patch_statement', classification: 'control', startedAt: 300}, {endedAt: 320}),
        tool({toolCallId: 't4', toolName: 'debug.recompute', classification: 'control', startedAt: 400}, {endedAt: 410}),
        tool({toolCallId: 't5', toolName: 'debug.continue', classification: 'control', startedAt: 500}, {endedAt: 540}),
        tool({toolCallId: 't6', toolName: 'browser.snapshot', classification: 'read', startedAt: 600}, {
            endedAt: 620,
            worldBefore: {pageEpoch: 'page-1', captureRevision: 3, freshness: 'fresh'},
            worldAfter: {pageEpoch: 'page-1', captureRevision: 3, freshness: 'fresh'},
        }),
    ], 5),
    programs: [program({source: 'fill order.orderForm.buyer with input.value\noutput done = input.done', status: 'completed'}, {
        materializedSource: 'fill order.orderForm.buyer with input.value\noutput done = true',
        input: {value: 'new value', done: true},
        text: '{"done":true}',
        effects: [
            effect({sequence: 1, stepName: 'browser.fill', status: 'succeeded'}, {
                worldBefore: revision(2),
                worldAfter: revision(3),
            }),
        ],
    })],
});
