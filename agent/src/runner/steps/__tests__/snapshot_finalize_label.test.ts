import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeLabel } from '../executors/snapshot/finalize_label';
import type { UnifiedNode } from '../executors/snapshot/types';

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
