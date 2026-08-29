import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createWorkspaceAgentFactory} from '../../../../src/agent/workspace/factory';
import type {WorkspaceAgentService} from '../../../../src/agent/service/runtime';
import type {GovernedAgentRunResult} from '../../../../src/agent/execution/react_runner';
import {createGovernancePolicy, type GovernanceController} from '../../../../src/agent/governance';
import {createBearerAuthenticator, CAPABILITIES, createRedactionPolicy} from '../../../../src/security';
import {createCredentialRef, serializeCredentialRef, type CredentialResolver} from '../../../../src/security/credentials';
import {createPortAllocator} from '../../../../src/automation/runtime/service/ports';
import {defaultRunnerConfig} from '../../../../src/platform/config/defaults';
import {
    buildAgentFactoryDeps,
    createFactoryRunStepsDeps,
    createFauxAgentModelRuntime,
} from '../../../helpers/agent_factory_harness';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';
import {createWorkspaceProgramExecutor} from '../../../../src/agent/workspace/program_executor';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps_types';
import type {StepUnion} from '../../../../src/automation/runner/steps/types';
import type {WorldView} from '../../../../src/agent/worldview/contracts';

const unique = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

const agentService = (binding: {service: unknown}): WorkspaceAgentService =>
    binding.service as unknown as WorkspaceAgentService;

const makeConfig = () => structuredClone(defaultRunnerConfig);

const recordingController = (calls: string[]): GovernanceController => ({
    evaluate: () => {
        calls.push('evaluate');
        return {kind: 'continue'};
    },
    recordTrace: () => {
        calls.push('recordTrace');
        return {kind: 'continue'};
    },
    checkIrreversible: (effect) => {
        calls.push(`checkIrreversible:${effect.toolName}`);
        return {kind: 'continue'};
    },
    grantApproval: () => {
        calls.push('grantApproval');
        return {kind: 'continue'};
    },
    readState: () => ({
        startedAt: 0,
        trace: {metrics: {turns: 0, toolCalls: 0, readCalls: 0, controlCalls: 0, effectCalls: 0, failedToolCalls: 0, postErrorEffectCalls: 0}, tools: []},
    }),
});

test('factory modelRuntime governs which model the baseline runner resolves', async () => {
    const faux = createFauxAgentModelRuntime();
    const config = makeConfig();
    const factory = createWorkspaceAgentFactory({modelRuntime: faux.runtime});
    const binding = factory(buildAgentFactoryDeps({
        workspaceName: unique('factory-model'),
        runStepsDeps: createFactoryRunStepsDeps(config),
        runnerConfig: config,
    }));

    const result = await agentService(binding).run({
        prompt: 'hello',
        provider: faux.provider,
        model: faux.model,
        executionMode: 'react-baseline',
    });
    assert.equal(result.model, faux.model);
    assert.equal(result.text, 'done');

    await assert.rejects(
        () => agentService(binding).run({
            prompt: 'hello',
            provider: faux.provider,
            model: 'unconfigured-model',
            executionMode: 'react-baseline',
        }),
        /model not found/,
    );
});

test('factory governance policy is applied to the react baseline runner', async () => {
    const faux = createFauxAgentModelRuntime();
    const config = makeConfig();
    const policy = createGovernancePolicy({maxTurns: 1});
    const factory = createWorkspaceAgentFactory({modelRuntime: faux.runtime, governancePolicy: policy});
    const binding = factory(buildAgentFactoryDeps({
        workspaceName: unique('factory-governance-policy'),
        runStepsDeps: createFactoryRunStepsDeps(config),
        runnerConfig: config,
    }));

    const calls: string[] = [];
    const controller = recordingController(calls);
    const observedFaux = createFauxAgentModelRuntime();
    const observed = createWorkspaceAgentFactory({
        modelRuntime: observedFaux.runtime,
        governanceController: controller,
    })(buildAgentFactoryDeps({
        workspaceName: unique('factory-governance-controller'),
        runStepsDeps: createFactoryRunStepsDeps(config),
        runnerConfig: config,
    }));

    const governed = await agentService(binding).run({
        prompt: 'hello',
        provider: faux.provider,
        model: faux.model,
        executionMode: 'react-baseline',
    }) as GovernedAgentRunResult;
    assert.ok(governed.governance, 'expected a governance outcome');
    assert.equal(governed.governance?.stopReason, 'max-turns');

    const observedResult = await agentService(observed).run({
        prompt: 'hello',
        provider: observedFaux.provider,
        model: observedFaux.model,
        executionMode: 'react-baseline',
    });
    assert.equal(observedResult.text, 'done');
    assert.ok(calls.includes('recordTrace'));
});

