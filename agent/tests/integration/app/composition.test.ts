import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadRunnerConfig} from '../../../src/platform/config/loader';
import {defaultAgentConfig} from '../../../src/platform/config/defaults';
import {createCredentialRef} from '../../../src/security/credentials';
import {composeWorkspaceAgentDependencies} from '../../../src/app/entrypoints/composition';

const withRunnerFile = async (json: unknown, run: (configPath: string) => Promise<void>): Promise<void> => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-composition-'));
    const configPath = path.join(directory, 'runner.json');
    try {
        writeFileSync(configPath, JSON.stringify(json));
        await run(configPath);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
};

test('config and env values reach the composed factory and service options', async () => {
    await withRunnerFile({
        agent: {
            model: {
                provider: 'openai',
                model: 'gpt-4.1',
                baseUrl: 'https://api.example.test/v1',
                apiKeyRef: 'env:TEST_API_KEY',
            },
            governance: {maxTurns: 7, maxRecoveryAttempts: 9},
            sessions: {storageRoot: path.join('.artifacts', 'custom-sessions')},
            reports: {root: path.join('.artifacts', 'custom-sessions', 'reports')},
            service: {host: '0.0.0.0'},
            interaction: 'headless',
        },
    }, async (configPath) => {
        const config = loadRunnerConfig({configPath});
        const env: Record<string, string | undefined> = {TEST_API_KEY: 'api-key-value'};
        const envBefore = JSON.stringify(env);
        const composed = await composeWorkspaceAgentDependencies(config, {env});
        assert.equal(JSON.stringify(env), envBefore, 'compose must not mutate the caller env object');

        const modelRuntime = composed.modelRuntime;
        assert.ok(modelRuntime, 'model defaults must produce a model runtime');
        const binding = modelRuntime.resolve('openai', 'gpt-4.1');
        assert.ok(binding);
        assert.equal(binding.model.id, 'gpt-4.1');
        assert.equal(binding.model.provider, 'openai');
        assert.equal(await binding.getApiKey?.('openai'), 'api-key-value');
        assert.equal(modelRuntime.resolve('openai', 'other'), null);

        assert.equal(composed.governance.maxTurns, 7);
        assert.equal(composed.governance.maxRecoveryAttempts, 9);

        assert.ok(composed.dataDir.endsWith(path.join('.artifacts', 'custom-sessions')));
        assert.equal(composed.auth.enabled, false);
        assert.equal(composed.interaction, 'headless');

        const description = composed.describe();
        const service = description.service as {host: string; port: number | string; agentPath: string; healthPath: string};
        assert.equal(service.host, '0.0.0.0');
        assert.equal(service.agentPath, '/agent');
        assert.equal(service.healthPath, '/health');
        assert.equal(service.port, 'auto');
        assert.equal(description.interaction, 'headless');
        const sessions = description.sessions as {storageRoot: string; retention: {maxAgeMs: number; maxCount: number}};
        assert.equal(sessions.storageRoot, path.join('.artifacts', 'custom-sessions'));
        assert.equal(sessions.retention.maxAgeMs, 7 * 24 * 60 * 60 * 1000);
        const reports = description.reports as {root: string; retention: {maxAgeMs: number; maxCount: number}; coStoredWithSessions: boolean};
        assert.ok(reports.root.endsWith(path.join('.artifacts', 'custom-sessions', 'reports')));
        assert.deepEqual(reports.retention, sessions.retention, 'co-stored reports must share one coherent retention policy');
        assert.equal(reports.coStoredWithSessions, true);
        const serialized = JSON.stringify(description);
        assert.ok(serialized.includes('env:TEST_API_KEY'));
        assert.ok(!serialized.includes('api-key-value'));
        assert.equal(Object.hasOwn(binding.model, 'apiKey'), false);

        const credRef = createCredentialRef({id: 'env:TEST_API_KEY', kind: 'credential'});
        assert.equal(await composed.credentialResolver.resolve(credRef), 'api-key-value');
        assert.equal(composed.credentialResolver.has(credRef), true);
        assert.equal(composed.credentialResolver.describe(credRef), 'resolved from environment TEST_API_KEY');
    });
});

test('auth-enabled composition fails closed when the token ref is missing', async () => {
    await withRunnerFile({
        agent: {auth: {enabled: true, tokenRef: 'env:RPA_TEST_AUTH_TOKEN'}},
    }, async (configPath) => {
        const config = loadRunnerConfig({configPath});
        await assert.rejects(
            composeWorkspaceAgentDependencies(config, {env: {}}),
            (error: unknown) => error instanceof Error && error.message.includes('RPA_TEST_AUTH_TOKEN'),
        );
    });
});

