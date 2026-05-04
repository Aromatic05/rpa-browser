import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createWorkflowOnFs, deleteWorkflowFromFs } from '../../src/workflow';
import { createWorkspaceEntityRulesRuntime } from '../../src/entity_rules/runtime';
import { createWorkspaceEntityRulesProvider } from '../../src/entity_rules/provider';
import { applyBusinessEntityRules } from '../../src/runner/steps/executors/snapshot/entity_rules/apply';
import type { EntityIndex, UnifiedNode } from '../../src/runner/steps/executors/snapshot/core/types';

const unique = (prefix: string) => `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const cleanup = (name: string) => { try { deleteWorkflowFromFs(name); } catch {} };

const sampleMatch = {
    version: 1,
    page: { kind: 'form' },
    entities: [
        { ruleId: 'main_form', source: 'region', expect: 'unique', match: { kind: 'form', nameContains: 'Order' } },
    ],
};

const sampleAnnotation = {
    version: 1,
    page: { kind: 'form' },
    annotations: [
        { ruleId: 'main_form', businessTag: 'order.form.main', businessName: 'Order Form Main' },
    ],
};

test('workspace entity_rules runtime list/get/save/delete and validation', () => {
    const workflowName = unique('entity-rules-runtime');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);
    const runtime = createWorkspaceEntityRulesRuntime(workflow);

    const saved = runtime.save({ kind: 'entity_rules', name: 'order-form', match: sampleMatch, annotation: sampleAnnotation });
    assert.equal(saved.name, 'order-form');
    assert.equal(runtime.list().length, 1);
    assert.equal(runtime.get('order-form')?.kind, 'entity_rules');

    assert.throws(
        () => runtime.save({ kind: 'entity_rules', name: 'invalid', match: { version: 1, page: { kind: 'form' }, entities: [] }, annotation: sampleAnnotation }),
        /annotation.ruleId not found/,
    );
    assert.equal(runtime.get('missing'), null);
    assert.throws(() => runtime.delete('missing'), /entity_rules not found/);

    runtime.delete('order-form');
    assert.equal(runtime.list().length, 0);
    cleanup(workflowName);
});

test('workspace entity_rules provider returns normalized bundles', () => {
    const workflowName = unique('entity-rules-provider');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);
    const runtime = createWorkspaceEntityRulesRuntime(workflow);
    runtime.save({ kind: 'entity_rules', name: 'order-form', match: sampleMatch, annotation: sampleAnnotation });

    const provider = createWorkspaceEntityRulesProvider(workflow);
    const bundle = provider.getBundle('order-form');
    assert.ok(bundle);
    assert.equal(bundle?.id, 'order-form');
    assert.equal(bundle?.matchRules[0]?.ruleId, 'main_form');

    const selected = provider.resolveBundle({ pageKind: 'form', pageUrl: 'https://example.com' });
    assert.equal(selected?.id, 'order-form');
    cleanup(workflowName);
});

test('snapshot pipeline consumes provider bundle and applies business annotation overlay', () => {
    const root: UnifiedNode = { id: 'root', role: 'root', children: [{ id: 'form_1', role: 'form', name: 'Order Form', children: [] }] };
    const entityIndex: EntityIndex = {
        entities: {
            ent_form: { id: 'ent_form', type: 'region', kind: 'form', nodeId: 'form_1', name: 'Order Form' },
        },
        byNodeId: {
            form_1: [{ type: 'region', entityId: 'ent_form', role: 'container' }],
        },
    };
    const workflowName = unique('entity-rules-snapshot');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);
    const runtime = createWorkspaceEntityRulesRuntime(workflow);
    runtime.save({ kind: 'entity_rules', name: 'order-form', match: sampleMatch, annotation: sampleAnnotation });

    const provider = createWorkspaceEntityRulesProvider(workflow);
    const overlay = applyBusinessEntityRules({ root, entityIndex, bundle: provider.resolveBundle({ pageKind: 'form' }) || undefined });
    assert.equal(overlay.byEntityId.ent_form?.businessTag, 'order.form.main');

    const missingOverlay = applyBusinessEntityRules({ root, entityIndex, bundle: provider.resolveBundle({ pageKind: 'table' }) || undefined });
    assert.deepEqual(missingOverlay.byEntityId, {});

    const brokenProvider = { resolveBundle: () => { throw new Error('rule provider failed'); } };
    assert.throws(() => brokenProvider.resolveBundle(), /rule provider failed/);
    cleanup(workflowName);
});
