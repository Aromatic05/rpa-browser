import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createPortAllocator} from '../../../../src/automation/runtime/service/ports';
import {createWorkspaceAgentService} from '../../../../src/agent/service/runtime';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import {createAgentExecutionRouter} from '../../../../src/agent/execution/router';
import {createReactAgentRunner} from '../../../../src/agent/execution/react_runner';
import {createWorkspaceProgramExecutor} from '../../../../src/agent/workspace/program_executor';
import {createWorkspaceAgentFactory} from '../../../../src/agent/workspace/factory';
import type {WorkspaceAgentService} from '../../../../src/agent/service/runtime';
import {buildAgentFactoryDeps} from '../../../helpers/agent_factory_harness';
import {defaultRunnerConfig} from '../../../../src/platform/config/defaults';
import type {WorkspaceEntityRulesProvider} from '../../../../src/automation/snapshot/rules/runtime/contracts';
import type {WorkflowEntityRules} from '../../../../src/automation/workflow';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps_types';
import type {StepUnion} from '../../../../src/automation/runner/steps/types';
import type {WorldView} from '../../../../src/agent/worldview/contracts';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';
import {createFauxAgentModelRuntime, type OfflineModelRuntime} from '../../../helpers/agent_factory_harness';

const unique = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

const emptyCheckpointProvider = {
    getCheckpoint: () => null,
    getCheckpointResolves: () => null,
    getCheckpointBody: () => null,
    listCheckpoints: () => [],
};

const irreversibleRulesProvider: WorkspaceEntityRulesProvider = {
    availability: 'ready',
    workflowName: 'ws-hitl',
    listProfiles: () => ['orders'],
    getProfile: (name) => ({kind: 'entity_rules', name, match: {}, annotation: {}}) as unknown as WorkflowEntityRules,
    resolveExports: (profileName) => ({
        index: {
            profileName,
            entities: [{
                profileName,
                entityKey: 'orderForm',
                businessTag: 'order.form',
                kind: 'form',
                fields: [{
                    fieldKey: 'name',
                    targetKind: 'form.field',
                    effect: {reversibility: 'reversible'},
                }],
                actions: [{
                    actionIntent: 'submit',
                    targetKind: 'form.action',
                    effect: {reversibility: 'irreversible'},
                }],
                columns: [],
                rowActions: [],
                supportedQueries: [],
                members: [
                    {kind: 'field', symbol: 'name'},
                    {kind: 'action', symbol: 'submit'},
                ],
            }],
            resolve: (entityKey, symbol) =>
                entityKey === 'orderForm' && (symbol === 'submit' || symbol === 'name')
                    ? {kind: symbol === 'submit' ? 'action' : 'field', symbol}
                    : undefined,
        },
        diagnostics: [],
    }),
};

type ExecutorOptions = {
    clickCalls?: string[];
    failClick?: boolean;
    fillCalls?: string[];
    failFill?: boolean;
};

const buildExecutorOptions = async (options: ExecutorOptions = {}) => {
    const pluginHost = {
        getExecutors: () => ({
            'browser.query': async (step: StepUnion) => ({
                stepId: step.id,
                ok: true,
                data: {kind: 'nodeId', nodeId: 'submit'},
            }),
            'browser.click': async (step: StepUnion) => {
                options.clickCalls?.push(step.name);
                if (options.failClick) {
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {code: 'ERR_CLICK', message: 'click failed'},
                    };
                }
                return {stepId: step.id, ok: true, data: {clicked: true}};
            },
            'browser.fill': async (step: StepUnion) => {
                options.fillCalls?.push(step.name);
                if (options.failFill) {
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {code: 'ERR_FILL', message: 'fill failed'},
                    };
                }
                return {stepId: step.id, ok: true, data: {filled: true}};
            },
        }),
    } as unknown as RunStepsDeps['pluginHost'];

    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const worldView: WorldView = Object.freeze({
        workspaceName: 'ws-hitl',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });

    const deps = completeRunStepsDeps({
        pluginHost,
        resolveEntityRulesProvider: () => irreversibleRulesProvider,
        pageSession: {ensureFresh: async () => entry},
    } as never);
    const baseWorkspace = deps.resolveWorkspace('ws-hitl');
    deps.resolveWorkspace = ((name: string) => ({
        ...(baseWorkspace as object),
        name,
        workflow: {name},
        checkpoint: {getProvider: () => emptyCheckpointProvider},
        entityRules: {getProvider: () => irreversibleRulesProvider},
    })) as never;

    return {
        workspaceName: 'ws-hitl',
        deps,
        runWorkspaceExecution: async <T>(_actionType: string, run: () => Promise<T>): Promise<T> => await run(),
        worldViewSource: {pin: async () => worldView},
    };
};

