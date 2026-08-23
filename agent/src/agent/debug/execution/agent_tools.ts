import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {AgentWorldRevision} from '../../trace/collector';
import {
    debugComputeJsonSchema,
    debugQueryJsonSchema,
    type DebugComputeToolInput,
    type DebugQueryToolInput,
} from '../tools/schemas';
import type {
    DslDebugAdvanceResult,
    DslDebugExecutionSession,
    PausedDslDebugExecution,
} from './contracts';

export type PausedDslDebugAgentTools = {
    tools: AgentTool[];
    readWorldRevision: () => AgentWorldRevision | null;
    readPause: () => PausedDslDebugExecution | null;
    readTerminal: () => Exclude<DslDebugAdvanceResult, {status: 'paused'}> | null;
};

const stringify = (value: unknown): string => {
    try {return JSON.stringify(value);}
    catch {return String(value);}
};

const toolResult = (details: unknown) => ({
    content: [{type: 'text' as const, text: stringify(details)}],
    details,
});

const fail = (details: {error: {code: string; message: string}}): never => {
    throw new Error(stringify(details));
};

export const createPausedDslDebugAgentTools = (
    execution: DslDebugExecutionSession,
    initialPause: PausedDslDebugExecution,
): PausedDslDebugAgentTools => {
    let pause: PausedDslDebugExecution | null = initialPause;
    let terminal: Exclude<DslDebugAdvanceResult, {status: 'paused'}> | null = null;

    const requirePause = (): PausedDslDebugExecution => {
        if (!pause) {throw new Error('DSL debug execution is not paused');}
        return pause;
    };

    const pauseScope = () => {
        const current = requirePause().scope;
        return {
            input: current.input,
            local: current.vars,
            vars: current.vars,
            output: current.output,
            ...(current.failure ? {failure: current.failure} : {}),
        };
    };

    const advance = async (mode: 'continue' | 'step') => {
        const current = requirePause();
        pause = null;
        const result = await execution.advance(current.continuationId, mode);
        if (result.status === 'paused') {
            pause = result.pause;
            terminal = null;
            return toolResult(result);
        }
        pause = null;
        terminal = result;
        return toolResult(result);
    };

    const tools: AgentTool[] = [
        {
            name: 'debug.execution',
            label: 'debug.execution',
            description: 'Read the current paused DSL program point and continuation metadata without changing execution.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => toolResult({status: 'paused', pause: requirePause()}),
        },
        {
            name: 'debug.scope',
            label: 'debug.scope',
            description: 'Read the frozen DSL scope at the current pause: input, vars, output, and optional failure.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => toolResult({scope: requirePause().scope, world: requirePause().world}),
        },
        {
            name: 'debug.world',
            label: 'debug.world',
            description: 'Read the pinned WorldView descriptor for the current paused continuation.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => toolResult({world: requirePause().world}),
        },
        {
            name: 'debug.query',
            label: 'debug.query',
            description: 'Run a pure query against the WorldView pinned to the current paused continuation.',
            parameters: Type.Unsafe<DebugQueryToolInput>(debugQueryJsonSchema),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const result = execution.query(current.continuationId, params as DebugQueryToolInput);
                if (!result.ok) {return fail(result);}
                return toolResult(result);
            },
        },
        {
            name: 'debug.compute',
            label: 'debug.compute',
            description: 'Evaluate a pure compute expression. If scope is omitted, refs resolve against the paused DSL scope roots input, vars, output, failure; local aliases vars.',
            parameters: Type.Unsafe<DebugComputeToolInput>(debugComputeJsonSchema),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const input = params as DebugComputeToolInput;
                const result = execution.compute(
                    current.continuationId,
                    input.expr,
                    input.scope ?? pauseScope(),
                );
                if (!result.ok) {return fail(result);}
                return toolResult(result);
            },
        },
        {
            name: 'debug.step',
            label: 'debug.step',
            description: 'Resume the current continuation and pause before the next DSL statement, or return completion.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => await advance('step'),
        },
        {
            name: 'debug.continue',
            label: 'debug.continue',
            description: 'Resume until the next configured breakpoint or terminal state. At a failure pause this does not retry the failed step; it terminalizes the original failure.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => await advance('continue'),
        },
    ];

    return {
        tools,
        readWorldRevision: () => pause ? {
            pageEpoch: pause.world.revision.pageEpoch,
            captureRevision: pause.world.revision.captureRevision,
            freshness: 'fresh',
        } : null,
        readPause: () => pause,
        readTerminal: () => terminal,
    };
};
