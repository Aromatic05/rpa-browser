import test from 'node:test';
import assert from 'node:assert/strict';
import { compress } from '../../../../src/runner/steps/executors/snapshot/stages/compress';
import { finalizeLabel } from '../../../../src/runner/steps/executors/snapshot/stages/finalize_label';
import { getNodeContent, getNodeSemanticHints } from '../../../../src/runner/steps/executors/snapshot/core/runtime_store';
import { snapshotNode as node } from '../../../helpers/snapshot_node';

test('compress and finalizeLabel migrate field semantics to the surviving control', () => {
    const input = node('input', 'input', [], { attrs: { tag: 'input' } });
    const fieldShell = node('field-shell', 'div', [input], {
        semantic: { fieldLabel: '关键字' },
        attrs: { tag: 'div' },
    });
    const action = node('action', 'button', [], {
        content: '删除',
        attrs: { tag: 'button' },
    });
    const root = node('root', 'root', [fieldShell, action]);

    const compressed = compress(root);
    assert.ok(compressed);
    finalizeLabel(compressed);

    const survivingInput = compressed.children.find((child) => child.id === 'input');
    assert.ok(survivingInput);
    assert.equal(getNodeSemanticHints(survivingInput)?.fieldLabel, '关键字');
    assert.equal(action.name, '删除');
    assert.equal(getNodeContent(action), '删除');
    assert.equal(getNodeSemanticHints(action)?.actionIntent, 'delete');
});

test('finalizeLabel backfills a missing field label from local scope text', () => {
    const label = node('label', 'label', [], { content: '邮箱' });
    const input = node('input', 'input', [], { attrs: { tag: 'input' } });
    const form = node('form', 'form', [label, input], { attrs: { tag: 'form' } });

    finalizeLabel(form);

    assert.equal(getNodeSemanticHints(input)?.fieldLabel, '邮箱');
    assert.equal(input.name, '邮箱');
});

test('finalizeLabel settles a title for a card-like container', () => {
    const title = node('title', 'heading', [], { content: '订单列表' });
    const card = node('card', 'section', [title], {
        semantic: { entityNodeId: 'card', entityKind: 'panel' },
        attrs: { tag: 'section' },
    });

    finalizeLabel(card);

    assert.equal(card.name, '订单列表');
});

test('compress migrates entity semantics from a removable shell to its semantic child', () => {
    const link = node('link', 'link', [], {
        target: { ref: '/detail', kind: 'url' },
        attrs: { tag: 'a' },
    });
    const shell = node('shell', 'div', [link], {
        semantic: { entityNodeId: 'shell', entityKind: 'panel' },
        attrs: { tag: 'div' },
    });
    const root = node('root', 'root', [shell]);

    const compressed = compress(root);
    assert.ok(compressed);
    const survivingLink = compressed.children[0];
    assert.equal(survivingLink.id, 'link');
    assert.equal(getNodeSemanticHints(survivingLink)?.entityNodeId, 'shell');
    assert.equal(getNodeSemanticHints(survivingLink)?.entityKind, 'panel');
});

test('finalizeLabel preserves LCA targets and fills a missing action intent', () => {
    const button = node('button', 'button', [], {
        content: '删除',
        semantic: {
            entityNodeId: 'row',
            entityKind: 'table',
            actionTargetNodeId: 'row',
        },
        attrs: { tag: 'button' },
    });
    const row = node('row', 'row', [button]);

    finalizeLabel(row);

    const hints = getNodeSemanticHints(button);
    assert.equal(hints?.entityNodeId, 'row');
    assert.equal(hints?.actionTargetNodeId, 'row');
    assert.equal(hints?.actionIntent, 'delete');
});