const IRREVERSIBLE_SOURCE = [
    'use entity_rules "orders" as order',
    'click order.orderForm.submit',
    'output done = input.done',
].join('\n');

const FAILING_REVERSIBLE_SOURCE = [
    'use entity_rules "orders" as order',
    'fill order.orderForm.name with input.value',
    'output done = input.done',
].join('\n');

const COMPLETING_REVERSIBLE_SOURCE = [
    'use entity_rules "orders" as order',
    'fill order.orderForm.name with input.value',
    'output done = input.done',
].join('\n');

const buildRunner = async (options: ExecutorOptions = {}) => {
    const faux = createFauxAgentModelRuntime();
    const executor = createWorkspaceProgramExecutor(await buildExecutorOptions(options));
    const programRunner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: executor,
        modelRuntime: faux.runtime,
    });
    const baselineRunner = createReactAgentRunner({tools: [], modelRuntime: faux.runtime});
    return {
        runner: createAgentExecutionRouter({program: programRunner, baseline: baselineRunner, defaultMode: 'program'}),
        faux,
    };
};

const buildService = async (options: {
    interaction?: 'interactive' | 'headless';
    dataDir?: string;
    executorOptions?: ExecutorOptions;
} = {}) => {
    const portAllocator = createPortAllocator(27000);
    const {runner, faux} = await buildRunner(options.executorOptions);
    const service = createWorkspaceAgentService({
        workspaceName: 'ws-hitl',
        portAllocator,
        runner,
        interaction: options.interaction,
        ...(options.dataDir ? {dataDir: options.dataDir} : {}),
    });
    return {service, faux};
};

const hitlRequest = (faux: OfflineModelRuntime, source: string) => ({
    prompt: 'approve the irreversible effect',
    provider: faux.provider,
    model: faux.model,
    source,
    input: {value: 'ACME', done: true},
});

const runSource = async (
    service: ReturnType<typeof createWorkspaceAgentService>,
    faux: OfflineModelRuntime,
    source: string,
) => {
    const {sessionId} = await service.sessions.runTracked(hitlRequest(faux, source));
    return {sessionId, snapshot: service.sessions.status(sessionId)!};
};

test('production approve resumes the SAME retained transaction and executes the effect exactly once', async () => {
    const clickCalls: string[] = [];
    const {service, faux} = await buildService({executorOptions: {clickCalls}});
    try {
        const {sessionId, snapshot} = await runSource(service, faux, IRREVERSIBLE_SOURCE);

        assert.equal(snapshot.state, 'paused');
        assert.equal(snapshot.resumable, true);
        assert.equal(snapshot.result?.programs?.[0].status, 'paused');
        assert.equal(snapshot.result?.programs?.[0].pause?.reason, 'barrier');
        assert.equal(snapshot.result?.programs?.[0].pause?.risk, 'irreversible');
        assert.deepEqual(clickCalls, [], 'the irreversible effect must not run before approval');

        const interactions = service.sessions.listInteractions(sessionId)!;
        assert.equal(interactions.length, 1);
        assert.equal(interactions[0].kind, 'approval');
        assert.equal(interactions[0].payload.kind, 'approval');
        if (interactions[0].payload.kind === 'approval') {
            assert.equal(interactions[0].payload.actionName, 'browser.click');
        }

        const decided = await service.sessions.approveInteraction(
            sessionId,
            interactions[0].id,
            interactions[0].revision,
            'ops-1',
        );
        assert.equal(decided!.interaction.status, 'approved');
        assert.equal(decided!.session.state, 'completed');
        assert.deepEqual(clickCalls, ['browser.click'], 'approval must cross the barrier and run the click once');
        assert.equal(decided!.session.result?.text.includes('done'), true);
    } finally {
        await service.stop();
    }
});

