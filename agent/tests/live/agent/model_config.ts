import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LiveModelConfig = Readonly<{
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
}>;

const requiredEnv = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) {throw new Error(`${name} is required`);}
    return value;
};

export const resolveLiveModelConfig = (): LiveModelConfig => {
    const provider = process.env.RPA_AGENT_PROVIDER?.trim();
    const model = process.env.RPA_AGENT_MODEL?.trim();
    const baseUrl = process.env.RPA_AGENT_BASE_URL?.trim();
    const apiKey = process.env.RPA_AGENT_API_KEY?.trim();
    if (provider && model && baseUrl && apiKey) {return {provider, model, baseUrl, apiKey};}
    if ([provider, baseUrl, apiKey].some(Boolean)) {
        throw new Error('RPA_AGENT_PROVIDER, RPA_AGENT_MODEL, RPA_AGENT_BASE_URL, and RPA_AGENT_API_KEY must be provided together');
    }

    const opencodeProvider = requiredEnv('RPA_AGENT_OPENCODE_PROVIDER');
    const configPath = process.env.RPA_AGENT_OPENCODE_CONFIG?.trim()
        || path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        provider?: Record<string, {
            options?: {baseURL?: unknown; apiKey?: unknown};
            models?: Record<string, unknown>;
        }>;
    };
    const entry = config.provider?.[opencodeProvider];
    const resolvedBaseUrl = typeof entry?.options?.baseURL === 'string' ? entry.options.baseURL.trim() : '';
    const resolvedApiKey = typeof entry?.options?.apiKey === 'string' ? entry.options.apiKey.trim() : '';
    const resolvedModel = model || Object.keys(entry?.models ?? {})[0] || '';
    if (!entry || !resolvedBaseUrl || !resolvedApiKey || !resolvedModel) {
        throw new Error(`OpenCode provider is incomplete: ${opencodeProvider}`);
    }
    return {
        provider: opencodeProvider,
        model: resolvedModel,
        baseUrl: resolvedBaseUrl,
        apiKey: resolvedApiKey,
    };
};
