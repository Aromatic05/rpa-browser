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
    contextWindow?: number;
    maxTokens?: number;
};

export type OpenAICompatibleModelConfigWithApiKey = OpenAICompatibleModelConfig & {
    apiKey: string;
};

export type OpenAICompatibleModelConfigWithCredential = OpenAICompatibleModelConfig & {
    getApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
};

export class ModelCredentialError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'ModelCredentialError';
        this.code = code;
    }
}

const buildModel = (config: OpenAICompatibleModelConfig): Model<'openai-completions'> => ({
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
});

const buildStreamFn = (): StreamFn => (resolvedModel, context, options) =>
    streamOpenAICompletions(resolvedModel as Model<'openai-completions'>, context, options);

export const createOpenAICompatibleAgentModelRuntimeWithCredential = (
    config: OpenAICompatibleModelConfigWithCredential,
): AgentModelRuntime => {
    const model = buildModel(config);
    const streamFn = buildStreamFn();
    return {
        resolve: (provider, modelId) =>
            provider === config.provider && modelId === config.model
                ? {
                    model,
                    streamFn,
                    getApiKey: (requestedProvider) =>
                        requestedProvider === config.provider
                            ? config.getApiKey(requestedProvider)
                            : undefined,
                }
                : null,
    };
};

export const createOpenAICompatibleAgentModelRuntime = (
    config: OpenAICompatibleModelConfigWithApiKey,
): AgentModelRuntime =>
    createOpenAICompatibleAgentModelRuntimeWithCredential({
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        getApiKey: (provider) => (provider === config.provider ? config.apiKey : undefined),
    });

const emptyModelRuntime: AgentModelRuntime = {resolve: () => null};

export const createEnvironmentAgentModelRuntime = (): AgentModelRuntime => {
    const provider = process.env.RPA_AGENT_PROVIDER?.trim();
    const model = process.env.RPA_AGENT_MODEL?.trim();
    const baseUrl = process.env.RPA_AGENT_BASE_URL?.trim();
    if (!provider || !model || !baseUrl) {return emptyModelRuntime;}
    return createOpenAICompatibleAgentModelRuntimeWithCredential({
        provider,
        model,
        baseUrl,
        getApiKey: (requestedProvider) => {
            if (requestedProvider !== provider) {return undefined;}
            const apiKey = process.env.RPA_AGENT_API_KEY?.trim();
            return apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined;
        },
    });
};

let defaultRuntime: AgentModelRuntime | undefined;

export const getDefaultAgentModelRuntime = (): AgentModelRuntime =>
    defaultRuntime ??= createEnvironmentAgentModelRuntime();
