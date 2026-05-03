import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createWorkflowOnFs, deleteWorkflowFromFs, toEntityRuleBundle } from '../../src/workflow';
import { createWorkspaceCheckpointRuntime } from '../../src/checkpoint/runtime';
import type { WorkflowCheckpoint } from '../../src/workflow';
import type { RunStepsDeps } from '../../src/runner/run_steps_types';
import { createTestWorkspaceRegistry } from '../helpers/workspace/registry';

const unique = (prefix: string) => `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const cleanup = (name: string) => { try { deleteWorkflowFromFs(name); } catch {} };

test('checkpoint runtime save accepts WorkflowCheckpoint hints type', () => {
    const workflowName = unique('checkpoint-hints');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);
    const runtime = createWorkspaceCheckpointRuntime(workflow);

    const hints: WorkflowCheckpoint['hints'] = {
        s1: {
            why: 'test',
            preferredEntityRules: ['order-form'],
            notes: ['n1'],
        },
    };

    const saved = runtime.save({ id: 'cp-typed', trigger: { matchRules: [] }, content: [] }, {}, hints);
    assert.equal(saved.kind, 'checkpoint');
    assert.equal(saved.name, 'cp-typed');
    assert.equal(saved.hints.s1?.why, 'test');
    cleanup(workflowName);
});

test('toEntityRuleBundle is exported from workflow index', () => {
    const bundle = toEntityRuleBundle({
        kind: 'entity_rules',
        name: 'order-form',
        match: {
            version: 1,
            page: { kind: 'form' },
            entities: [{ ruleId: 'main_form', source: 'region', expect: 'unique', match: { kind: 'form' } }],
        },
        annotation: {
            version: 1,
            page: { kind: 'form' },
            annotations: [{ ruleId: 'main_form', businessTag: 'order.form.main' }],
        },
    });

    assert.equal(bundle.id, 'order-form');
    assert.equal(bundle.matchRules.length, 1);
});

test('RunStepsDeps can carry resolveEntityRulesProvider and return null for missing workspace', () => {
    const { registry } = createTestWorkspaceRegistry();
    const deps: RunStepsDeps = {
        runtime: {} as any,
        config: {} as any,
        pluginHost: { getExecutors: () => ({}) as any } as any,
        resolveEntityRulesProvider: (workspaceName: string) => {
            const workspace = registry.getWorkspace(workspaceName);
            if (!workspace) {
                return null;
            }
            return workspace.controls.entityRules.getProvider(workspace.workflow);
        },
    };

    assert.equal(deps.resolveEntityRulesProvider?.('missing-workspace') ?? null, null);
});
