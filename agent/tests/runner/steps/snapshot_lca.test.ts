import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLCA } from '../../../src/runner/steps/executors/snapshot/stages/lca';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

const makeNode = (partial: Partial<UnifiedNode> & { id: string; role: string }): UnifiedNode => ({
    id: partial.id,
    role: partial.role,
    children: partial.children || [],
    tier: partial.tier || 'B',
    name: partial.name,
    content: partial.content,
    attrs: partial.attrs,
    bbox: partial.bbox,
    target: partial.target,
});

test('applyLCA should attach fieldLabel and entityId for input-like control', () => {
    const label = makeNode({ id: 'label-1', role: 'label', content: 'Email' });
    const input = makeNode({ id: 'input-1', role: 'textbox' });
    const form = makeNode({
        id: 'form-1',
        role: 'form',
        attrs: { entityType: 'form', entityId: 'entity:form-1' },
        children: [label, input],
    });

    applyLCA(form, [form]);

    assert.equal(input.attrs?.entityId, 'entity:form-1');
    assert.equal(input.attrs?.fieldLabel, 'Email');
});

test('applyLCA should attach action intent and target for row button', () => {
    const actionButton = makeNode({ id: 'btn-1', role: 'button', content: 'Delete row' });
    const row = makeNode({
        id: 'row-1',
        role: 'row',
        attrs: { entityType: 'row', entityId: 'entity:row-1' },
        children: [actionButton],
    });

    applyLCA(row, [row]);

    assert.equal(actionButton.attrs?.entityId, 'entity:row-1');
    assert.equal(actionButton.attrs?.actionTargetId, 'entity:row-1');
    assert.equal(actionButton.attrs?.actionIntent, 'delete');
});

test('applyLCA should mark search-like textbox with search intent', () => {
    const searchInput = makeNode({
        id: 'search-1',
        role: 'textbox',
        attrs: { placeholder: 'Search items' },
    });
    const card = makeNode({
        id: 'card-1',
        role: 'article',
        attrs: { entityType: 'card', entityId: 'entity:card-1' },
        children: [searchInput],
    });

    applyLCA(card, [card]);

    assert.equal(searchInput.attrs?.entityId, 'entity:card-1');
    assert.equal(searchInput.attrs?.actionIntent, 'search');
});
