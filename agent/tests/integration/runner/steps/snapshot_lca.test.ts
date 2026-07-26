import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLCA } from '../../../../src/runner/steps/executors/snapshot/stages/lca';
import { getNodeSemanticHints } from '../../../../src/runner/steps/executors/snapshot/core/runtime_store';
import { snapshotNode as node } from '../../../helpers/snapshot_node';

test('applyLCA attaches field semantics from the nearest form entity', () => {
    const label = node('label-1', 'label', [], { content: 'Email' });
    const input = node('input-1', 'textbox');
    const form = node('form-1', 'form', [label, input]);

    applyLCA(form, [{ nodeId: 'form-1', kind: 'form' }]);

    const hints = getNodeSemanticHints(input);
    assert.equal(hints?.entityNodeId, 'form-1');
    assert.equal(hints?.entityKind, 'form');
    assert.equal(hints?.fieldLabel, 'Email');
});

test('applyLCA attaches action intent and target from the nearest table entity', () => {
    const actionButton = node('btn-1', 'button', [], { content: 'Delete row' });
    const row = node('row-1', 'row', [actionButton]);

    applyLCA(row, [{ nodeId: 'row-1', kind: 'table' }]);

    const hints = getNodeSemanticHints(actionButton);
    assert.equal(hints?.entityNodeId, 'row-1');
    assert.equal(hints?.entityKind, 'table');
    assert.equal(hints?.actionTargetNodeId, 'row-1');
    assert.equal(hints?.actionIntent, 'delete');
});

test('applyLCA marks search-like textboxes with search intent', () => {
    const searchInput = node('search-1', 'textbox', [], {
        attrs: { placeholder: 'Search items' },
    });
    const card = node('card-1', 'article', [searchInput]);

    applyLCA(card, [{ nodeId: 'card-1', kind: 'panel' }]);

    const hints = getNodeSemanticHints(searchInput);
    assert.equal(hints?.entityNodeId, 'card-1');
    assert.equal(hints?.entityKind, 'panel');
    assert.equal(hints?.fieldLabel, 'Search items');
});
