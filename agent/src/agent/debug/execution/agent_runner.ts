import type {AgentModelRuntime} from '../../model/runtime';
import {createReactAgentRunner} from '../../execution/react_runner';
import type {AgentRunRequest, AgentRunResult} from '../../execution/types';
import {createPausedDslDebugAgentTools} from './agent_tools';
import {
    createDslDebugExecutionSession,
    type CreateDslDebugExecutionSessionOptions,
} from './dsl_session';
import type {DslDebugExecutionSession, PausedDslDebugExecution} from './contracts';
import {classifyPausedDslDebugToolCall} from './tool_policy';

export const PAUSED_DSL_DEBUG_SYSTEM_PROMPT = [
    'You control a DSL program paused before a statement or a pending browser effect.',
    'When debug.execution reports reason=effect, inspect the effect descriptor before deciding whether to advance.',
    'debug.execution, debug.scope, debug.world, debug.query, and debug.compute are pure reads.',
    'debug.step and debug.continue advance the retained execution and may cause World effects.',
    'Inspect freely, but advance execution only when your reasoning requires it.',
].join(' ');

export type PausedDslDebugAgentRunResult = AgentRunResult & {
    execution:
        | Readonly<{status: 'paused'; pause: PausedDslDebugExecution}>
        | Readonly<{status: 'completed'}>;
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
        return {
            ...result,
            execution: pause
                ? {status: 'paused' as const, pause}
                : {status: 'completed' as const},
            session,
        };
    },
});
