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

    const advance = async (mode: 'continue' | 'step' | 'abort') => {
        const current = requirePause();
        const result = await execution.advance(current.continuationId, mode);
        if (result.status === 'paused') {
            pause = result.pause;
            terminal = null;
            return toolResult(result);
        }
        if (result.status === 'conflict') {
            pause = current;
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
            name: 'debug.effects',
            label: 'debug.effects',
            description: 'Read the executed World-effect journal. Pending or aborted effects are excluded; records include outcome and before/after World revisions.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => {
                const current = requirePause();
                return toolResult({
                    effects: execution.effects(current.continuationId),
                    world: current.world,
                });
            },
        },
        {
            name: 'debug.diff',
            label: 'debug.diff',
            description: 'Materialize the Snapshot V2 semantic World delta for one executed effect journal entry. This is a pure read.',
            parameters: Type.Object({
                effectSequence: Type.Number({minimum: 1}),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const result = execution.diff(
                    current.continuationId,
                    (params as {effectSequence: number}).effectSequence,
                );
                if (!result.ok) {return fail(result);}
                return toolResult(result);
            },
        },
        {
            name: 'debug.world',
            label: 'debug.world',
            description: 'Read the pinned WorldView descriptor for the current paused continuation.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => toolResult({world: requirePause().world}),
        },
        {
            name: 'debug.refresh',
            label: 'debug.refresh',
            description: 'Refresh only the debugger WorldView for the retained continuation. This is a read-only rebind and does not advance the DSL program.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => {
                const current = requirePause();
                pause = await execution.refresh(current.continuationId);
                terminal = null;
                return toolResult({status: 'refreshed', pause});
            },
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
        {
            name: 'debug.abort',
            label: 'debug.abort',
            description: 'Terminate the retained execution without executing the currently pending statement/effect. This is not rollback and does not undo effects that already happened.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => await advance('abort'),
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
