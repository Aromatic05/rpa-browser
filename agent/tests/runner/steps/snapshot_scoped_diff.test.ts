import test from 'node:test';
import assert from 'node:assert/strict';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';
import { setNodeAttr, setNodeContent } from '../../../src/runner/steps/executors/snapshot/core/runtime_store';
import {
    buildSnapshotDiffBaselineKey,
    buildSnapshotFromViewRoot,
    buildSnapshotView,
    computeMinimalChangedSubtree,
} from '../../../src/runner/steps/executors/snapshot/pipeline/scoped_diff';

const collectNodeIds = (root: UnifiedNode): string[] => {
    const ids: string[] = [];
    const walk = (node: UnifiedNode) => {
        ids.push(node.id);
        for (const child of node.children) {
            walk(child);
        }
    };
    walk(root);
    return ids;
};

const createScopedFixtureSnapshot = () => {
    const iconDoc: UnifiedNode = { id: 'icon-doc', role: 'img', name: 'doc icon', children: [] };
    const linkDoc: UnifiedNode = { id: 'link-doc', role: 'link', name: 'Documentation', children: [iconDoc] };
    const status: UnifiedNode = { id: 'status', role: 'status', name: 'Queue State', children: [] };
    const groupInfo: UnifiedNode = {
        id: 'group-info',
        role: 'group',
        name: 'Information',
        children: [linkDoc, status],
    };
    const btnSave: UnifiedNode = { id: 'btn-save', role: 'button', name: 'Save Draft', children: [] };
    const note: UnifiedNode = { id: 'txt-note', role: 'text', name: 'Notes', children: [] };
    const panelMain: UnifiedNode = {
        id: 'panel-main',
        role: 'panel',
        name: 'Main Panel',
        children: [btnSave, note, groupInfo],
    };

    const checkboxAccept: UnifiedNode = { id: 'checkbox-accept', role: 'checkbox', name: 'Accept Terms', children: [] };
    const paragraph: UnifiedNode = { id: 'dialog-desc', role: 'paragraph', name: 'Description', children: [] };
    const dialog: UnifiedNode = {
        id: 'dialog-overlay',
        role: 'dialog',
        name: 'Confirm Dialog',
        children: [checkboxAccept, paragraph],
    };

    const root: UnifiedNode = {
        id: 'root',
        role: 'root',
        name: 'Root',
        children: [panelMain, dialog],
    };

    setNodeAttr(btnSave, 'tag', 'button');
    setNodeAttr(linkDoc, 'tag', 'a');
    setNodeAttr(checkboxAccept, 'tag', 'input');
    setNodeAttr(note, 'tag', 'div');
    setNodeContent(status, 'Queue processing 3 items');
    setNodeContent(paragraph, 'Dialog text for acceptance');

    return buildSnapshotFromViewRoot(root, undefined);
};

test('snapshot view uses root as default contain', () => {
    const snapshot = createScopedFixtureSnapshot();
    const result = buildSnapshotView(snapshot, {});
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    assert.equal(result.resolvedContainId, 'root');
    assert.equal(result.snapshot.root.id, 'root');
});

test('snapshot view supports contain id and depth 0/1/-1', () => {
    const snapshot = createScopedFixtureSnapshot();

    const depth0 = buildSnapshotView(snapshot, { contain: 'group-info', depth: 0 });
    assert.equal(depth0.ok, true);
    if (depth0.ok) {
        assert.equal(depth0.snapshot.root.id, 'group-info');
        assert.equal(depth0.snapshot.root.children.length, 0);
    }

    const depth1 = buildSnapshotView(snapshot, { contain: 'group-info', depth: 1 });
    assert.equal(depth1.ok, true);
    if (depth1.ok) {
        assert.equal(depth1.snapshot.root.children.map((item) => item.id).join(','), 'link-doc,status');
        assert.equal(depth1.snapshot.root.children[0].children.length, 0);
    }

    const infiniteDepth = buildSnapshotView(snapshot, { contain: 'group-info', depth: -1 });
    assert.equal(infiniteDepth.ok, true);
    if (infiniteDepth.ok) {
        assert.equal(infiniteDepth.snapshot.root.children[0].children[0]?.id, 'icon-doc');
    }
});

test('snapshot view returns explicit contain error when id does not exist', () => {
    const snapshot = createScopedFixtureSnapshot();
    const result = buildSnapshotView(snapshot, { contain: 'missing-node' });
    assert.equal(result.ok, false);
    if (result.ok) {return;}
    assert.equal(result.error.code, 'ERR_NOT_FOUND');
});

