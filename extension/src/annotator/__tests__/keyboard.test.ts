import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isTypingTarget,
    resolveKeyboardAction,
} from '../keyboard.js';

const ctx = (overrides?: Partial<Parameters<typeof resolveKeyboardAction>[1]>) => ({
    annotatorActive: true,
    inPickMode: false,
    hasSelection: false,
    canUndo: true,
    canRedo: true,
    ...overrides,
});

const key = (
    k: string,
    partial?: Partial<Parameters<typeof resolveKeyboardAction>[0]>,
) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    ...partial,
});

test('isTypingTarget detects INPUT, TEXTAREA, SELECT and contenteditable', () => {
    assert.equal(isTypingTarget({tagName: 'input'}), true);
    assert.equal(isTypingTarget({tagName: 'TEXTAREA'}), true);
    assert.equal(isTypingTarget({tagName: 'select'}), true);
    assert.equal(isTypingTarget({tagName: 'div', isContentEditable: true}), true);
    assert.equal(isTypingTarget({tagName: 'div'}), false);
    assert.equal(isTypingTarget(null), false);
    assert.equal(isTypingTarget(undefined), false);
});

test('Esc always resolves to cancel even when typing in an input', () => {
    const action = resolveKeyboardAction(
        key('Escape', {target: {tagName: 'INPUT'}}),
        ctx(),
    );
    assert.equal(action.type, 'cancel');
});

test('Esc is a no-op when annotator is not active', () => {
    const action = resolveKeyboardAction(key('Escape'), ctx({annotatorActive: false}));
    assert.equal(action.type, 'none');
});

test('typing in input suppresses Delete, Enter, Ctrl+S, Ctrl+Z', () => {
    const typingCtx = ctx();
    const inputTarget = {target: {tagName: 'INPUT'}};
    assert.equal(resolveKeyboardAction(key('Delete', {...inputTarget}), {...typingCtx, hasSelection: true}).type, 'none');
    assert.equal(resolveKeyboardAction(key('Enter', {...inputTarget}), {...typingCtx, inPickMode: true}).type, 'none');
    assert.equal(resolveKeyboardAction(key('s', {ctrlKey: true, ...inputTarget}), typingCtx).type, 'none');
    assert.equal(resolveKeyboardAction(key('z', {ctrlKey: true, ...inputTarget}), typingCtx).type, 'none');
});

test('Ctrl+S resolves to save and is not blocked by typing guard', () => {
    const action = resolveKeyboardAction(key('s', {ctrlKey: true}), ctx());
    assert.equal(action.type, 'save');
});

test('Cmd+S also resolves to save (metaKey)', () => {
    const action = resolveKeyboardAction(key('s', {metaKey: true}), ctx());
    assert.equal(action.type, 'save');
});

test('Ctrl+Z resolves to undo when history is available', () => {
    const action = resolveKeyboardAction(key('z', {ctrlKey: true}), ctx({canUndo: true}));
    assert.equal(action.type, 'undo');
});

test('Ctrl+Z is a no-op when nothing to undo', () => {
    const action = resolveKeyboardAction(key('z', {ctrlKey: true}), ctx({canUndo: false}));
    assert.equal(action.type, 'none');
});

test('Ctrl+Shift+Z resolves to redo when history is available', () => {
    const action = resolveKeyboardAction(key('z', {ctrlKey: true, shiftKey: true}), ctx({canRedo: true}));
    assert.equal(action.type, 'redo');
});

test('Ctrl+Shift+Z is a no-op when nothing to redo', () => {
    const action = resolveKeyboardAction(key('z', {ctrlKey: true, shiftKey: true}), ctx({canRedo: false}));
    assert.equal(action.type, 'none');
});

test('Enter resolves to confirm only in pick mode', () => {
    assert.equal(resolveKeyboardAction(key('Enter'), ctx({inPickMode: true})).type, 'confirm');
    assert.equal(resolveKeyboardAction(key('Enter'), ctx({inPickMode: false})).type, 'none');
});

test('Delete / Backspace resolve to delete when an annotation is selected', () => {
    assert.equal(resolveKeyboardAction(key('Delete'), ctx({hasSelection: true})).type, 'delete');
    assert.equal(resolveKeyboardAction(key('Backspace'), ctx({hasSelection: true})).type, 'delete');
    assert.equal(resolveKeyboardAction(key('Delete'), ctx({hasSelection: false})).type, 'none');
});

test('plain letter keys are no-ops', () => {
    assert.equal(resolveKeyboardAction(key('a'), ctx()).type, 'none');
    assert.equal(resolveKeyboardAction(key(' '), ctx()).type, 'none');
});
