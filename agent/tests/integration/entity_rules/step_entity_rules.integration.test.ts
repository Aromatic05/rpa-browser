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
        assert.deepEqual(
            (saved.reply.payload as {profile: WorkflowEntityRules}).profile.page,
            {kind: 'table', urlPattern: '/orders'},
        );

        const listed = await invoke('entity_rules.list');
        assert.deepEqual(
            (listed.reply.payload as { profiles: Array<{ name: string }> }).profiles.map((item) => item.name),
            ['orders'],
        );

        const loaded = await invoke('entity_rules.get', {
            profileName: 'orders',
        });
        assert.equal((loaded.reply.payload as { profile: WorkflowEntityRules }).profile.name, 'orders');

        const deleted = await invoke('entity_rules.delete', {
            profileName: 'orders',
        });
        assert.equal((deleted.reply.payload as { deleted: boolean }).deleted, true);
        assert.equal(runtime.getProvider(workflow).getProfile('orders'), null);
    } finally {
        deleteWorkflowFromFs(workflowName);
    }
});