test('factory credentialResolver is wired into DSL mutation execution', async () => {
    const CANARY = 'tok_factory_canary_7f1c9d';
    const apiRef = createCredentialRef({id: 'env:FACTORY_API', kind: 'token', provider: 'env'});
    const refString = serializeCredentialRef(apiRef);

    const executorCalls: Array<{name: string; args: Record<string, unknown>}> = [];
    const resolvedIds: string[] = [];
    const resolver: CredentialResolver = {
        resolve: async (ref) => {
            resolvedIds.push(ref.id);
            return CANARY;
        },
        has: (ref) => ref.id === 'env:FACTORY_API',
        describe: (ref) => `credential:${ref.id}`,
    };
    const executor = createWorkspaceProgramExecutor(await buildCredentialExecutorOptions({
        executorCalls,
        credentialResolver: resolver,
    }));

    const start = await executor({
        source: 'fill input.target with input.value',
        input: {target: {nodeId: 'buyer'}, value: refString},
    });

    assert.equal(start.summary.status, 'paused');
    assert.deepEqual(resolvedIds, [], 'no credential may be resolved before the mutation boundary');
    assert.ok(!JSON.stringify(start.summary).includes(CANARY));
    const debug = start.debug;
    assert.ok(debug);
    const crossed = await debug.session.crossBarrier(debug.pause.continuationId);
    assert.equal(crossed.status, 'completed');
    assert.deepEqual(resolvedIds, ['env:FACTORY_API']);
    assert.deepEqual(executorCalls, [{name: 'browser.fill', args: {nodeId: 'buyer', value: CANARY}}]);
    assert.ok(!JSON.stringify(crossed).includes(CANARY));
});

test('without a wired credentialResolver the DSL executor denies credential refs', async () => {
    const apiRef = createCredentialRef({id: 'env:FACTORY_DENIED', kind: 'token', provider: 'env'});
    const refString = serializeCredentialRef(apiRef);

    const executorCalls: Array<{name: string; args: Record<string, unknown>}> = [];
    const executor = createWorkspaceProgramExecutor(await buildCredentialExecutorOptions({executorCalls}));

    const start = await executor({
        source: 'fill input.target with input.token',
        input: {target: {nodeId: 'buyer'}, token: refString},
    });
    assert.equal(start.summary.status, 'paused');
    const debug = start.debug;
    assert.ok(debug);
    const crossed = await debug.session.crossBarrier(debug.pause.continuationId);
    assert.equal(crossed.status, 'paused');
    if (crossed.status !== 'paused') {throw new Error('expected a denied credential pause');}
    assert.equal(crossed.pause.reason, 'failure');
    assert.equal(crossed.pause.failure.code, 'ERR_SECURITY_CREDENTIAL_UNRESOLVABLE');
    assert.deepEqual(executorCalls, [], 'the browser step must never run for a denied credential');
});

type CredentialExecutorOptions = {
    executorCalls: Array<{name: string; args: Record<string, unknown>}>;
    credentialResolver?: CredentialResolver;
};

const buildCredentialExecutorOptions = async (options: CredentialExecutorOptions) => {
    const pluginHost = {
        getExecutors: () => ({
            'browser.fill': async (step: StepUnion) => {
                options.executorCalls.push({name: step.name, args: step.args as unknown as Record<string, unknown>});
                return {stepId: step.id, ok: true, data: {filled: true}};
            },
        }),
    } as unknown as RunStepsDeps['pluginHost'];
    const deps = completeRunStepsDeps({pluginHost} as never);
    const emptyProvider = {
        getCheckpoint: () => null,
        getCheckpointResolves: () => null,
        getCheckpointBody: () => null,
        listCheckpoints: () => [],
    };
    deps.resolveWorkspace = ((name: string) => ({
        name,
        workflow: {name},
        checkpoint: {getProvider: () => emptyProvider},
        entityRules: {getProvider: () => null},
        tabs: {getActiveTab: () => ({name: 'tab-1', page: {url: () => '/orders'}})},
        browserSession: {pageRegistry: {}},
    })) as never;

    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const worldView: WorldView = Object.freeze({
        workspaceName: 'ws-cred',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });

    return {
        workspaceName: 'ws-factory-cred',
        deps,
        runWorkspaceExecution: async <T>(_actionType: string, run: () => Promise<T>): Promise<T> => await run(),
        credentialResolver: options.credentialResolver,
        worldViewSource: {pin: async () => worldView},
    };
};

