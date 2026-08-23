import type {AgentEvent} from '@earendil-works/pi-agent-core';
import type {AgentToolClassification} from '../tools/policy';

export type AgentWorldRevision = {
    pageEpoch: string;
    captureRevision: number;
    freshness: 'missing' | 'dirty' | 'navigation' | 'fresh';
};

export type AgentToolTrace = {
    toolCallId: string;
    toolName: string;
    classification: AgentToolClassification;
    args: unknown;
    startedAt: number;
    endedAt?: number;
    isError?: boolean;
    worldBefore?: AgentWorldRevision | null;
    worldAfter?: AgentWorldRevision | null;
};

export type AgentTraceSnapshot = {
    metrics: {
        turns: number;
        toolCalls: number;
        readCalls: number;
        effectCalls: number;
        failedToolCalls: number;
        postErrorEffectCalls: number;
    };
    tools: AgentToolTrace[];
};

export type AgentTraceCollector = {
    handle: (event: AgentEvent) => Promise<void>;
    snapshot: () => AgentTraceSnapshot;
};

export type AgentTraceCollectorOptions = {
    classifyToolCall: (name: string, args: unknown) => AgentToolClassification;
    readWorldRevision?: () => AgentWorldRevision | null | Promise<AgentWorldRevision | null>;
};

export const createAgentTraceCollector = (options: AgentTraceCollectorOptions): AgentTraceCollector => {
    let turns = 0;
    let toolCalls = 0;
    let readCalls = 0;
    let effectCalls = 0;
    let failedToolCalls = 0;
    let postErrorEffectCalls = 0;
    let sawToolError = false;
    const tools: AgentToolTrace[] = [];
    const active = new Map<string, AgentToolTrace>();
    const readRevision = async () => options.readWorldRevision ? await options.readWorldRevision() : null;

    return {
        handle: async (event) => {
            if (event.type === 'turn_end') {
                turns += 1;
                return;
            }
            if (event.type === 'tool_execution_start') {
                const classification = options.classifyToolCall(event.toolName, event.args);
                const trace: AgentToolTrace = {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    classification,
                    args: structuredClone(event.args),
                    startedAt: Date.now(),
                    worldBefore: await readRevision(),
                };
                toolCalls += 1;
                if (classification === 'read') {
                    readCalls += 1;
                } else {
                    effectCalls += 1;
                    if (sawToolError) {postErrorEffectCalls += 1;}
                }
                active.set(event.toolCallId, trace);
                tools.push(trace);
                return;
            }
            if (event.type !== 'tool_execution_end') {return;}
            const trace = active.get(event.toolCallId);
            if (trace) {
                trace.endedAt = Date.now();
                trace.isError = event.isError;
                trace.worldAfter = await readRevision();
                active.delete(event.toolCallId);
            }
            if (event.isError) {
                failedToolCalls += 1;
                sawToolError = true;
            }
        },
        snapshot: () => structuredClone({
            metrics: {turns, toolCalls, readCalls, effectCalls, failedToolCalls, postErrorEffectCalls},
            tools,
        }),
    };
};
