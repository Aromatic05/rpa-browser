import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createWorkspaceAgentFactory} from '../../../../src/agent/workspace/factory';
import type {WorkspaceAgentService} from '../../../../src/agent/service/runtime';
import {buildAgentFactoryDeps} from '../../../helpers/agent_factory_harness';
import {defaultRunnerConfig} from '../../../../src/platform/config/defaults';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import {createWorkflowOnFs} from '../../../../src/automation/workflow';
import {createWorkspaceCheckpointProvider} from '../../../../src/automation/checkpoint/provider';
import {createWorkspaceEntityRulesProvider} from '../../../../src/automation/snapshot/rules';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';
import {
    createScriptedModelRuntime,
    lastToolResult,
    parseJson,
    assistant,
    tool,
    type ModelScript,
} from '../../../helpers/agent_product_faux';
import {
    populateLibraryWorkspace,
    NESTED_CHECK_PROCEDURE,
    ORDERS_PAGE_PROFILE,
} from '../../../helpers/library_harness';

const unique = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

const PROGRAM_SOURCE = [
    `use entity_rules "${ORDERS_PAGE_PROFILE}" as orders`,
    `use checkpoint "${NESTED_CHECK_PROCEDURE}" with {`,
    '  orderNo: input.orderNo',
    '}',
    'output done = input.orderNo',
].join('\n');

/**
 * A real Program-first run constructed entirely by createWorkspaceAgentFactory:
 * the scripted model discovers the workspace knowledge through
 * agent.knowledge.catalog/inspect (proving the factory wired the committed
 * workspace Library + live Entity Rules provider), then executes a DSL that
 * references the discovered Procedure in the SAME single transaction.
 */
test('factory-built Program-first Agent can discover and inspect workspace knowledge then execute a DSL referencing it', async () => {
    const workspaceName = unique('factory-knowledge');
    const workflow = createWorkflowOnFs(workspaceName);
    populateLibraryWorkspace(workflow, workspaceName);
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });

    const deps = completeRunStepsDeps({
        pageSession: {ensureFresh: async () => entry},
    } as never, {
        page: {url: () => '/orders'},
        tabName: 'tab-1',
        workspaceName,
    } as never);
    const baseWorkspace = deps.resolveWorkspace(workspaceName);
    deps.resolveWorkspace = ((name: string) => ({
        ...(baseWorkspace as object),
        name,
        workflow,
        checkpoint: {getProvider: () => createWorkspaceCheckpointProvider(workflow)},
        entityRules: {getProvider: () => createWorkspaceEntityRulesProvider(workflow)},
    })) as never;

    const script: ModelScript = (() => {
        let phase = 0;
        return (context) => {
            if (!lastToolResult(context.messages)) {
                phase = 1;
                return tool('agent.knowledge.catalog', {kind: 'procedure'});
            }
            if (phase === 1) {
                phase = 2;
                return tool('agent.knowledge.inspect', {kind: 'procedure', name: NESTED_CHECK_PROCEDURE});
            }
            if (phase === 2) {
                phase = 3;
                return tool('agent.knowledge.inspect', {kind: 'page_knowledge', name: ORDERS_PAGE_PROFILE});
            }
            if (phase === 3) {
                const schema = parseJson<{status?: string; entities?: ReadonlyArray<{entityKey?: string}>}>(
                    lastToolResult(context.messages)?.text ?? '',
                );
                if (schema?.status !== 'loaded' || schema.entities?.[0]?.entityKey !== 'ordersQuery') {
                    throw new Error('factory wiring returned no sanitized Page Knowledge schema');
                }
                phase = 4;
                return tool('agent.execute_program', {source: PROGRAM_SOURCE, input: {orderNo: 'ABC-9'}});
            }
            return assistant('The retained program completed through the factory-wired knowledge seam.');
        };
    })();
    const faux = createScriptedModelRuntime(script);

    const factory = createWorkspaceAgentFactory({modelRuntime: faux.runtime});
    const service = factory({
        ...buildAgentFactoryDeps({
            workspaceName,
            runStepsDeps: deps,
            runnerConfig: defaultRunnerConfig,
            portBegin: 28000,
        }),
        tabs: {getActiveTab: () => null} as never,
    }).service as WorkspaceAgentService;

    try {
        const {sessionId} = await service.sessions.runTracked({
            prompt: 'Discover library knowledge, inspect it, then execute a program referencing the discovered Procedure.',
            provider: faux.provider,
            model: faux.model,
        });
        const snapshot = service.sessions.status(sessionId)!;
        assert.equal(snapshot.state, 'completed');
        assert.equal(snapshot.result?.programs?.length, 1, 'exactly one program transaction');
        assert.equal(snapshot.result?.programs?.[0].status, 'completed');
        assert.equal(snapshot.result?.programs?.[0].text, '{"done":"ABC-9"}');

        const tools = snapshot.result?.trace.tools.map((item) => item.toolName) ?? [];
        assert.deepEqual(tools, [
            'agent.knowledge.catalog',
            'agent.knowledge.inspect',
            'agent.knowledge.inspect',
            'agent.execute_program',
        ]);
    } finally {
        await service.stop();
    }
});