test('auth-enabled factory service closes on missing or wrong bearer tokens', async () => {
    const faux = createFauxAgentModelRuntime();
    const config = makeConfig();
    const token = 'factory-secret-token';
    const authenticator = createBearerAuthenticator({
        verify: async (candidate) => candidate === token
            ? {id: 'factory-svc', kind: 'service', scopes: ['agent.run']}
            : null,
    });
    const factory = createWorkspaceAgentFactory({
        modelRuntime: faux.runtime,
        security: {
            authenticator,
            redactionPolicy: createRedactionPolicy({secrets: [token]}),
            capabilities: {run: CAPABILITIES.AGENT_RUN},
        },
    });
    const binding = factory(buildAgentFactoryDeps({
        workspaceName: unique('factory-auth'),
        runStepsDeps: createFactoryRunStepsDeps(config),
        runnerConfig: config,
        portBegin: 26200,
    }));

    const started = await binding.service.start();
    const endpoint = `http://127.0.0.1:${String(started.port)}/agent`;
    try {
        const body = {prompt: 'hello', provider: faux.provider, model: faux.model, executionMode: 'react-baseline'};
        const missing = await fetch(endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
        assert.equal(missing.status, 401);
        assert.ok(!(await missing.text()).includes(token));

        const wrong = await fetch(endpoint, {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: 'Bearer wrong-token'},
            body: JSON.stringify(body),
        });
        assert.equal(wrong.status, 401);

        const accepted = await fetch(endpoint, {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
            body: JSON.stringify(body),
        });
        assert.equal(accepted.status, 200);
        assert.equal(((await accepted.json()) as {text: string}).text, 'done');
    } finally {
        await binding.service.stop();
    }
});

test('auth-disabled legacy factory service accepts unauthenticated requests', async () => {
    const faux = createFauxAgentModelRuntime();
    const config = makeConfig();
    const factory = createWorkspaceAgentFactory({modelRuntime: faux.runtime});
    const binding = factory(buildAgentFactoryDeps({
        workspaceName: unique('factory-legacy'),
        runStepsDeps: createFactoryRunStepsDeps(config),
        runnerConfig: config,
        portBegin: 26300,
    }));

    const started = await binding.service.start();
    const endpoint = `http://127.0.0.1:${String(started.port)}/agent`;
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({prompt: 'hello', provider: faux.provider, model: faux.model, executionMode: 'react-baseline'}),
        });
        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as {text: string}).text, 'done');
    } finally {
        await binding.service.stop();
    }
});

