import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceEntityRulesProvider } from '../../../src/entity_rules/provider';
import type { Workflow, WorkflowEntityRules } from '../../../src/workflow';

const createWorkflow = (artifact: WorkflowEntityRules): Workflow => ({
    name: 'provider-test',
    save: () => artifact,
    get: (name, dummy) => dummy.kind === 'entity_rules' && name === artifact.name ? artifact : null,
    list: (dummy) => dummy.kind === 'entity_rules'
        ? [{
              kind: 'entity_rules',
              name: artifact.name,
              title: artifact.name,
              createdAt: 1,
              updatedAt: 1,
              summary: 'entity_rules',
              enabled: true,
          }]
        : [],
    delete: () => false,
});

const entityRules = (urlPattern?: string): WorkflowEntityRules => ({
    kind: 'entity_rules',
    name: 'orders',
    match: {
        version: 1,
        page: { kind: 'table', ...(urlPattern ? { urlPattern } : {}) },
        entities: [{ ruleId: 'orders_table', source: 'region', expect: 'unique', match: { kind: 'table' } }],
    },
    annotation: {
        version: 1,
        page: { kind: 'table' },
        annotations: [{ ruleId: 'orders_table', businessTag: 'orders.table' }],
    },
});

test('workflow entity rules use matching URL before inferred page kind', () => {
    const provider = createWorkspaceEntityRulesProvider(createWorkflow(entityRules('/orders$')));
    const bundle = provider.resolveBundle({
        pageKind: 'form',
        pageUrl: 'https://example.test/orders',
    });
    assert.equal(bundle?.id, 'orders');
});

test('workflow entity rules reject a mismatched explicit URL', () => {
    const provider = createWorkspaceEntityRulesProvider(createWorkflow(entityRules('/orders$')));
    const bundle = provider.resolveBundle({
        pageKind: 'table',
        pageUrl: 'https://example.test/customers',
    });
    assert.equal(bundle, null);
});

test('workflow entity rules fall back to page kind without URL pattern', () => {
    const provider = createWorkspaceEntityRulesProvider(createWorkflow(entityRules()));
    assert.equal(provider.resolveBundle({ pageKind: 'table' })?.id, 'orders');
    assert.equal(provider.resolveBundle({ pageKind: 'form' }), null);
});
