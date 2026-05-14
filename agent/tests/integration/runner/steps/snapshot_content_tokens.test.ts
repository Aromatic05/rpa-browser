import test from 'node:test';
import assert from 'node:assert/strict';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';
import { setNodeAttr, setNodeAttrs, setNodeContent } from '../../../src/runner/steps/executors/snapshot/core/runtime_store';
import { projectInteractionStateContent } from '../../../src/runner/steps/executors/snapshot/pipeline/content_tokens';
import {
    buildSnapshotFromViewRoot,
    buildSnapshotView,
    computeMinimalChangedSubtree,
} from '../../../src/runner/steps/executors/snapshot/pipeline/scoped_diff';

const createNode = (id: string, role: string, children: UnifiedNode[] = []): UnifiedNode => ({
    id,
    role,
    children,
});

const toViewRoot = (root: UnifiedNode): UnifiedNode => {
    const snapshot = buildSnapshotFromViewRoot(root, undefined);
    const view = buildSnapshotView(snapshot, {});
    assert.equal(view.ok, true);
    if (!view.ok) {
        throw new Error('snapshot view expected ok');
    }
    return view.snapshot.root;
};

const firstChild = (root: UnifiedNode): UnifiedNode => {
    const child = root.children[0];
    if (!child) {
        throw new Error('expected child node');
    }
    return child;
};

const projectSingleNodeContent = (node: UnifiedNode): string | undefined => {
    const root = createNode('token-root', 'root', [node]);
    projectInteractionStateContent(root);
    const first = root.children[0];
    if (!first || typeof first.content !== 'string') {return undefined;}
    return first.content;
};

test('textbox with value builds value token', () => {
    const textbox = createNode('textbox-1', 'textbox');
    setNodeAttr(textbox, 'type', 'text');
    setNodeAttr(textbox, 'value', 'alice');

    const content = projectSingleNodeContent(textbox);
    assert.equal(content, 'value="alice"');
});

test('textbox empty with placeholder builds empty and placeholder tokens', () => {
    const textbox = createNode('textbox-2', 'textbox');
    setNodeAttr(textbox, 'type', 'text');
    setNodeAttr(textbox, 'placeholder', '请输入用户名');

    const content = projectSingleNodeContent(textbox);
    assert.equal(content, 'empty; placeholder="请输入用户名"');
});

test('checkbox and radio states map to checked/unchecked tokens', () => {
    const checkboxChecked = createNode('checkbox-1', 'checkbox');
    setNodeAttrs(checkboxChecked, {
        type: 'checkbox',
        checked: '',
        'aria-checked': 'true',
    });
    assert.equal(projectSingleNodeContent(checkboxChecked), 'checked');

    const checkboxUnchecked = createNode('checkbox-2', 'checkbox');
    setNodeAttrs(checkboxUnchecked, {
        type: 'checkbox',
        'aria-checked': 'false',
    });
    assert.equal(projectSingleNodeContent(checkboxUnchecked), 'unchecked');
});

test('checkbox state can fall back to class and data-state markers', () => {
    const byClass = createNode('checkbox-class', 'checkbox');
    setNodeAttrs(byClass, {
        class: 'ant-checkbox ant-checkbox-checked',
    });
    assert.equal(projectSingleNodeContent(byClass), 'checked');

    const byDataState = createNode('radio-state', 'radio');
    setNodeAttrs(byDataState, {
        'data-state': 'checked',
    });
    assert.equal(projectSingleNodeContent(byDataState), 'checked');
});

test('combobox selected value maps to selected token', () => {
    const combobox = createNode('combobox-1', 'combobox');
    setNodeAttr(combobox, 'value', '北京');

    const content = projectSingleNodeContent(combobox);
    assert.equal(content, 'selected="北京"');
});

test('combobox should stay empty when selected attrs are absent', () => {
    const fromContent = createNode('combobox-content', 'combobox');
    setNodeContent(fromContent, '香蕉');
    assert.equal(projectSingleNodeContent(fromContent), 'empty');

    const fromName = createNode('combobox-name', 'combobox');
    fromName.name = '苹果';
    assert.equal(projectSingleNodeContent(fromName), 'empty');

    const placeholderLike = createNode('combobox-placeholder', 'combobox');
    placeholderLike.name = '你喜欢什么样的工作方式？';
    assert.equal(projectSingleNodeContent(placeholderLike), 'empty');
});

test('expanded and collapsed states map to stable tokens', () => {
    const expandedButton = createNode('button-expanded', 'button');
    setNodeAttr(expandedButton, 'aria-expanded', 'true');
    assert.equal(projectSingleNodeContent(expandedButton), 'expanded');

    const collapsedButton = createNode('button-collapsed', 'button');
    setNodeAttr(collapsedButton, 'aria-expanded', 'false');
    assert.equal(projectSingleNodeContent(collapsedButton), 'collapsed');
});

