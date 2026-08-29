import type {AgentEvent} from '@earendil-works/pi-agent-core';
import type {AgentToolClassification} from '../tools/policy';
import {REDACTED_SECRET_PLACEHOLDER} from '../report/privacy';
import {createRedactionPolicy, type RedactionPolicy} from '../../security/redaction';

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
        controlCalls: number;
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
    redact?: RedactionPolicy;
};

const SENSITIVE_ARG_KEYS_BY_TOOL: Record<string, readonly string[] | undefined> = {
    'browser.fill': ['value'],
    'browser.type': ['text'],
    'browser.select_option': ['values'],
};

const redactToolCallArgs = (toolName: string, args: unknown, policy: RedactionPolicy): unknown => {
    const keys = SENSITIVE_ARG_KEYS_BY_TOOL[toolName];
    if (keys) {
        const record = args as Record<string, unknown> | null | undefined;
        if (record !== null && typeof record === 'object' && !Array.isArray(record)) {
            const masked: Record<string, unknown> = {...record};
            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(masked, key)) {
                    masked[key] = REDACTED_SECRET_PLACEHOLDER;
                }
            }
            return policy.redact(masked).value;
        }
    }
    return policy.redact(args).value;
};

export const createAgentTraceCollector = (options: AgentTraceCollectorOptions): AgentTraceCollector => {
    const policy = options.redact ?? createRedactionPolicy();
    let turns = 0;
    let toolCalls = 0;
    let readCalls = 0;
    let controlCalls = 0;
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
                    args: redactToolCallArgs(event.toolName, structuredClone(event.args), policy),
                    startedAt: Date.now(),
                    worldBefore: await readRevision(),
                };
                toolCalls += 1;
                if (classification === 'read') {
                    readCalls += 1;
                } else if (classification === 'control') {
                    controlCalls += 1;
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
            metrics: {turns, toolCalls, readCalls, controlCalls, effectCalls, failedToolCalls, postErrorEffectCalls},
            tools,
        }),
    };
};
