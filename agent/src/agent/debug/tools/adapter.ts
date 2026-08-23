import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {DebugQuerySession} from '../query/contracts';
import {
    debugComputeJsonSchema,
    debugQueryJsonSchema,
    type DebugComputeToolInput,
    type DebugQueryToolInput,
} from './schemas';

const stringify = (value: unknown): string => {
    try {return JSON.stringify(value);}
    catch {return String(value);}
};

const result = (details: unknown) => ({
    content: [{type: 'text' as const, text: stringify(details)}],
    details,
});

const failed = (details: {error: {code: string; message: string}}): never => {
    throw new Error(stringify(details));
};

export const createDebugQueryAgentTools = (session: DebugQuerySession): AgentTool[] => [
    {
        name: 'debug.world',
        label: 'debug.world',
        description: 'Read the descriptor of the pinned WorldView. This never refreshes or mutates the browser.',
        parameters: Type.Object({}, {additionalProperties: false}),
        execute: async () => result({ok: true, world: session.world}),
    },
    {
        name: 'debug.query',
        label: 'debug.query',
        description: 'Execute canonical pure QueryIR against the pinned WorldView. Repeated calls observe the same revision.',
        parameters: Type.Unsafe<DebugQueryToolInput>(debugQueryJsonSchema),
        execute: async (_toolCallId, params) => {
            const output = session.query(params as DebugQueryToolInput);
            if (!output.ok) {return failed(output);}
            return result(output);
        },
    },
    {
        name: 'debug.compute',
        label: 'debug.compute',
        description: 'Evaluate a pure compute expression. Every argument is {literal: value}, {ref: {path}}, or another {op, args} expression. This never accesses or mutates live browser state.',
        parameters: Type.Unsafe<DebugComputeToolInput>(debugComputeJsonSchema),
        execute: async (_toolCallId, params) => {
            const input = params as DebugComputeToolInput;
            const output = session.compute(input.expr, input.scope);
            if (!output.ok) {return failed(output);}
            return result(output);
        },
    },
];
