import fs from 'node:fs/promises';
import path from 'node:path';
import type {AgentModelDefaults} from '../../platform/config';
import {parseSecretRef} from '../../platform/config/secret_ref';
import type {SecretRefResolver} from '../../platform/security/contracts';
import {
    createOpenAICompatibleAgentModelRuntimeWithCredential,
    ModelCredentialError,
    type AgentModelRuntime,
} from './runtime';

export type AgentModelSetupStatus = Readonly<{
    configured: boolean;
    credentialConfigured: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
}>;

export type AgentModelSetupInput = Readonly<{
    provider: string;
    model: string;
    baseUrl: string;
    apiKey?: string;
}>;

export type AgentModelSettings = Readonly<{
    runtime: AgentModelRuntime;
    status: () => AgentModelSetupStatus;
    defaults: () => Readonly<{provider: string; model: string}> | undefined;
    configure: (input: AgentModelSetupInput) => Promise<AgentModelSetupStatus>;
}>;

export type CreateAgentModelSettingsOptions = Readonly<{
    initial: AgentModelDefaults;
    secretResolver: SecretRefResolver;
    baseDir: string;
    configPath?: string;
}>;

type MutableModelConfig = {
    provider: string;
    model: string;
    baseUrl: string;
    apiKeyRef: string;
};

const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

const requireText = (value: string, field: string, maxLength: number): string => {
    const clean = value.trim();
    if (!clean) {throw new Error(`${field} is required`);}
    if (clean.length > maxLength) {throw new Error(`${field} is too long`);}
    return clean;
};

const requireBaseUrl = (value: string): string => {
    const clean = requireText(value, 'baseUrl', 2048);
    let parsed: URL;
    try {
        parsed = new URL(clean);
    } catch {
        throw new Error('baseUrl must be a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('baseUrl must use http or https');
    }
    return clean.replace(/\/+$/, '');
};

const readConfigFile = async (filePath: string): Promise<Record<string, unknown>> => {
    try {
        return asRecord(JSON.parse(await fs.readFile(filePath, 'utf8')));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return {};}
        throw error;
    }
};

const atomicWrite = async (filePath: string, content: string, mode = 0o600): Promise<void> => {
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    const temporary = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await fs.writeFile(temporary, content, {encoding: 'utf8', mode});
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, mode);
};

export const createAgentModelSettings = (options: CreateAgentModelSettingsOptions): AgentModelSettings => {
    const baseDir = path.resolve(options.baseDir);
    const configPath = path.resolve(
        options.configPath
            ?? process.env.RUNNER_CONFIG_PATH
            ?? path.join(baseDir, '.rpa', 'runner_config.json'),
    );
    const secretPath = path.join(path.dirname(configPath), 'secrets', 'model-api-key');
    const secretRef = `file:${path.relative(baseDir, secretPath)}`;
    let current: MutableModelConfig = {...options.initial};

    const configured = (): boolean =>
        current.provider.trim().length > 0
        && current.model.trim().length > 0
        && current.baseUrl.trim().length > 0;

    const credentialConfigured = (): boolean => {
        try {
            return options.secretResolver.has(parseSecretRef(current.apiKeyRef));
        } catch {
            return false;
        }
    };

    const status = (): AgentModelSetupStatus => Object.freeze({
        configured: configured(),
        credentialConfigured: credentialConfigured(),
        ...(configured()
            ? {provider: current.provider, model: current.model, baseUrl: current.baseUrl}
            : {}),
    });

    const defaults = (): Readonly<{provider: string; model: string}> | undefined =>
        configured() ? Object.freeze({provider: current.provider, model: current.model}) : undefined;

    const runtime: AgentModelRuntime = {
        resolve: (provider, model) => {
            if (!configured() || provider !== current.provider || model !== current.model) {return null;}
            return createOpenAICompatibleAgentModelRuntimeWithCredential({
                provider: current.provider,
                model: current.model,
                baseUrl: current.baseUrl,
                getApiKey: async (requestedProvider) => {
                    if (requestedProvider !== current.provider) {return undefined;}
                    try {
                        return (await options.secretResolver.resolve(parseSecretRef(current.apiKeyRef))).value;
                    } catch {
                        throw new ModelCredentialError(
                            'MODEL_API_KEY_UNRESOLVABLE',
                            'model API key is not configured; open the RPA Browser start page to finish setup',
                        );
                    }
                },
            }).resolve(provider, model);
        },
    };

    const persist = async (next: MutableModelConfig): Promise<void> => {
        const root = await readConfigFile(configPath);
        const agent = asRecord(root.agent);
        root.agent = {
            ...agent,
            model: {
                provider: next.provider,
                model: next.model,
                baseUrl: next.baseUrl,
                apiKeyRef: next.apiKeyRef,
            },
        };
        await atomicWrite(configPath, `${JSON.stringify(root, null, 2)}\n`);
    };

    const configure = async (input: AgentModelSetupInput): Promise<AgentModelSetupStatus> => {
        const provider = requireText(input.provider, 'provider', 120);
        const model = requireText(input.model, 'model', 240);
        const baseUrl = requireBaseUrl(input.baseUrl);
        const suppliedKey = input.apiKey ?? '';
        let apiKeyRef = current.apiKeyRef;
        if (suppliedKey) {
            if (suppliedKey.length > 16 * 1024) {throw new Error('apiKey is too long');}
            await atomicWrite(secretPath, `${suppliedKey}\n`);
            apiKeyRef = secretRef;
        } else {
            const usable = (() => {
                try {
                    return options.secretResolver.has(parseSecretRef(apiKeyRef));
                } catch {
                    return false;
                }
            })();
            if (!usable) {throw new Error('apiKey is required for first-time model setup');}
        }
        const next = {provider, model, baseUrl, apiKeyRef};
        await persist(next);
        current = next;
        return status();
    };

    return Object.freeze({runtime, status, defaults, configure});
};
