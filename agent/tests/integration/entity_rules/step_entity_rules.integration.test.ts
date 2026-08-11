import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
    createEntityRulesRuntime,
    createWorkspaceEntityRulesProvider,
    resolveStepEntityRulesExecution,
} from '../../../src/snapshot/rules/runtime';
import type { EntityRuleConfig } from '../../../src/config';
import {
    createWorkflowOnFs,
    deleteWorkflowFromFs,
    type Workflow,
    type WorkflowEntityRules,
} from '../../../src/workflow';
import {ActionError, ERROR_CODES} from '../../../src/actions/results';

const action = (type: string, workspaceName: string, payload?: Record<string, unknown>) => ({
    v: 1 as const,
    id: crypto.randomUUID(),
    type,
    workspaceName,
    payload,
});

const disabledConfig: EntityRuleConfig = {
    enabled: false,
    rootDir: '.rpa/entity_rules',
    selection: 'disabled',
    profiles: [],
    strict: true,
};

const explicitConfig: EntityRuleConfig = {
    enabled: true,
    rootDir: '.rpa/entity_rules',
    selection: 'explicit',
    profiles: ['workflow-default'],
    strict: true,
};

const profile = (name: string, kind: 'form' | 'table' = 'form'): WorkflowEntityRules => ({
    kind: 'entity_rules',
    name,
    match: {
        version: 2,
        rules: [{
            ruleId: `${name}-root`,
            source: 'region',
            expect: 'unique',
            match: { kind },
        }],
    },
    annotation: {
        version: 2,
        bindings: [],
    },
});

const workflowWithProfiles = (...profiles: WorkflowEntityRules[]): Workflow => {
    const byName = new Map(profiles.map((item) => [item.name, item]));
    return {
        name: 'step-rules',
        save: (artifact) => artifact,
        get: (name, dummy) => dummy.kind === 'entity_rules' ? byName.get(name) ?? null : null,
        list: (dummy) => dummy.kind === 'entity_rules'
            ? profiles.map((item, index) => ({
                  kind: 'entity_rules' as const,
                  name: item.name,
                  title: item.name,
                  createdAt: index + 1,
                  updatedAt: index + 1,
                  summary: 'entity_rules',
                  enabled: true,
              }))
            : [],
        delete: () => false,
    };
};

test('an explicit per-step entityRules selection activates exactly the requested profiles', () => {
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(
        profile('orders', 'table'),
        profile('order-form'),
    ));
    const result = resolveStepEntityRulesExecution({
        selection: 'explicit',
        profiles: ['orders', 'order-form'],
        strict: false,
    }, disabledConfig, provider);

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.profiles, ['orders', 'order-form']);
    assert.equal(result.strict, false);
});

test('an auto per-step entityRules selection resolves available workflow profiles', () => {
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(
        profile('order-form'),
        profile('orders', 'table'),
    ));
    const result = resolveStepEntityRulesExecution({
        selection: 'auto',
        strict: true,
    }, disabledConfig, provider);

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.profiles, ['order-form', 'orders']);
});

test('an inherited entityRules selection applies workspace configuration to every step', () => {
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(profile('workflow-default')));
    const result = resolveStepEntityRulesExecution({
        selection: 'inherit',
    }, explicitConfig, provider);

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.profiles, ['workflow-default']);
    assert.equal(result.strict, true);
});