test('snapshot view role/text/interactive filters follow AND semantics and keep ancestor chain', () => {
    const snapshot = createScopedFixtureSnapshot();

    const roleOnly = buildSnapshotView(snapshot, { filter: { role: 'button' } });
    assert.equal(roleOnly.ok, true);
    if (roleOnly.ok) {
        const ids = collectNodeIds(roleOnly.snapshot.root);
        assert.deepEqual(ids, ['root', 'panel-main', 'btn-save']);
    }

    const textOnly = buildSnapshotView(snapshot, { filter: { text: 'processing' } });
    assert.equal(textOnly.ok, true);
    if (textOnly.ok) {
        const ids = collectNodeIds(textOnly.snapshot.root);
        assert.deepEqual(ids, ['root', 'panel-main', 'group-info', 'status']);
    }

    const interactiveOnly = buildSnapshotView(snapshot, { filter: { interactive: true } });
    assert.equal(interactiveOnly.ok, true);
    if (interactiveOnly.ok) {
        const ids = collectNodeIds(interactiveOnly.snapshot.root);
        assert.ok(ids.includes('btn-save'));
        assert.ok(ids.includes('link-doc'));
        assert.ok(ids.includes('checkbox-accept'));
        assert.ok(!ids.includes('status'));
    }

    const andFilter = buildSnapshotView(snapshot, {
        filter: {
            role: ['link', 'button'],
            text: 'save',
            interactive: true,
        },
    });
    assert.equal(andFilter.ok, true);
    if (andFilter.ok) {
        const ids = collectNodeIds(andFilter.snapshot.root);
        assert.deepEqual(ids, ['root', 'panel-main', 'btn-save']);
    }
});

test('snapshot filter signature is stable across role array order', () => {
    const snapshot = createScopedFixtureSnapshot();
    const left = buildSnapshotView(snapshot, {
        contain: 'panel-main',
        depth: 1,
        filter: { role: ['button', 'link'], text: 'draft', interactive: true },
    });
    const right = buildSnapshotView(snapshot, {
        contain: 'panel-main',
        depth: 1,
        filter: { role: ['link', 'button'], text: 'draft', interactive: true },
    });

    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    if (!left.ok || !right.ok) {return;}

    const leftKey = buildSnapshotDiffBaselineKey({
        contain: left.resolvedContainId,
        depth: left.resolvedDepth,
        filterSignature: left.filterSignature,
    });
    const rightKey = buildSnapshotDiffBaselineKey({
        contain: right.resolvedContainId,
        depth: right.resolvedDepth,
        filterSignature: right.filterSignature,
    });

    assert.equal(left.filterSignature, right.filterSignature);
    assert.equal(leftKey, rightKey);
});

test('minimal diff keeps local context around changed node', () => {
    const baseline: UnifiedNode = {
        id: 'root',
        role: 'root',
        children: [
            {
                id: 'container',
                role: 'group',
                children: [
                    { id: 'item-a', role: 'text', name: 'Old Name', children: [] },
                    { id: 'item-b', role: 'text', name: 'Stable', children: [] },
                ],
            },
        ],
    };

    const current: UnifiedNode = {
        id: 'root',
        role: 'root',
        children: [
            {
                id: 'container',
                role: 'group',
                children: [
                    { id: 'item-a', role: 'text', name: 'New Name', children: [] },
                    { id: 'item-b', role: 'text', name: 'Stable', children: [] },
                ],
            },
        ],
    };

    const result = computeMinimalChangedSubtree(current, baseline);
    assert.equal(result.mode, 'diff');
    if (result.mode !== 'diff') {return;}
    assert.equal(result.diffRootId, 'container');
    assert.equal(result.changedNodeCount, 1);
    assert.equal(result.root.id, 'container');
});

test('minimal diff does not over-promote context when parent subtree is too large', () => {
    const baselineChildren: UnifiedNode[] = [];
    const currentChildren: UnifiedNode[] = [];

    for (let index = 0; index < 300; index += 1) {
        baselineChildren.push({ id: `item-${index}`, role: 'text', name: `before-${index}`, children: [] });
        currentChildren.push({
            id: `item-${index}`,
            role: 'text',
            name: index === 0 ? 'after-0' : `before-${index}`,
            children: [],
        });
    }

    const baseline: UnifiedNode = {
        id: 'root',
        role: 'root',
        children: [
            {
                id: 'container-large',
                role: 'group',
                children: baselineChildren,
            },
        ],
    };

    const current: UnifiedNode = {
        id: 'root',
        role: 'root',
        children: [
            {
                id: 'container-large',
                role: 'group',
                children: currentChildren,
            },
        ],
    };

    const result = computeMinimalChangedSubtree(current, baseline);
    assert.equal(result.mode, 'diff');
    if (result.mode !== 'diff') {return;}
    assert.equal(result.diffRootId, 'item-0');
    assert.equal(result.root.id, 'item-0');
});

test('minimal diff falls back to full when changes are too broad', () => {
    const baselineChildren: UnifiedNode[] = [];
    const currentChildren: UnifiedNode[] = [];
    for (let index = 0; index < 40; index += 1) {
        baselineChildren.push({ id: `item-${index}`, role: 'text', name: `baseline-${index}`, children: [] });
        currentChildren.push({ id: `item-${index}`, role: 'text', name: `current-${index}`, children: [] });
    }

    const baseline: UnifiedNode = { id: 'root', role: 'root', children: baselineChildren };
    const current: UnifiedNode = { id: 'root', role: 'root', children: currentChildren };

    const result = computeMinimalChangedSubtree(current, baseline);
    assert.equal(result.mode, 'full');
    if (result.mode !== 'full') {return;}
    assert.equal(result.reason, 'too_broad');
});
