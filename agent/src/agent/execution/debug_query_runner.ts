import {createDebugQuerySession} from '../debug/query/session';
import {createDebugQueryAgentTools} from '../debug/tools/adapter';
import {classifyDebugQueryToolCall} from '../debug/tools/policy';
import type {AgentModelRuntime} from '../model/runtime';
import type {WorldViewSource} from '../worldview/contracts';
import {createReactAgentRunner} from './react_runner';
import type {AgentRunner} from './types';

export const DEBUG_QUERY_SYSTEM_PROMPT = [
    'You are inspecting one pinned browser WorldView.',
    'Use only debug.world, debug.query, and debug.compute.',
    'All debug calls are pure reads over the same world revision.',
    'Do not assume live browser state changed between calls.',
].join(' ');

export const createDebugQueryAgentRunner = (deps: {
    worldViewSource: WorldViewSource;
    modelRuntime?: AgentModelRuntime;
}): AgentRunner => ({
    run: async (request) => {
        const view = await deps.worldViewSource.pin();
        const debugSession = createDebugQuerySession(view);
        const runner = createReactAgentRunner({
            tools: createDebugQueryAgentTools(debugSession),
            modelRuntime: deps.modelRuntime,
            classifyToolCall: classifyDebugQueryToolCall,
            readWorldRevision: () => ({
                pageEpoch: view.revision.pageEpoch,
                captureRevision: view.revision.captureRevision,
                freshness: 'fresh',
            }),
        });
        return await runner.run({
            ...request,
            systemPrompt: request.systemPrompt ?? DEBUG_QUERY_SYSTEM_PROMPT,
        });
    },
});
