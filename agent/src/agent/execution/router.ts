import type {AgentExecutionMode, AgentRunner} from './types';

export type CreateAgentExecutionRouterOptions = {
    program: AgentRunner;
    baseline: AgentRunner;
    defaultMode?: AgentExecutionMode;
};

export const createAgentExecutionRouter = (
    options: CreateAgentExecutionRouterOptions,
): AgentRunner => ({
    run: async (request, control) => {
        const mode = request.executionMode ?? options.defaultMode ?? 'program';
        const runner = mode === 'react-baseline' ? options.baseline : options.program;
        const result = await runner.run(request, control);
        return {
            ...result,
            executionMode: result.executionMode ?? mode,
        };
    },
});
