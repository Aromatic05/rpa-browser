import type {Api, Model} from '@earendil-works/pi-ai';
import {streamSimple as streamOpenAICompletions} from '@earendil-works/pi-ai/api/openai-completions';
import type {StreamFn} from '@earendil-works/pi-agent-core';

export type AgentModelBinding = {
    model: Model<Api>;
    streamFn: StreamFn;
    getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
};

export type AgentModelRuntime = {
    resolve: (provider: string, model: string) => AgentModelBinding | null;
};

export type OpenAICompatibleModelConfig = {
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    contextWindow?: number;
    maxTokens?: number;
};

export const createOpenAICompatibleAgentModelRuntime = (
    config: OpenAICompatibleModelConfig,
): AgentModelRuntime => {
    const model: Model<'openai-completions'> = {
        id: config.model,
        name: config.model,
        api: 'openai-completions',
        provider: config.provider,
        baseUrl: config.baseUrl,
        reasoning: false,
        input: ['text'],
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: config.contextWindow ?? 128_000,
        maxTokens: config.maxTokens ?? 8_192,
    };
    const streamFn: StreamFn = (resolvedModel, context, options) =>
        streamOpenAICompletions(resolvedModel as Model<'openai-completions'>, context, options);
    return {
        resolve: (provider, modelId) => provider === config.provider && modelId === config.model
            ? {
                model,
                streamFn,
                getApiKey: (requestedProvider) => requestedProvider === config.provider ? config.apiKey : undefined,
            }
            : null,
    };
};

const emptyModelRuntime: AgentModelRuntime = {resolve: () => null};

export const createEnvironmentAgentModelRuntime = (): AgentModelRuntime => {
    const provider = process.env.RPA_AGENT_PROVIDER?.trim();
    const model = process.env.RPA_AGENT_MODEL?.trim();
    const baseUrl = process.env.RPA_AGENT_BASE_URL?.trim();
    const apiKey = process.env.RPA_AGENT_API_KEY?.trim();
    if (!provider || !model || !baseUrl || !apiKey) {return emptyModelRuntime;}
    return createOpenAICompatibleAgentModelRuntime({provider, model, baseUrl, apiKey});
};

let defaultRuntime: AgentModelRuntime | undefined;

export const getDefaultAgentModelRuntime = (): AgentModelRuntime =>
    defaultRuntime ??= createEnvironmentAgentModelRuntime();