test('factory dataDir controls the agent session storage root', async () => {
    const faux = createFauxAgentModelRuntime();
    const config = makeConfig();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-data-'));
    try {
        const factory = createWorkspaceAgentFactory({modelRuntime: faux.runtime, dataDir});
        const binding = factory(buildAgentFactoryDeps({
            workspaceName: unique('factory-data'),
            runStepsDeps: createFactoryRunStepsDeps(config),
            runnerConfig: config,
        }));

        await agentService(binding).run({
            prompt: 'hello',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'react-baseline',
        });

        assert.ok(fs.readdirSync(path.join(dataDir, 'metadata')).length >= 1);
        assert.ok(fs.readdirSync(path.join(dataDir, 'reports')).length >= 1);
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('factory service binding is applied verbatim including a fixed port', async () => {
    const faux = createFauxAgentModelRuntime();
    const config = makeConfig();
    const fixedPort = 28771;
    const factory = createWorkspaceAgentFactory({
        modelRuntime: faux.runtime,
        service: {host: '127.0.0.1', port: fixedPort, agentPath: '/custom-agent', healthPath: '/custom-health'},
    });
    const binding = factory(buildAgentFactoryDeps({
        workspaceName: unique('factory-binding'),
        runStepsDeps: createFactoryRunStepsDeps(config),
        runnerConfig: config,
    }));

    const started = await binding.service.start();
    try {
        assert.equal(started.port, fixedPort);
        assert.equal(binding.service.status().port, fixedPort);

        const health = await fetch(`http://127.0.0.1:${String(fixedPort)}/custom-health`);
        assert.equal(health.status, 200);
        assert.equal(((await health.json()) as {agentPath: string}).agentPath, '/custom-agent');

        const defaultPath = await fetch(`http://127.0.0.1:${String(fixedPort)}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({prompt: 'hello', provider: faux.provider, model: faux.model, executionMode: 'react-baseline'}),
        });
        assert.equal(defaultPath.status, 404);
    } finally {
        await binding.service.stop();
    }
});

test('fixed port bypasses the allocator while auto ports reserve and release', async () => {
    const faux = createFauxAgentModelRuntime();
    const config = makeConfig();

    const fixedAllocator = createPortAllocator(28900);
    const fixedFactory = createWorkspaceAgentFactory({
        modelRuntime: faux.runtime,
        service: {port: 28991, host: '127.0.0.1', agentPath: '/agent', healthPath: '/health'},
    });
    const fixedBinding = fixedFactory(buildAgentFactoryDeps({
        workspaceName: unique('factory-fixed-port'),
        runStepsDeps: createFactoryRunStepsDeps(config),
        runnerConfig: config,
        portAllocator: fixedAllocator,
    }));
    const fixedStarted = await fixedBinding.service.start();
    assert.equal(fixedStarted.port, 28991);
    assert.deepEqual(fixedAllocator.listAllocations(), []);
    await fixedBinding.service.stop();
    assert.deepEqual(fixedAllocator.listAllocations(), []);

    const fixedRestarted = await fixedBinding.service.start();
    assert.equal(fixedRestarted.port, 28991, 'fixed port must be stable across restarts');
    await fixedBinding.service.stop();

    const autoAllocator = createPortAllocator(29000);
    const autoFactory = createWorkspaceAgentFactory({modelRuntime: faux.runtime});
    const autoBinding = autoFactory(buildAgentFactoryDeps({
        workspaceName: unique('factory-auto-port'),
        runStepsDeps: createFactoryRunStepsDeps(config),
        runnerConfig: config,
        portAllocator: autoAllocator,
    }));
    const autoStarted = await autoBinding.service.start();
    assert.ok(autoStarted.port > 0);
    assert.deepEqual(autoAllocator.listAllocations(), [
        {workspaceName: autoBinding.service.workspaceName, serviceName: 'agent', port: autoStarted.port},
    ]);
    await autoBinding.service.stop();
    assert.deepEqual(autoAllocator.listAllocations(), []);
});

const writeMetadataFixture = (dataDir: string, sessionId: string, endedAt: number): void => {
    const metadata = {
        sessionId,
        state: 'completed',
        createdAt: endedAt - 1000,
        startedAt: endedAt - 1000,
        endedAt,
        request: {prompt: 'hello', provider: 'openai', model: 'gpt-4.1'},
        error: null,
        reportAvailable: false,
    };
    const dir = path.join(dataDir, 'metadata');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(metadata), 'utf8');
};

test('factory retention is applied as an initial prune against durable sessions', async () => {
    const faux = createFauxAgentModelRuntime();
    const config = makeConfig();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-retention-'));
    const now = Date.now();
    try {
        writeMetadataFixture(dataDir, 'expired-session', now - 2 * 60 * 60 * 1000);
        writeMetadataFixture(dataDir, 'fresh-session', now - 60 * 1000);

        const factory = createWorkspaceAgentFactory({
            modelRuntime: faux.runtime,
            dataDir,
            retention: {maxAgeMs: 60 * 60 * 1000, maxCount: 1000},
        });
        factory(buildAgentFactoryDeps({
            workspaceName: unique('factory-retention'),
            runStepsDeps: createFactoryRunStepsDeps(config),
            runnerConfig: config,
        }));

        assert.equal(fs.existsSync(path.join(dataDir, 'metadata', 'expired-session.json')), false);
        assert.equal(fs.existsSync(path.join(dataDir, 'metadata', 'fresh-session.json')), true);
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});