import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {AgentProgramExecutionSummary, AgentRunRequest} from '../types';
import type {AgentProgramExecutor} from './contracts';

export const EXECUTE_PROGRAM_TOOL = 'agent.execute_program';

type ExecuteProgramInput = {
    source: string;
    input?: Record<string, unknown>;
};

const parameters = Type.Unsafe<ExecuteProgramInput>({
    type: 'object',
    additionalProperties: false,
    required: ['source'],
    properties: {
        source: {type: 'string', minLength: 1},
        input: {type: 'object', additionalProperties: true},
    },
});

const toolResult = (details: unknown) => ({
    content: [{type: 'text' as const, text: JSON.stringify(details)}],
    details,
});

export const createProgramExecutionTool = (options: {
    request: AgentRunRequest;
    execute: AgentProgramExecutor;
}): Readonly<{
    tool: AgentTool;
    attempts: readonly AgentProgramExecutionSummary[];
}> => {
    const attempts: AgentProgramExecutionSummary[] = [];
    const tool: AgentTool = {
        name: EXECUTE_PROGRAM_TOOL,
        label: EXECUTE_PROGRAM_TOOL,
        description: 'Execute one browser DSL program inside the retained transactional debugger. Browser mutations are allowed only here. Include verification with ensure statements when the task has a checkable postcondition. A syntactically invalid program may be corrected and resubmitted; once execution starts, repair must stay inside that retained transaction rather than starting another program.',
        parameters,
        execute: async (_toolCallId, params) => {
            const previous = attempts.at(-1);
            if (previous && previous.status !== 'invalid') {
                throw new Error('a program execution already started; repair or rollback must remain inside its retained transaction');
            }
            const input = params as ExecuteProgramInput;
            const source = input.source.trim();
            if (!source) {throw new Error('program source is required');}
            const result = await options.execute({
                source,
                input: structuredClone(input.input ?? {}),
            }, options.request);
            attempts.push(result);
            return toolResult({
                status: result.status,
                ...(result.text ? {text: result.text} : {}),
                ...(result.error ? {error: result.error} : {}),
                trace: result.trace?.metrics,
            });
        },
    };
    return {tool, attempts};
};