test('production deny never cancels: the denied effect is not executed and the task is not cancelled', async () => {
    const clickCalls: string[] = [];
    const {service, faux} = await buildService({executorOptions: {clickCalls}});
    try {
        const {sessionId, snapshot} = await runSource(service, faux, IRREVERSIBLE_SOURCE);
        const interaction = service.sessions.listInteractions(sessionId)![0];

        const decided = await service.sessions.denyInteraction(
            sessionId,
            interaction.id,
            interaction.revision,
            'ops-2',
            'not safe',
        );
        assert.equal(decided!.interaction.status, 'denied');
        assert.notEqual(decided!.session.state, 'cancelled', 'denial must never cancel the task');
        assert.notEqual(decided!.session.error?.code, 'ERR_SESSION_INTERACTION_DENIED');
        assert.deepEqual(clickCalls, [], 'denial must never execute the irreversible effect');
        assert.equal(snapshot.resumable, true);
    } finally {
        await service.stop();
    }
});

test('production failure pause produces no approval interaction and is not resumable', async () => {
    const fillCalls: string[] = [];
    const {service, faux} = await buildService({executorOptions: {fillCalls, failFill: true}});
    try {
        const {sessionId, snapshot} = await runSource(service, faux, FAILING_REVERSIBLE_SOURCE);

        assert.equal(snapshot.state, 'paused');
        assert.equal(snapshot.result?.programs?.[0].pause?.reason, 'failure');
        assert.equal(snapshot.resumable, false);
        assert.deepEqual(snapshot.interactions, []);
        assert.deepEqual(fillCalls, ['browser.fill'], 'the failure occurred while executing the reversible fill');
    } finally {
        await service.stop();
    }
});

test('production headless policy blocks approval-required effects with no pending interaction', async () => {
    const clickCalls: string[] = [];
    const {service, faux} = await buildService({interaction: 'headless', executorOptions: {clickCalls}});
    try {
        const {sessionId, snapshot} = await runSource(service, faux, IRREVERSIBLE_SOURCE);

        assert.equal(snapshot.state, 'cancelled');
        assert.equal(snapshot.error?.code, 'ERR_SESSION_INTERACTION_BLOCKED');
        assert.deepEqual(snapshot.interactions, []);
        assert.deepEqual(clickCalls, [], 'headless must block the irreversible effect deterministically');
        assert.deepEqual(service.sessions.listInteractions(sessionId), []);
    } finally {
        await service.stop();
    }
});

test('production stale revision and foreign session are rejected', async () => {
    const {service, faux} = await buildService();
    try {
        // The first task completes (releasing the workspace reservation) so a
        // second task can start and pause with its own interaction.
        const first = await runSource(service, faux, COMPLETING_REVERSIBLE_SOURCE);
        assert.equal(service.sessions.status(first.sessionId)?.state, 'completed');
        const second = await runSource(service, faux, IRREVERSIBLE_SOURCE);
        const interaction = service.sessions.listInteractions(second.sessionId)![0];

        await assert.rejects(
            () => service.sessions.approveInteraction(second.sessionId, interaction.id, interaction.revision - 1, 'ops-1'),
            (error: unknown) => error instanceof Error
                && (error as Error & {code?: string}).code === 'ERR_INTERACTION_CONCURRENCY',
        );
        assert.equal(
            await service.sessions.approveInteraction(first.sessionId, interaction.id, interaction.revision, 'ops-1'),
            null,
        );
        assert.equal(service.sessions.getInteraction(first.sessionId, interaction.id), null);
        assert.equal(service.sessions.status(second.sessionId)?.state, 'paused');
    } finally {
        await service.stop();
    }
});