test('workflow entity_rules artifacts persist through the workflow facade', () => {
    const workflowName = `step-rules-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
        const workflow = createWorkflowOnFs(workflowName);
        const saved = workflow.save({
            ...profile('orders', 'table'),
            page: {kind: 'table', urlPattern: '/orders'},
        });

        assert.equal(saved.name, 'orders');
        assert.deepEqual(workflow.list({ kind: 'entity_rules' }).map((item) => item.name), ['orders']);
        const loaded = workflow.get('orders', {kind: 'entity_rules'});
        assert.equal(loaded?.name, 'orders');
        assert.equal(loaded?.kind, 'entity_rules');
        if (loaded?.kind === 'entity_rules') {
            assert.deepEqual(loaded.page, {kind: 'table', urlPattern: '/orders'});
        }
        assert.equal(createWorkspaceEntityRulesProvider(workflow).getProfile('orders')?.name, 'orders');
    } finally {
        deleteWorkflowFromFs(workflowName);
    }
});

test('strict selection reports a missing workflow profile instead of silently dropping it', () => {
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(profile('orders', 'table')));
    const result = resolveStepEntityRulesExecution({
        selection: 'explicit',
        profiles: ['orders', 'missing'],
        strict: true,
    }, disabledConfig, provider);

    assert.equal(result.status, 'invalid');
    assert.match(result.reason ?? '', /missing/);
});

test('workspace entity_rules actions persist and expose profiles through the runtime control', async () => {
    const workflowName = `step-rules-router-${crypto.randomUUID()}`;
    try {
        const workflow = createWorkflowOnFs(workflowName);
        const runtime = createEntityRulesRuntime();
        const workspace = { workflow } as any;
        const invoke = async (type: string, payload?: Record<string, unknown>) => await runtime.handle({
            action: action(type, workflowName, payload),
            workspace,
            workspaceRegistry: {} as any,
        });
        const rules = {
            ...profile('orders', 'table'),
            page: {kind: 'table' as const, urlPattern: '/orders'},
        };

        const saved = await invoke('entity_rules.save', {
            profileName: rules.name,
            page: rules.page,
            match: rules.match,
            annotation: rules.annotation,
        });
        assert.equal(saved.reply.type, 'entity_rules.save.result');
        assert.equal((saved.reply.payload as { profileName: string }).profileName, 'orders');
        const firstRevision = (saved.reply.payload as {artifactRevision?: string}).artifactRevision;
        assert.equal(typeof firstRevision, 'string');
        assert.deepEqual(
            (saved.reply.payload as {profile: WorkflowEntityRules}).profile.page,
            {kind: 'table', urlPattern: '/orders'},
        );

        const listed = await invoke('entity_rules.list');
        assert.deepEqual(
            (listed.reply.payload as { profiles: Array<{ name: string }> }).profiles.map((item) => item.name),
            ['orders'],
        );
        assert.deepEqual(
            (listed.reply.payload as {rules: unknown[]}).rules,
            [{
                profileName: 'orders',
                label: 'orders',
                pageKind: 'table',
                urlPattern: '/orders',
                entityCount: 0,
            }],
        );

        const loaded = await invoke('entity_rules.get', {
            profileName: 'orders',
        });
        assert.equal(Object.hasOwn(loaded.reply.payload as object, 'profile'), false);
        assert.equal((loaded.reply.payload as {artifactRevision?: string}).artifactRevision, firstRevision);
        assert.deepEqual(
            (loaded.reply.payload as {view: unknown}).view,
            {
                profileName: 'orders',
                label: 'orders',
                pageKind: 'table',
                urlPattern: '/orders',
                entityCount: 0,
                entities: [],
            },
        );

        const updated = await invoke('entity_rules.save', {
            profileName: rules.name,
            page: {...rules.page, urlPattern: '/orders/v2'},
            match: rules.match,
            annotation: rules.annotation,
            expectedRevision: firstRevision,
        });
        const secondRevision = (updated.reply.payload as {artifactRevision?: string}).artifactRevision;
        assert.equal(typeof secondRevision, 'string');
        assert.notEqual(secondRevision, firstRevision);

        await assert.rejects(
            () => invoke('entity_rules.save', {
                profileName: rules.name,
                page: {...rules.page, urlPattern: '/orders/stale'},
                match: rules.match,
                annotation: rules.annotation,
                expectedRevision: firstRevision,
            }),
            (error: unknown) => (error as {code?: string} | null)?.code === ERROR_CODES.ERR_CONFLICT,
        );
        await assert.rejects(
            () => invoke('entity_rules.delete', {
                profileName: 'orders',
                expectedRevision: firstRevision,
            }),
            (error: unknown) => (error as {code?: string} | null)?.code === ERROR_CODES.ERR_CONFLICT,
        );

        const deleted = await invoke('entity_rules.delete', {
            profileName: 'orders',
            expectedRevision: secondRevision,
        });
        assert.equal((deleted.reply.payload as { deleted: boolean }).deleted, true);
        assert.equal(runtime.getProvider(workflow).getProfile('orders'), null);
    } finally {
        deleteWorkflowFromFs(workflowName);
    }
});

test('entity_rules.save rejects profiles that cannot compile into an executable query plan', async () => {
    const workflowName = `step-rules-invalid-plan-${crypto.randomUUID()}`;
    try {
        const workflow = createWorkflowOnFs(workflowName);
        const runtime = createEntityRulesRuntime();
        const workspace = {workflow} as any;
        const invalid = {
            ...profile('invalid-orders', 'table'),
            page: {kind: 'table' as const},
            match: {
                version: 2 as const,
                rules: [{
                    ruleId: 'invalid-orders-root',
                    source: 'region' as const,
                    expect: 'unique' as const,
                    match: {kind: 'table', unsupportedCondition: 'orders'},
                }],
            },
        };

        await assert.rejects(
            () => runtime.handle({
                action: action('entity_rules.save', workflowName, {
                    profileName: invalid.name,
                    page: invalid.page,
                    match: invalid.match,
                    annotation: invalid.annotation,
                }),
                workspace,
                workspaceRegistry: {} as any,
            }),
            (error: unknown) => error instanceof ActionError
                && error.code === ERROR_CODES.ERR_BAD_ARGS
                && Array.isArray((error.details as {diagnostics?: unknown[]} | undefined)?.diagnostics)
                && (error.details as {diagnostics: Array<{code?: string}>}).diagnostics
                    .some((diagnostic) => diagnostic.code === 'query-plan.match.unsupported'),
        );
        assert.equal(workflow.get(invalid.name, {kind: 'entity_rules'}), null);
    } finally {
        deleteWorkflowFromFs(workflowName);
    }
});


test('entity_rules.list exposes catalog entries whose artifacts cannot be loaded', async () => {
    const runtime = createEntityRulesRuntime();
    const invalidWorkflow: Workflow = {
        name: 'invalid-rules',
        save: (artifact) => artifact,
        get: () => null,
        list: (dummy) => dummy.kind === 'entity_rules' ? [{
            kind: 'entity_rules',
            name: 'broken-profile',
            title: 'broken-profile',
            createdAt: 1,
            updatedAt: 1,
            summary: 'entity_rules',
            enabled: true,
        }] : [],
        delete: () => false,
    };
    const result = await runtime.handle({
        action: action('entity_rules.list', invalidWorkflow.name),
        workspace: {workflow: invalidWorkflow} as any,
        workspaceRegistry: {} as any,
    });
    assert.deepEqual((result.reply.payload as {rules: unknown[]}).rules, [{
        profileName: 'broken-profile',
        label: 'broken-profile',
        entityCount: 0,
        status: 'invalid',
        error: '规则文件无效或迁移失败',
    }]);
});
