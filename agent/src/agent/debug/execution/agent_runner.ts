import type {AgentModelRuntime} from '../../model/runtime';
import {createReactAgentRunner} from '../../execution/react_runner';
import type {AgentRunRequest, AgentRunResult} from '../../execution/types';
import {mergeAgentTraceSnapshots} from '../../trace/merge';
import {createPausedDslDebugAgentTools} from './agent_tools';
import {debuggerSystemPromptForPause, debuggerToolsForPause} from './agent_surface';
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
            compensationPort: options.compensationPort,
            debug: options.debug ?? {initialMode: 'step'},
        });
        const initial = await Promise.race([
            session.waitForPause().then((pause) => ({status: 'paused' as const, pause})),
            session.waitForCompletion().then(
                (completed) => ({status: 'completed' as const, output: structuredClone(completed.scope.output)}),
                (error) => ({status: 'failed' as const, failure: normalizeInitialFailure(error)}),
            ),
        ]);
        if (initial.status !== 'paused') {
            return {
                provider: request.provider,
                model: request.model,
                text: initial.status === 'completed'
                    ? JSON.stringify(initial.output)
                    : initial.failure.message,
                trace: mergeAgentTraceSnapshots([]),
                execution: initial.status === 'completed'
                    ? {status: 'completed' as const}
                    : {status: 'failed' as const, failure: initial.failure},
                session,
            };
        }
        const firstPause = initial.pause;
        const debuggerTools = createPausedDslDebugAgentTools(session, firstPause);
        const allTools = debuggerTools.tools;
        const runner = createReactAgentRunner({
            tools: debuggerToolsForPause(allTools, firstPause),
            modelRuntime: options.modelRuntime,
            classifyToolCall: classifyPausedDslDebugToolCall,
            readWorldRevision: debuggerTools.readWorldRevision,
            prepareNextTurnWithContext: ({context}) => {
                const nextPause = debuggerTools.readPause();
                if (!nextPause) {return;}
                return {
                    context: {
                        ...context,
                        tools: debuggerToolsForPause(allTools, nextPause),
                        systemPrompt: debuggerSystemPromptForPause(nextPause, request.systemPrompt),
                    },
                };
            },
        });
        const result = await runner.run({
            ...request,
            systemPrompt: debuggerSystemPromptForPause(firstPause, request.systemPrompt),
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

const normalizeInitialFailure = (error: unknown): DslDebugTerminalFailure => {
    if (error && typeof error === 'object') {
        const value = error as {code?: unknown; message?: unknown; details?: unknown};
        return Object.freeze({
            code: typeof value.code === 'string' ? value.code : 'ERR_DSL_RUNTIME',
            message: typeof value.message === 'string' ? value.message : 'DSL execution failed',
            ...(value.details === undefined ? {} : {details: structuredClone(value.details)}),
        });
    }
    return Object.freeze({
        code: 'ERR_DSL_RUNTIME',
        message: typeof error === 'string' ? error : 'DSL execution failed',
    });
};
