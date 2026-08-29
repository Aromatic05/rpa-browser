import path from 'node:path';
import {createOpenAICompatibleAgentModelRuntime, type AgentModelRuntime} from '../../agent/model/runtime';
import {createGovernancePolicy, type GovernancePolicy} from '../../agent/governance';
import {createWorkspaceAgentFactory} from '../../agent/workspace/factory';
import type {WorkspaceAgentFactory} from '../../automation/runtime/workspace/agent';
import type {AgentServiceSecurityOptions} from '../../agent/service/security/contracts';
import {createBearerAuthenticator, CAPABILITIES, createRedactionPolicy} from '../../security';
import type {CredentialResolver, SecretValue} from '../../security/credentials';
import type {Principal} from '../../security/context';
import type {RunnerConfig} from '../../platform/config';
import {parseSecretRef} from '../../platform/config/secret_ref';
import {
    createSecretRefResolver,
    credentialResolverFromSecretRefResolver,
    envOf,
    nodeFileSystem,
} from '../../platform/security';
import type {SecretFileSystem} from '../../platform/security/contracts';

const AGENT_PRINCIPAL: Principal = Object.freeze({
    id: 'rpa-agent',
    kind: 'service',
    scopes: ['agent.run'],
});

export type WorkspaceAgentCompositionOptions = Readonly<{
    env?: Record<string, string | undefined>;
    fs?: SecretFileSystem;
    baseDir?: string;
    requirePrivateFileMode?: boolean;
}>;

export type WorkspaceAgentAuthDescription = Readonly<{
    enabled: boolean;
    tokenRef: string;
    description: string;
}>;

export type WorkspaceAgentComposition = Readonly<{
    agentFactory: WorkspaceAgentFactory;
    modelRuntime: AgentModelRuntime | undefined;
    governance: GovernancePolicy;
    credentialResolver: CredentialResolver;
    auth: WorkspaceAgentAuthDescription;
    dataDir: string;
    interaction: 'interactive' | 'headless';
    describe: () => Readonly<Record<string, unknown>>;
}>;

const assertConfigurationComplete = (provider: string, model: string, baseUrl: string): void => {
    if (provider.length > 0 || model.length > 0 || baseUrl.length > 0) {
        if (provider.length === 0 || model.length === 0 || baseUrl.length === 0) {
            throw new Error(
                `agent.model defaults must be configured together (all or none), got ` +
                    `provider=${JSON.stringify(provider)}, model=${JSON.stringify(model)}, baseUrl=${JSON.stringify(baseUrl)}`,
            );
        }
    }
};

export const composeWorkspaceAgentDependencies = async (
    config: RunnerConfig,
    options: WorkspaceAgentCompositionOptions = {},
): Promise<WorkspaceAgentComposition> => {
    const baseDir = path.resolve(options.baseDir ?? process.cwd());
    const env = options.env ?? process.env;

    const secretResolver = createSecretRefResolver({
        env: envOf(env),
        fs: options.fs ?? nodeFileSystem(),
        baseDir,
        requirePrivateFileMode: options.requirePrivateFileMode ?? true,
    });
    const credentialResolver = credentialResolverFromSecretRefResolver(secretResolver);

    const modelDefaults = config.agent.model;
    assertConfigurationComplete(modelDefaults.provider, modelDefaults.model, modelDefaults.baseUrl);
    let modelRuntime: AgentModelRuntime | undefined;
    if (modelDefaults.provider.length > 0) {
        const apiKey = (await secretResolver.resolve(parseSecretRef(modelDefaults.apiKeyRef))).value;
        modelRuntime = createOpenAICompatibleAgentModelRuntime({
            provider: modelDefaults.provider,
            model: modelDefaults.model,
            baseUrl: modelDefaults.baseUrl,
            apiKey,
        });
    }

    const governance = createGovernancePolicy({...config.agent.governance});
    const dataDir = path.resolve(baseDir, config.agent.sessions.storageRoot);
    const reportRoot = path.join(dataDir, 'reports');

    const authEnabled = config.agent.auth.enabled;
    const tokenRefString = config.agent.auth.tokenRef;
    let security: AgentServiceSecurityOptions | undefined;
    let authDescription: string;
    if (authEnabled) {
        const tokenRef = parseSecretRef(tokenRefString);
        const resolved = await secretResolver.resolve(tokenRef);
        const token: SecretValue = resolved.value;
        security = {
            authenticator: createBearerAuthenticator({
                verify: async (candidate: string) => (candidate === token ? AGENT_PRINCIPAL : null),
            }),
            redactionPolicy: createRedactionPolicy({secrets: [token]}),
            capabilities: {run: CAPABILITIES.AGENT_RUN},
        };
        authDescription = `agent service auth enabled (${secretResolver.describe(tokenRef)})`;
    } else {
        authDescription = 'agent service auth disabled (legacy unsecured mode)';
    }

    const agentFactory = createWorkspaceAgentFactory({
        modelRuntime,
        governancePolicy: governance,
        credentialResolver,
        dataDir,
        security,
        service: {...config.agent.service},
        retention: {...config.agent.sessions.retention},
        interaction: config.agent.interaction,
    });

    const describe = (): Readonly<Record<string, unknown>> => ({
        model: {...modelDefaults},
        governance: {...governance},
        service: {
            ...config.agent.service,
            port: config.agent.service.port === 0 ? 'auto' : config.agent.service.port,
        },
        sessions: {
            storageRoot: config.agent.sessions.storageRoot,
            retention: {...config.agent.sessions.retention},
        },
        reports: {
            root: reportRoot,
            retention: {...config.agent.sessions.retention},
            coStoredWithSessions: true,
        },
        auth: {enabled: authEnabled, tokenRef: tokenRefString, description: authDescription},
        interaction: config.agent.interaction,
        dataDir,
    });

    return {
        agentFactory,
        modelRuntime,
        governance,
        credentialResolver,
        auth: {
            enabled: authEnabled,
            tokenRef: tokenRefString,
            description: authDescription,
        },
        dataDir,
        interaction: config.agent.interaction,
        describe,
    };
};