test('token order is stable and duplicate tokens are removed', () => {
    const node = createNode('combobox-order', 'combobox');
    setNodeAttrs(node, {
        value: 'A;B',
        'aria-expanded': 'true',
        expanded: 'true',
        'aria-pressed': 'false',
        disabled: '',
        'aria-disabled': 'true',
        readonly: 'true',
        'aria-invalid': 'true',
    });

    const content = projectSingleNodeContent(node);
    assert.equal(content, 'selected="A,B"; expanded; unpressed; disabled; readonly; invalid');
});

test('token value semicolon is normalized', () => {
    const combobox = createNode('combobox-semi', 'combobox');
    setNodeAttr(combobox, 'value', 'alpha;beta');
    assert.equal(projectSingleNodeContent(combobox), 'selected="alpha,beta"');
});

test('plain text node content remains unchanged after projection', () => {
    const paragraph = createNode('p-1', 'paragraph');
    setNodeContent(paragraph, '原始文本');

    const viewRoot = toViewRoot(createNode('root', 'root', [paragraph]));
    assert.equal(firstChild(viewRoot).content, '原始文本');
});

test('diff detects textbox value change through projected content', () => {
    const baselineTextbox = createNode('textbox-x', 'textbox');
    setNodeAttr(baselineTextbox, 'type', 'text');
    const baselineRoot = createNode('root', 'root', [baselineTextbox]);

    const currentTextbox = createNode('textbox-x', 'textbox');
    setNodeAttr(currentTextbox, 'type', 'text');
    setNodeAttr(currentTextbox, 'value', 'alice');
    const currentRoot = createNode('root', 'root', [currentTextbox]);

    const baselineView = toViewRoot(baselineRoot);
    const currentView = toViewRoot(currentRoot);

    assert.equal(firstChild(baselineView).content, 'empty');
    assert.equal(firstChild(currentView).content, 'value="alice"');

    const diff = computeMinimalChangedSubtree(currentView, baselineView);
    assert.equal(diff.mode, 'diff');
    if (diff.mode !== 'diff') {return;}
    assert.equal(diff.diffRootId, 'textbox-x');
});

test('diff detects checkbox checked change through projected content', () => {
    const baseline = createNode('checkbox-x', 'checkbox');
    setNodeAttrs(baseline, {
        type: 'checkbox',
        'aria-checked': 'false',
    });

    const current = createNode('checkbox-x', 'checkbox');
    setNodeAttrs(current, {
        type: 'checkbox',
        'aria-checked': 'true',
    });

    const baselineView = toViewRoot(createNode('root', 'root', [baseline]));
    const currentView = toViewRoot(createNode('root', 'root', [current]));
    assert.equal(firstChild(baselineView).content, 'unchecked');
    assert.equal(firstChild(currentView).content, 'checked');

    const diff = computeMinimalChangedSubtree(currentView, baselineView);
    assert.equal(diff.mode, 'diff');
    if (diff.mode !== 'diff') {return;}
    assert.equal(diff.diffRootId, 'checkbox-x');
});

test('diff detects combobox selected change through projected content', () => {
    const baseline = createNode('combobox-x', 'combobox');
    const current = createNode('combobox-x', 'combobox');
    setNodeAttr(current, 'value', '北京');

    const baselineView = toViewRoot(createNode('root', 'root', [baseline]));
    const currentView = toViewRoot(createNode('root', 'root', [current]));
    assert.equal(firstChild(baselineView).content, 'empty');
    assert.equal(firstChild(currentView).content, 'selected="北京"');

    const diff = computeMinimalChangedSubtree(currentView, baselineView);
    assert.equal(diff.mode, 'diff');
    if (diff.mode !== 'diff') {return;}
    assert.equal(diff.diffRootId, 'combobox-x');
});

test('diff detects expanded state change through projected content', () => {
    const baseline = createNode('button-x', 'button');
    setNodeAttr(baseline, 'aria-expanded', 'false');

    const current = createNode('button-x', 'button');
    setNodeAttr(current, 'aria-expanded', 'true');

    const baselineView = toViewRoot(createNode('root', 'root', [baseline]));
    const currentView = toViewRoot(createNode('root', 'root', [current]));

    const diff = computeMinimalChangedSubtree(currentView, baselineView);
    assert.equal(diff.mode, 'diff');
    if (diff.mode !== 'diff') {return;}
    assert.equal(diff.diffRootId, 'button-x');
});

test('diff promotes popup-like container when dialog subtree appears', () => {
    const baselineRoot = createNode('root', 'root', [
        createNode('main-1', 'main', [createNode('btn-a', 'button')]),
    ]);

    const dialogLeaf = createNode('dialog-action', 'button');
    const currentRoot = createNode('root', 'root', [
        createNode('main-1', 'main', [createNode('btn-a', 'button')]),
        createNode('dialog-1', 'dialog', [dialogLeaf]),
    ]);

    const baselineView = toViewRoot(baselineRoot);
    const currentView = toViewRoot(currentRoot);

    const diff = computeMinimalChangedSubtree(currentView, baselineView);
    assert.equal(diff.mode, 'diff');
    if (diff.mode !== 'diff') {return;}
    assert.equal(diff.diffRootId, 'dialog-1');
});
