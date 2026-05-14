import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeLabel } from '../../../src/runner/steps/executors/snapshot/stages/finalize_label';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

const node = (
    id: string,
    role: string,
    children: UnifiedNode[] = [],
    patch: Partial<UnifiedNode> = {},
): UnifiedNode => ({
    id,
    role,
    children,
    ...patch,
});

test('finalizeLabel should migrate fieldLabel to surviving field carrier and finalize button text/action', () => {
    const input = node('input', 'input', [], { attrs: { tag: 'input' } });
    const fieldShell = node('field-shell', 'div', [input], {
        fieldLabel: '关键字',
        attrs: { fieldLabel: '关键字', tag: 'div' },
    });
    const action = node('action', 'button', [], {
        content: '删除',
        attrs: { tag: 'button' },
    });
    const root = node('root', 'root', [fieldShell, action]);

    finalizeLabel(root);

    assert.equal(fieldShell.fieldLabel, undefined);
    assert.equal(fieldShell.attrs?.fieldLabel, undefined);
    assert.equal(input.fieldLabel, '关键字');
    assert.equal(input.attrs?.fieldLabel, '关键字');
    assert.equal(action.name, '删除');
    assert.equal(action.content, '删除');
    assert.equal(action.actionIntent, 'delete');
});

test('finalizeLabel should backfill missing input fieldLabel from local scope label', () => {
    const label = node('label', 'label', [], { content: '邮箱' });
    const input = node('input', 'input', [], { attrs: { tag: 'input' } });
    const form = node('form', 'form', [label, input], {
        formRole: 'form',
        attrs: { formRole: 'form', tag: 'form' },
    });

    finalizeLabel(form);

    assert.equal(input.fieldLabel, '邮箱');
    assert.equal(input.attrs?.fieldLabel, '邮箱');
});

test('finalizeLabel should settle container title for card-like entity after compress', () => {
    const title = node('title', 'heading', [], { content: '订单列表' });
    const card = node('card', 'section', [title], {
        entityType: 'card',
        attrs: { entityType: 'card', tag: 'section' },
    });

    finalizeLabel(card);

    assert.equal(card.name, '订单列表');
    assert.equal(card.content, '订单列表');
});

test('finalizeLabel should migrate entityId from shell to nearest retained semantic carrier', () => {
    const link = node('link', 'link', [], {
        target: { ref: '/detail', kind: 'url' },
        attrs: { tag: 'a' },
    });
    const shell = node('shell', 'div', [link], {
        entityId: 'entity:item-1',
        attrs: { entityId: 'entity:item-1', tag: 'div' },
    });
    const root = node('root', 'root', [shell]);

    finalizeLabel(root);

    assert.equal(shell.entityId, undefined);
    assert.equal(shell.attrs?.entityId, undefined);
    assert.equal(link.entityId, 'entity:item-1');
    assert.equal(link.attrs?.entityId, 'entity:item-1');
});

test('finalizeLabel should repair invalid parentEntityId and actionTargetId after compression', () => {
    const button = node('button', 'button', [], {
        content: '删除',
        parentEntityId: 'entity:missing-parent',
        actionTargetId: 'entity:missing-target',
        attrs: {
            tag: 'button',
            parentEntityId: 'entity:missing-parent',
            actionTargetId: 'entity:missing-target',
        },
    });
    const row = node('row', 'row', [button], {
        entityId: 'entity:row-1',
        entityType: 'row',
        attrs: { entityId: 'entity:row-1', entityType: 'row' },
    });

    finalizeLabel(row);

    assert.equal(button.parentEntityId, 'entity:row-1');
    assert.equal(button.attrs?.parentEntityId, 'entity:row-1');
    assert.equal(button.actionTargetId, 'entity:row-1');
    assert.equal(button.attrs?.actionTargetId, 'entity:row-1');
});
