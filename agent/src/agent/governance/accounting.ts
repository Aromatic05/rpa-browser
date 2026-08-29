import type {AgentTraceSnapshot, AgentToolTrace} from '../trace/collector';
import type {EffectObservation, GovernanceState} from './contracts';

const EMPTY_TRACE: AgentTraceSnapshot = Object.freeze<AgentTraceSnapshot>({
    metrics: {
        turns: 0,
        toolCalls: 0,
        readCalls: 0,
        controlCalls: 0,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    },
    tools: [],
});

export const createGovernanceState = (options: {startedAt: number; initialTrace?: AgentTraceSnapshot}): GovernanceState => ({
    trace: options.initialTrace !== undefined ? structuredClone(options.initialTrace) : structuredClone(EMPTY_TRACE),
    startedAt: options.startedAt,
});

export const withTrace = (state: GovernanceState, trace: AgentTraceSnapshot): GovernanceState => ({
    ...state,
    trace: structuredClone(trace),
});

export const withPendingIrreversible = (state: GovernanceState, effect: EffectObservation): GovernanceState => ({
    ...state,
    pendingIrreversible: structuredClone(effect),
});

export const clearPendingIrreversible = (state: GovernanceState): GovernanceState => ({
    ...state,
    pendingIrreversible: undefined,
});

export const snapshotState = (state: GovernanceState): GovernanceState => structuredClone(state);

export const deriveRecoveryAttempts = (trace: AgentTraceSnapshot): number => {
    let attempts = 0;
    let prevError = false;
    for (const tool of trace.tools) {
        if (prevError && !(tool.isError ?? false)) {
            attempts += 1;
        }
        prevError = tool.isError ?? false;
    }
    return attempts;
};

export const makeToolTrace = (overrides: Partial<AgentToolTrace> & {toolCallId: string}): AgentToolTrace => ({
    toolName: 'browser.click',
    classification: 'effect',
    args: {},
    startedAt: 0,
    ...overrides,
});
