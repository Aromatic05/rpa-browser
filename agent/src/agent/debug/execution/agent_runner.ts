import type {AgentModelRuntime} from '../../model/runtime';
import {createReactAgentRunner} from '../../execution/react_runner';
import type {AgentRunRequest, AgentRunResult} from '../../execution/types';
import {createPausedDslDebugAgentTools} from './agent_tools';
import {
    createDslDebugExecutionSession,
    type CreateDslDebugExecutionSessionOptions,
} from './dsl_session';
import type {
    DslDebugAdvanceResult,
    DslDebugExecutionSession,
    DslDebugTerminalFailure,
    PausedDslDebugExecution,
} from './contracts';
import {classifyPausedDslDebugToolCall} from './tool_policy';

export const PAUSED_DSL_DEBUG_SYSTEM_PROMPT = [
    'You control a DSL program paused before a statement, before a pending browser effect, or after a browser step failure.',
    'When debug.execution reports reason=effect, inspect the effect descriptor before deciding whether to advance.',
    'When debug.execution reports reason=failure, inspect the failure, scope, and World freely; debug.continue terminalizes that original failure and does not retry it.',
    'debug.execution location includes programId, execution path, source line range when available, loop frames, and checkpoint callStack.',
    'debug.execution, debug.scope, debug.effects, debug.diff, debug.world, debug.query, and debug.compute are pure reads.',
    'debug.effects contains only World effects that actually executed, with outcome and before/after World revisions; pending or aborted effects are absent.',
    'debug.diff materializes the Snapshot V2 semantic delta for one effect sequence only when requested.',
    'debug.step and debug.continue validate the live World revision before advancing. If they return status=conflict, the continuation remains paused on its old WorldView; call debug.refresh, inspect the new World, then decide again.',
    'debug.refresh is a pure read-only rebind of the paused continuation to the latest WorldView and never advances the program.',
    'debug.step and debug.continue advance the retained execution and may cause World effects.',
    'debug.abort terminates the retained execution before the pending statement/effect; it is not rollback and does not undo earlier effects.',
    'Inspect freely, but advance execution only when your reasoning requires it.',
].join(' ');

export type PausedDslDebugAgentRunResult = AgentRunResult & {
    execution:
        | Readonly<{status: 'paused'; pause: PausedDslDebugExecution}>
        | Readonly<{status: 'completed'}>
        | Readonly<{status: 'failed'; failure: DslDebugTerminalFailure}>
        | Readonly<{status: 'aborted'; at: Extract<DslDebugAdvanceResult, {status: 'aborted'}>['at']}>;
    session: DslDebugExecutionSession;
};

export type PausedDslDebugAgentRunner = {
    run: (request: AgentRunRequest) => Promise<PausedDslDebugAgentRunResult>;
};

export const createPausedDslDebugAgentRunner = (
    options: CreateDslDebugExecutionSessionOptions & {modelRuntime?: AgentModelRuntime},
): PausedDslDebugAgentRunner => ({
    run: async (request) => {
        const session = createDslDebugExecutionSession({
            source: options.source,
            context: options.context,
            worldViewSource: options.worldViewSource,
            debug: options.debug ?? {initialMode: 'step'},
        });
        const firstPause = await session.waitForPause();
        const debuggerTools = createPausedDslDebugAgentTools(session, firstPause);
        const runner = createReactAgentRunner({
            tools: debuggerTools.tools,
            modelRuntime: options.modelRuntime,
            classifyToolCall: classifyPausedDslDebugToolCall,
            readWorldRevision: debuggerTools.readWorldRevision,
        });
        const result = await runner.run({
            ...request,
            systemPrompt: request.systemPrompt ?? PAUSED_DSL_DEBUG_SYSTEM_PROMPT,
        });
        const pause = debuggerTools.readPause();
        const terminal = debuggerTools.readTerminal();
        return {
            ...result,
            execution: pause
                ? {status: 'paused' as const, pause}
                : terminal?.status === 'failed'
                    ? {status: 'failed' as const, failure: terminal.failure}
                    : terminal?.status === 'aborted'
                        ? {status: 'aborted' as const, at: terminal.at}
                : {status: 'completed' as const},
            session,
        };
    },
});