/**
 * Prove the factory actually reuses the committed workspace Library backed by
 * this workspace's workflow: the catalog must surface the REAL fixture assets.
 */
test('factory-wired knowledge catalog returns the real workspace Library assets', async () => {
    const workspaceName = unique('factory-knowledge-catalog');
    const workflow = createWorkflowOnFs(workspaceName);
    populateLibraryWorkspace(workflow, workspaceName);
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const deps = completeRunStepsDeps({
        pageSession: {ensureFresh: async () => entry},
    } as never, {
        page: {url: () => '/orders'},
        tabName: 'tab-1',
        workspaceName,
    } as never);
    const baseWorkspace = deps.resolveWorkspace(workspaceName);
    deps.resolveWorkspace = ((name: string) => ({
        ...(baseWorkspace as object),
        name,
        workflow,
        checkpoint: {getProvider: () => createWorkspaceCheckpointProvider(workflow)},
        entityRules: {getProvider: () => createWorkspaceEntityRulesProvider(workflow)},
    })) as never;

    const faux = createScriptedModelRuntime(((context) => {
        const last = lastToolResult(context.messages);
        if (!last) {
            return tool('agent.knowledge.catalog', {});
        }
        const catalog = parseJson<{count?: number; entries?: ReadonlyArray<{id?: {kind?: string; name?: string}}>}>(last.text);
        const names = (catalog?.entries ?? []).map((entry) => entry.id?.name).sort();
        if (catalog?.count !== 6 || !names.includes(NESTED_CHECK_PROCEDURE) || !names.includes(ORDERS_PAGE_PROFILE)) {
            throw new Error('factory Library catalog did not surface the real workspace assets');
        }
        return assistant('catalog is real');
    }) as ModelScript);
    const factory = createWorkspaceAgentFactory({modelRuntime: faux.runtime});
    const service = factory({
        ...buildAgentFactoryDeps({
            workspaceName,
            runStepsDeps: deps,
            runnerConfig: defaultRunnerConfig,
            portBegin: 28100,
        }),
        tabs: {getActiveTab: () => null} as never,
    }).service as WorkspaceAgentService;

    try {
        const {sessionId} = await service.sessions.runTracked({
            prompt: 'List the workspace knowledge catalog.',
            provider: faux.provider,
            model: faux.model,
        });
        const snapshot = service.sessions.status(sessionId)!;
        assert.equal(snapshot.state, 'completed');
        assert.equal(snapshot.result?.text, 'catalog is real');
        assert.equal(snapshot.result?.programs?.length, 0, 'a pure catalog read must not start a program');
    } finally {
        await service.stop();
    }
});