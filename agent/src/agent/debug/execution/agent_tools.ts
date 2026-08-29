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
    readTerminal: () => Extract<DslDebugAdvanceResult, {status: 'completed' | 'failed' | 'aborted'}> | null;
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
    let terminal: Extract<DslDebugAdvanceResult, {status: 'completed' | 'failed' | 'aborted'}> | null = null;

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
        if (result.status === 'paused' || result.status === 'barrier' || result.status === 'recompute_required') {
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

    const crossBarrier = async () => {
        const current = requirePause();
        const result = await execution.crossBarrier(current.continuationId);
        if (result.status === 'paused' || result.status === 'barrier' || result.status === 'recompute_required') {
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
            name: 'debug.catalog',
            label: 'debug.catalog',
            description: 'Read the business schema available in the pinned WorldView: entities, fields, actions, row actions, query capabilities, primary keys, and explicit effect reversibility. This is a pure read.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => {
                const current = requirePause();
                return toolResult(execution.catalog(current.continuationId));
            },
        },
        {
            name: 'debug.program',
            label: 'debug.program',
            description: 'Read a normalized DSL ProgramView with stable execution paths and source locations. Defaults to the program owning the current pause; programId may select another compiled program such as a parent or checkpoint body.',
            parameters: Type.Object({
                programId: Type.Optional(Type.String({minLength: 1})),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const input = params as {programId?: string};
                return toolResult({
                    program: execution.program(current.continuationId, input.programId),
                    world: current.world,
                });
            },
        },
        {
            name: 'debug.patches',
            label: 'debug.patches',
            description: 'Read session-local durable DSL statement patches. Patches overlay ProgramView paths during execution and rewind, but never persist workflow artifacts.',
            parameters: Type.Object({
                programId: Type.Optional(Type.String({minLength: 1})),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                return toolResult({
                    patches: execution.patches(current.continuationId, (params as {programId?: string}).programId),
                    world: current.world,
                });
            },
        },
        {
            name: 'debug.history',
            label: 'debug.history',
            description: 'Read successful DSL statement execution history and classify ProgramView paths as current, executed, or unexecuted. Repeated loop executions retain their loop iteration frames. This is a pure read.',
            parameters: Type.Object({
                programId: Type.Optional(Type.String({minLength: 1})),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const input = params as {programId?: string};
                return toolResult({
                    history: execution.history(current.continuationId, input.programId),
                    world: current.world,
                });
            },
        },
        {
            name: 'debug.explain',
            label: 'debug.explain',
            description: 'Explain how one DSL scope path was produced. Returns query/compute/ref/checkpoint/loop provenance and recursively expands dependency paths. This is a pure read.',
            parameters: Type.Object({
                path: Type.String({minLength: 1}),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                return toolResult({
                    explanation: execution.explain(
                        current.continuationId,
                        (params as {path: string}).path,
                    ),
                    world: current.world,
                });
            },
        },
        {
            name: 'debug.recompute',
            label: 'debug.recompute',
            description: 'Purely recompute one tracked DSL scope value from its executable provenance against the current pinned WorldView. Returns a candidate and changed flag without modifying scope or World.',
            parameters: Type.Object({
                path: Type.String({minLength: 1}),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                return toolResult({
                    ...execution.recompute(current.continuationId, (params as {path: string}).path),
                    world: current.world,
                });
            },
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
            name: 'debug.transaction',
            label: 'debug.transaction',
            description: 'Read the current execution transaction baseline, current World, executed effect count, and savepoints. This is a pure read.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => {
                const current = requirePause();
                return toolResult({
                    transaction: execution.transaction(current.continuationId),
                    world: current.world,
                });
            },
        },
        {
            name: 'debug.transaction_diff',
            label: 'debug.transaction_diff',
            description: 'Materialize the semantic World delta from the retained execution transaction baseline to the current paused World. This is a pure read.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => {
                const current = requirePause();
                const result = execution.transactionDiff(current.continuationId);
                if (!result.ok) {return fail(result);}
                return toolResult(result);
            },
        },
        {
            name: 'debug.commit',
            label: 'debug.commit',
            description: 'Commit the current retained transaction baseline at the pinned World without advancing the DSL. Old transaction savepoints and rewind points become invalid; the effect journal remains readable as audit history. A failure pause cannot be committed.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => {
                const current = requirePause();
                const result = await execution.commit(current.continuationId);
                if (result.status === 'committed') {
                    pause = await execution.refresh(current.continuationId);
                    terminal = null;
                }
                return toolResult(result);
            },
        },
        {
            name: 'debug.savepoint',
            label: 'debug.savepoint',
            description: 'Create transaction-local debugger savepoint metadata at the current pinned World and effect position. This does not change the World.',
            parameters: Type.Object({
                name: Type.Optional(Type.String({minLength: 1})),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const input = params as {name?: string};
                const savepoint = execution.savepoint(current.continuationId, input.name);
                return toolResult({
                    savepoint,
                    execution: execution.executionSavepoint(current.continuationId, savepoint.id),
                    world: current.world,
                });
            },
        },
        {
            name: 'debug.rollback',
            label: 'debug.rollback',
            description: 'Attempt to restore a transaction savepoint without advancing the DSL continuation. strategy=physical may execute explicit UI compensation through the configured compensation port, but successful compensation remains semantically unverified and is reported as compensated, never restored.',
            parameters: Type.Object({
                savepointId: Type.String({minLength: 1}),
                strategy: Type.Optional(Type.Union([
                    Type.Literal('none'),
                    Type.Literal('physical'),
                ])),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const input = params as {savepointId: string; strategy?: 'none' | 'physical'};
                const result = await execution.rollback(
                    current.continuationId,
                    input.savepointId,
                    {strategy: input.strategy},
                );
                if (result.status === 'compensated' || result.status === 'partial') {
                    pause = await execution.refresh(current.continuationId);
                    terminal = null;
                }
                return toolResult(result);
            },
        },
        {
            name: 'debug.rewind_plan',
            label: 'debug.rewind_plan',
            description: 'List execution savepoints for a main or checkpoint program path. Nested if/for paths are frame-aware; repeated checkpoint calls expose checkpointStack invocationIds so a specific invocation can be chosen. This is a pure read and does not claim a candidate is rollback-safe; debug.rewind performs the strict World restore check.',
            parameters: Type.Object({
                programId: Type.Optional(Type.String({minLength: 1})),
                path: Type.Optional(Type.String({minLength: 1})),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const input = params as {programId?: string; path?: string};
                return toolResult(execution.rewindPlan(current.continuationId, input));
            },
        },
        {
            name: 'debug.rewind',
            label: 'debug.rewind',
            description: 'Rewind retained DSL execution to a saved statement point after strict World restoration. strategy=physical may compensate effects, but execution restarts only when every compensated effect is explicitly reversible and the semantic World diff verifies empty. Unknown or merely compensatable effects remain blocked.',
            parameters: Type.Object({
                savepointId: Type.String({minLength: 1}),
                strategy: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('physical')])),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const input = params as {savepointId: string; strategy?: 'none' | 'physical'};
                const result = await execution.rewind(current.continuationId, input.savepointId, {strategy: input.strategy});
                if (result.status === 'rewound' || result.status === 'conflict') {
                    pause = result.pause;
                    terminal = null;
                }
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
            name: 'debug.patch_statement',
            label: 'debug.patch_statement',
            description: 'Patch a statement by stable programId/path. The current statement can be replaced immediately; an already executed target returns rewind_required and a future target returns not_current. Omit programId/path to patch the current statement. The patch is one-shot and never persists the DSL.',
            parameters: Type.Object({
                source: Type.String({minLength: 1}),
                programId: Type.Optional(Type.String({minLength: 1})),
                path: Type.Optional(Type.String({minLength: 1})),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const input = params as {source: string; programId?: string; path?: string};
                const result = execution.patchStatement(
                    current.continuationId,
                    input.source,
                    {programId: input.programId, path: input.path},
                );
                pause = result.pause;
                terminal = null;
                return toolResult(result);
            },
        },
        {
            name: 'debug.patch_program',
            label: 'debug.patch_program',
            description: 'Install or replace a session-local durable statement patch at a stable programId/path. Current and future statements use it immediately; an already executed path returns rewind_required with candidates. The workflow artifact is not modified.',
            parameters: Type.Object({
                programId: Type.String({minLength: 1}),
                path: Type.String({minLength: 1}),
                source: Type.String({minLength: 1}),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const input = params as {programId: string; path: string; source: string};
                const result = execution.patchProgram(current.continuationId, input.programId, input.path, input.source);
                pause = result.pause;
                terminal = null;
                return toolResult(result);
            },
        },
        {
            name: 'debug.unpatch_program',
            label: 'debug.unpatch_program',
            description: 'Remove one session-local durable statement patch. If the patched statement is the current pause, the original ProgramView statement is restored immediately.',
            parameters: Type.Object({
                programId: Type.String({minLength: 1}),
                path: Type.String({minLength: 1}),
            }, {additionalProperties: false}),
            execute: async (_toolCallId, params) => {
                const current = requirePause();
                const input = params as {programId: string; path: string};
                const result = execution.unpatchProgram(current.continuationId, input.programId, input.path);
                pause = result.pause;
                terminal = null;
                return toolResult(result);
            },
        },
        {
            name: 'debug.recompute_effect',
            label: 'debug.recompute_effect',
            description: 'Re-resolve the current pending logical effect target by executing its stored canonical QueryIR against the pinned WorldView, then rebind the pending effect without mutating the World.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => {
                const current = requirePause();
                const result = execution.recomputeEffect(current.continuationId);
                pause = result.pause;
                terminal = null;
                return toolResult(result);
            },
        },
        {
            name: 'debug.query',
            label: 'debug.query',
            description: 'Execute canonical pure QueryIR against the pinned WorldView. Compose scan/traverse/filter/limit/one/exists/count or use business entity leaves.',
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
            name: 'debug.cross_barrier',
            label: 'debug.cross_barrier',
            description: 'Explicitly authorize only the current commit barrier effect. The runtime executes that effect and immediately returns to step mode; later barriers still require separate authorization.',
            parameters: Type.Object({}, {additionalProperties: false}),
            execute: async () => await crossBarrier(),
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
