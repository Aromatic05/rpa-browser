import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuntimeStateMap } from '../getRuntimeStateMap';

type FakeElement = {
    tagName: string;
    parentElement: FakeElement | null;
    previousElementSibling: FakeElement | null;
    textContent?: string;
    isContentEditable?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    checked?: boolean;
    selected?: boolean;
    value?: string;
    type?: string;
    placeholder?: string;
    selectedOptions?: Array<{ textContent?: string }>;
    getAttribute: (name: string) => string | null;
};

const createElement = (
    tagName: string,
    attrs: Record<string, string> = {},
    parentElement: FakeElement | null = null,
): FakeElement => ({
    tagName,
    parentElement,
    previousElementSibling: null,
    getAttribute: (name: string) => attrs[name] ?? null,
});

const withFakeDocument = async <T>(
    elements: FakeElement[],
    run: () => Promise<T>,
): Promise<T> => {
    const root = (() => {
        const first = elements[0];
        if (!first) return createElement('HTML');
        let cursor: FakeElement = first;
        while (cursor.parentElement) cursor = cursor.parentElement;
        return cursor;
    })();
    const previous = (globalThis as { document?: unknown }).document;
    const fakeDocument = {
        documentElement: root,
        activeElement: null,
        querySelectorAll: (selector: string) => {
            if (selector === 'iframe') return [];
            return elements;
        },
    };
    (globalThis as { document?: unknown }).document = fakeDocument;
    try {
        return await run();
    } finally {
        if (typeof previous === 'undefined') {
            delete (globalThis as { document?: unknown }).document;
        } else {
            (globalThis as { document?: unknown }).document = previous;
        }
    }
};

test('runtime collector skips descendants of ignored ancestors', async () => {
    const root = createElement('HTML');
    const ignoredAncestor = createElement('DIV', { 'data-rpa-snapshot-ignore': 'true' }, root);
    const input = createElement('INPUT', { type: 'checkbox' }, ignoredAncestor);
    input.checked = true;

    const page = {
        evaluate: async <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) =>
            withFakeDocument([input], async () => fn(arg)),
    };

    const map = await getRuntimeStateMap(page as never);
    assert.equal(Object.keys(map).length, 0);
});

test('runtime collector keeps element when ancestor chain is not ignored', async () => {
    const root = createElement('HTML');
    const container = createElement('DIV', {}, root);
    const input = createElement('INPUT', { type: 'checkbox' }, container);
    input.checked = true;

    const page = {
        evaluate: async <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) =>
            withFakeDocument([input], async () => fn(arg)),
    };

    const map = await getRuntimeStateMap(page as never);
    const values = Object.values(map);
    assert.equal(values.length, 1);
    assert.equal(values[0]?.checked, 'true');
});

test('runtime collector captures combobox value/selected from text when non-native control', async () => {
    const root = createElement('HTML');
    const container = createElement('DIV', {}, root);
    const combo = createElement('DIV', { role: 'combobox', id: 'expenseType' }, container);
    combo.textContent = '办公用品';

    const page = {
        evaluate: async <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) =>
            withFakeDocument([combo], async () => fn(arg)),
    };

    const map = await getRuntimeStateMap(page as never);
    const values = Object.values(map);
    assert.equal(values.length, 1);
    assert.equal(values[0]?.role, 'combobox');
    assert.equal(values[0]?.value, '办公用品');
    assert.equal(values[0]?.selected, '办公用品');
});
