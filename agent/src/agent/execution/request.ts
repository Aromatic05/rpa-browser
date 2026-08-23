import type {AgentRunRequest} from './types';

export class AgentRequestError extends Error {}

const requiredText = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new AgentRequestError(`${name} is required`);
    }
    return value.trim();
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
    if (typeof input.systemPrompt === 'string' && input.systemPrompt.trim()) {
        request.systemPrompt = input.systemPrompt.trim();
    }
    return request;
};