test('raw token is absent from config and loggable descriptions', async () => {
    await withRunnerFile({
        agent: {auth: {enabled: true, tokenRef: 'env:TEST_AUTH_TOKEN'}},
    }, async (configPath) => {
        const config = loadRunnerConfig({configPath});
        const composed = await composeWorkspaceAgentDependencies(config, {
            env: {TEST_AUTH_TOKEN: 'super-secret-token-abc'},
        });

        const serialized = JSON.stringify(composed.describe());
        assert.ok(serialized.includes('env:TEST_AUTH_TOKEN'));
        assert.ok(!serialized.includes('super-secret-token-abc'));
        assert.equal(composed.auth.enabled, true);
        assert.equal(composed.auth.tokenRef, 'env:TEST_AUTH_TOKEN');
        assert.equal(
            composed.auth.description,
            'agent service auth enabled (resolved from environment TEST_AUTH_TOKEN)',
        );

        const agentConfig = JSON.stringify(config.agent);
        assert.ok(agentConfig.includes('env:TEST_AUTH_TOKEN'));
        assert.ok(!agentConfig.includes('super-secret-token-abc'));
        assert.equal(agentConfig.includes('"token":'), false);
        assert.equal(agentConfig.includes('"apiKey":'), false);
    });
});

test('model and governance defaults from the committed config are actually applied', async () => {
    await withRunnerFile({}, async (configPath) => {
        const config = loadRunnerConfig({configPath});
        const composed = await composeWorkspaceAgentDependencies(config, {env: {}});

        assert.equal(composed.governance.maxTurns, defaultAgentConfig.governance.maxTurns);
        assert.equal(composed.governance.maxToolCalls, defaultAgentConfig.governance.maxToolCalls);
        assert.equal(composed.governance.maxWorldEffects, defaultAgentConfig.governance.maxWorldEffects);
        assert.equal(composed.governance.maxPostErrorEffects, defaultAgentConfig.governance.maxPostErrorEffects);
        assert.equal(composed.governance.maxRecoveryAttempts, defaultAgentConfig.governance.maxRecoveryAttempts);
        assert.equal(composed.governance.wallClockDeadlineMs, defaultAgentConfig.governance.wallClockDeadlineMs);
        assert.equal(composed.governance.irreversibleApproval, defaultAgentConfig.governance.irreversibleApproval);

        assert.equal(composed.modelRuntime, undefined, 'unconfigured model defaults keep the env fallback');
        assert.equal(composed.dataDir.endsWith(path.join('.artifacts', 'sessions')), true);
        assert.equal(composed.auth.enabled, false);
        assert.equal(composed.interaction, 'interactive');

        const sessions = composed.describe().sessions as {retention: {maxAgeMs: number; maxCount: number}};
        assert.deepEqual(sessions.retention, defaultAgentConfig.sessions.retention);
        const reports = composed.describe().reports as {root: string; retention: {maxAgeMs: number; maxCount: number}; coStoredWithSessions: boolean};
        assert.ok(reports.root.endsWith(path.join('.artifacts', 'sessions', 'reports')));
        assert.deepEqual(reports.retention, defaultAgentConfig.sessions.retention);
        assert.equal(reports.coStoredWithSessions, true);
    });
});

test('config validation rejects a report root that is not co-located with sessions', async () => {
    await withRunnerFile({
        agent: {reports: {root: '.artifacts/reports'}},
    }, async (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.reports\.root/);
    });
    await withRunnerFile({}, async (configPath) => {
        const config = loadRunnerConfig({configPath});
        assert.equal(config.agent.reports.root, path.join('.artifacts', 'sessions', 'reports'));
    });
});

test('config validation rejects a report retention that diverges from sessions while co-stored', async () => {
    await withRunnerFile({
        agent: {reports: {retention: {maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxCount: 200}}},
    }, async (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.reports\.retention/);
    });
});

test('interaction policy is surfaced truthfully and threaded from config', async () => {
    await withRunnerFile({
        agent: {interaction: 'headless'},
    }, async (configPath) => {
        const config = loadRunnerConfig({configPath});
        const composed = await composeWorkspaceAgentDependencies(config, {env: {}});
        assert.equal(composed.interaction, 'headless');
        assert.equal(composed.describe().interaction, 'headless');
    });
    await withRunnerFile({}, async (configPath) => {
        const config = loadRunnerConfig({configPath});
        const composed = await composeWorkspaceAgentDependencies(config, {env: {}});
        assert.equal(composed.interaction, 'interactive');
    });
});

test('agent and mcp entrypoints share one composition strategy', async () => {
    const entryDir = path.resolve(import.meta.dirname, '../../../src/app/entrypoints');
    const agentSource = readFileSync(path.join(entryDir, 'agent.ts'), 'utf8');
    const mcpSource = readFileSync(path.join(entryDir, 'mcp.ts'), 'utf8');

    for (const source of [agentSource, mcpSource]) {
        assert.ok(source.includes(`from './composition'`), 'entrypoint must import the shared composition');
        assert.ok(source.includes('composeWorkspaceAgentDependencies'), 'entrypoint must call the shared composer');
        assert.ok(source.includes('composed.agentFactory'), 'entrypoint must bind the composed factory');
        assert.ok(!source.includes('createWorkspaceAgentFactory('), 'entrypoint must not build the factory inline');
    }

    await withRunnerFile({}, async (configPath) => {
        const config = loadRunnerConfig({configPath});
        const env = {TEST_AUTH_TOKEN: 'value'};
        const agent = await composeWorkspaceAgentDependencies(config, {env});
        const mcp = await composeWorkspaceAgentDependencies(config, {env: {...env}});
        assert.deepEqual(mcp.describe(), agent.describe());
        assert.deepEqual(mcp.auth, agent.auth);
        assert.deepEqual(mcp.governance, agent.governance);
        assert.equal(mcp.interaction, agent.interaction);
    });
});