test('production paused sessions remain explicitly non-resumable after restart', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitl-restart-'));
    const clickCalls: string[] = [];
    try {
        const first = await buildService({executorOptions: {clickCalls}, dataDir});
        const {sessionId, snapshot} = await runSource(first.service, first.faux, IRREVERSIBLE_SOURCE);
        assert.equal(snapshot.resumable, true);
        const interaction = first.service.sessions.listInteractions(sessionId)![0];

        const second = await buildService({dataDir});
        const recovered = second.service.sessions.status(sessionId)!;
        assert.equal(recovered.state, 'paused');
        assert.equal(recovered.resumable, false);
        assert.deepEqual(recovered.interactions, []);
        assert.equal(
            await second.service.sessions.approveInteraction(sessionId, interaction.id, interaction.revision, 'ops-1'),
            null,
        );
        assert.deepEqual(clickCalls, [], 'no effect executes across the restart boundary');
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('production service exposes the full approve flow over HTTP', async () => {
    const clickCalls: string[] = [];
    const {service, faux} = await buildService({executorOptions: {clickCalls}});
    const started = await service.start();
    try {
        const response = await fetch(`http://127.0.0.1:${String(started.port)}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(hitlRequest(faux, IRREVERSIBLE_SOURCE)),
        });
        assert.equal(response.status, 200);
        const sessionId = response.headers.get('x-session-id')!;

        const listed = await fetch(`http://127.0.0.1:${String(started.port)}/agent/sessions/${sessionId}/interactions`);
        const body = await listed.json() as any;
        assert.equal(body.interactions.length, 1);
        const interaction = body.interactions[0];
        assert.equal(interaction.kind, 'approval');

        const approved = await fetch(
            `http://127.0.0.1:${String(started.port)}/agent/sessions/${sessionId}/interactions/${interaction.id}/approve`,
            {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({revision: interaction.revision, approvedBy: 'ops-1'}),
            },
        );
        assert.equal(approved.status, 200);
        const decision = await approved.json() as any;
        assert.equal(decision.interaction.status, 'approved');
        assert.equal(decision.session.state, 'completed');
        assert.deepEqual(clickCalls, ['browser.click']);
    } finally {
        await service.stop();
    }
});

test('factory interaction policy is honored for approval-required effects', async () => {
    const clickCalls: string[] = [];
    const executorOptions = await buildExecutorOptions({clickCalls});
    const config = structuredClone(defaultRunnerConfig);
    const faux = createFauxAgentModelRuntime();
    const interactiveFactory = createWorkspaceAgentFactory({
        modelRuntime: faux.runtime,
        interaction: 'interactive',
    });
    const interactive = interactiveFactory(buildAgentFactoryDeps({
        workspaceName: unique('factory-hitl-interactive'),
        runStepsDeps: executorOptions.deps,
        runnerConfig: config,
        portBegin: 27100,
    })).service as WorkspaceAgentService;
    const headlessFactory = createWorkspaceAgentFactory({
        modelRuntime: faux.runtime,
        interaction: 'headless',
    });
    const headless = headlessFactory(buildAgentFactoryDeps({
        workspaceName: unique('factory-hitl-headless'),
        runStepsDeps: executorOptions.deps,
        runnerConfig: config,
        portBegin: 27200,
    })).service as WorkspaceAgentService;

    try {
        const interactiveRun = await interactive.sessions.runTracked(hitlRequest(faux, IRREVERSIBLE_SOURCE));
        const interactiveSnapshot = interactive.sessions.status(interactiveRun.sessionId)!;
        assert.equal(interactiveSnapshot.state, 'paused');
        assert.equal(interactiveSnapshot.interactions.length, 1);
        assert.equal(interactiveSnapshot.interactions[0].kind, 'approval');
        const interaction = interactive.sessions.listInteractions(interactiveRun.sessionId)![0];
        const decided = await interactive.sessions.approveInteraction(
            interactiveRun.sessionId,
            interaction.id,
            interaction.revision,
            'ops-1',
        );
        assert.equal(decided!.session.state, 'completed');
        assert.deepEqual(clickCalls, ['browser.click']);

        const headlessRun = await headless.sessions.runTracked(hitlRequest(faux, IRREVERSIBLE_SOURCE));
        const headlessSnapshot = headless.sessions.status(headlessRun.sessionId)!;
        assert.equal(headlessSnapshot.state, 'cancelled');
        assert.equal(headlessSnapshot.error?.code, 'ERR_SESSION_INTERACTION_BLOCKED');
        assert.deepEqual(headlessSnapshot.interactions, []);
        assert.deepEqual(clickCalls, ['browser.click'], 'headless adds no further effect executions');
    } finally {
        await interactive.stop();
        await headless.stop();
    }
});