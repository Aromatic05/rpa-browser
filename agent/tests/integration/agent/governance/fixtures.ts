import type {AgentToolTrace, AgentTraceSnapshot} from '../../../../src/agent/trace/collector';
import {makeToolTrace} from '../../../../src/agent/governance/accounting';

export const metrics = (
    overrides: Partial<AgentTraceSnapshot['metrics']> = {},
): AgentTraceSnapshot['metrics'] => ({
    turns: 0,
    toolCalls: 0,
    readCalls: 0,
    controlCalls: 0,
    effectCalls: 0,
    failedToolCalls: 0,
    postErrorEffectCalls: 0,
    ...overrides,
});

export const emptyTrace = (): AgentTraceSnapshot => ({metrics: metrics(), tools: []});

export const traceWith = (
    overrides: {metrics?: Partial<AgentTraceSnapshot['metrics']>; tools?: AgentToolTrace[]} = {},
): AgentTraceSnapshot => ({
    metrics: metrics(overrides.metrics),
    tools: overrides.tools ?? [],
});

export const tool = (overrides: Partial<AgentToolTrace> & {toolCallId: string}): AgentToolTrace =>
    makeToolTrace(overrides);