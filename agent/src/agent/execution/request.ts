import type {AgentExecutionMode, AgentRunRequest} from './types';

export class AgentRequestError extends Error {}

const requiredText = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new AgentRequestError(`${name} is required`);
    }
    return value.trim();
};

const optionalExecutionMode = (value: unknown): AgentExecutionMode | undefined => {
    if (value === undefined) {return undefined;}
    if (value === 'program' || value === 'react-baseline') {return value;}
    throw new AgentRequestError('executionMode must be program or react-baseline');
};

export const parseAgentRunRequest = (value: unknown): AgentRunRequest => {
    const input = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const request: AgentRunRequest = {
        prompt: requiredText(input.prompt, 'prompt'),
        provider: requiredText(input.provider, 'provider'),
        model: requiredText(input.model, 'model'),
    };
    request.executionMode = optionalExecutionMode(input.executionMode);
    if (input.source !== undefined) {
        request.source = requiredText(input.source, 'source');
    }
    if (input.input !== undefined) {
        if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) {
            throw new AgentRequestError('input must be an object');
        }
        request.input = structuredClone(input.input as Record<string, unknown>);
    }
    if (typeof input.systemPrompt === 'string' && input.systemPrompt.trim()) {
        request.systemPrompt = input.systemPrompt.trim();
    }
    return request;
};
