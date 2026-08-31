import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cleanupTaggedRuntimeState,
    collectTaggedRuntimeState,
    collectTaggedRuntimeStateCapture,
    RUNTIME_STATE_ATTRIBUTE,
} from '../../../src/automation/snapshot/observation/model/runtime_state';
import {buildPageObservation} from '../../../src/automation/snapshot/observation/model/build';
import type {RawPageCapture} from '../../../src/automation/snapshot/observation/model/raw_capture';

type FakeElement = {
    nodeType: number;
    tagName: string;
    children: FakeElement[];
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
    contentDocument?: FakeDocument | null;
    shadowRoot?: { querySelectorAll: (selector: string) => FakeElement[] } | null;
    getRootNode: () => unknown;
    getAttribute: (name: string) => string | null;
    setAttribute: (name: string, value: string) => void;
    removeAttribute: (name: string) => void;
    querySelectorAll: (selector: string) => FakeElement[];
};

type FakeDocument = {
    documentElement: FakeElement;
    activeElement: FakeElement | null;
    querySelectorAll: (selector: string) => FakeElement[];
    getElementById: (id: string) => FakeElement | null;
};

const splitSelectors = (selector: string): string[] => {
    return selector
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
};

const matchesSelector = (el: FakeElement, selector: string): boolean => {
    if (!selector) {return false;}
    if (selector === '*') {return true;}

    if (selector.endsWith(':checked')) {
        const tag = selector.slice(0, -':checked'.length).trim().toLowerCase();
        return el.tagName.toLowerCase() === tag && !!el.selected;
    }

    const roleMatch = selector.match(/^\[role="([^"]+)"\]$/);
    if (roleMatch) {
        return (el.getAttribute('role') || '').trim().toLowerCase() === roleMatch[1].toLowerCase();
    }

    const attrExactMatch = selector.match(/^\[([^=\]]+)="([^"]*)"\]$/);
    if (attrExactMatch) {
        const attrName = attrExactMatch[1];
        const attrValue = attrExactMatch[2];
        return (el.getAttribute(attrName) || '') === attrValue;
    }

    const attrExistMatch = selector.match(/^\[([^\]=]+)\]$/);
    if (attrExistMatch) {
        const attrName = attrExistMatch[1];
        if (attrName === 'contenteditable') {return !!el.isContentEditable || el.getAttribute(attrName) !== null;}
        return el.getAttribute(attrName) !== null;
    }

    return el.tagName.toLowerCase() === selector.toLowerCase();
};

const collectSubtree = (root: FakeElement, includeSelf: boolean): FakeElement[] => {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement, appendSelf: boolean) => {
        if (appendSelf) {out.push(node);}
        for (const child of node.children) {
            walk(child, true);
        }
    };
    walk(root, includeSelf);
    return out;
};

const queryFromSubtree = (root: FakeElement, selector: string, includeSelf: boolean): FakeElement[] => {
    const candidates = collectSubtree(root, includeSelf);
    const selectors = splitSelectors(selector);
    if (selectors.length === 0) {return [];}

    const seen = new Set<FakeElement>();
    const out: FakeElement[] = [];
    for (const candidate of candidates) {
        if (!selectors.some((item) => matchesSelector(candidate, item))) {continue;}
        if (seen.has(candidate)) {continue;}
        seen.add(candidate);
        out.push(candidate);
    }
    return out;
};

const createElement = (
    tagName: string,
    attrs: Record<string, string> = {},
    parentElement: FakeElement | null = null,
): FakeElement => {
    const ownedAttrs: Record<string, string> = { ...attrs };
    const element: FakeElement = {
        nodeType: 1,
        tagName,
        children: [],
        parentElement,
        previousElementSibling: null,
        getRootNode: () => null,
        getAttribute: (name: string) => ownedAttrs[name] ?? null,
        setAttribute: (name: string, value: string) => {
            ownedAttrs[name] = value;
        },
        removeAttribute: (name: string) => {
            delete ownedAttrs[name];
        },
        querySelectorAll: (selector: string) => queryFromSubtree(element, selector, false),
    };

    if (parentElement) {
        const previous = parentElement.children[parentElement.children.length - 1] || null;
        element.previousElementSibling = previous;
        parentElement.children.push(element);
    }

    if (attrs.contenteditable === 'true' || attrs.contenteditable === '1') {
        element.isContentEditable = true;
    }
    if (attrs.type) {
        element.type = attrs.type;
    }
    if (attrs.placeholder) {
        element.placeholder = attrs.placeholder;
    }
    if (attrs.value) {
        element.value = attrs.value;
    }
    if (attrs.disabled === 'true' || attrs.disabled === '1') {
        element.disabled = true;
    }
    if (attrs.readonly === 'true' || attrs.readonly === '1') {
        element.readOnly = true;
    }
    if (attrs.selected === 'true' || attrs.selected === '1') {
        element.selected = true;
    }
    if (attrs.checked === 'true' || attrs.checked === '1') {
        element.checked = true;
    }

    return element;
};

const createDocument = (root: FakeElement): FakeDocument => {
    const doc: FakeDocument = {
        documentElement: root,
        activeElement: null,
        querySelectorAll: (selector: string) => queryFromSubtree(root, selector, true),
        getElementById: (id: string) => {
            const all = queryFromSubtree(root, '*', true);
            return all.find((node) => (node.getAttribute('id') || '').trim() === id) || null;
        },
    };

    const assignRootNode = (node: FakeElement) => {
        node.getRootNode = () => doc;
        for (const child of node.children) {assignRootNode(child);}
    };
    assignRootNode(root);
    return doc;
};

const withFakeDocument = async <T>(doc: FakeDocument, run: () => Promise<T>): Promise<T> => {
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = doc;
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

const createPage = (doc: FakeDocument) => ({
    evaluate: async <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) => withFakeDocument(doc, async () => fn(arg)),
});

type RuntimeStateMap = Awaited<ReturnType<typeof collectTaggedRuntimeState>>;
type RuntimeStateRow = NonNullable<RuntimeStateMap[string]>;

const findRow = (map: RuntimeStateMap, predicate: (row: RuntimeStateRow) => boolean): RuntimeStateRow | undefined => {
    return Object.values(map).find((row): row is RuntimeStateRow => Boolean(row) && predicate(row as RuntimeStateRow));
};

test('runtime collector skips descendants of ignored ancestors', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);
    const ignoredAncestor = createElement('DIV', { 'data-rpa-snapshot-ignore': 'true' }, body);
    const input = createElement('INPUT', { type: 'checkbox' }, ignoredAncestor);
    input.checked = true;

    const doc = createDocument(root);
    const page = createPage(doc);

    const map = await collectTaggedRuntimeState(page as never, 'epoch-ignore');
    assert.equal(Object.keys(map).length, 0);
    assert.equal(input.getAttribute('data-rpa-state-id'), null);
});

test('runtime collector tags candidates and captures native control state', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);

    const input = createElement('INPUT', { type: 'text' }, body);
    input.value = 'alice';

    const textarea = createElement('TEXTAREA', {}, body);
    textarea.value = 'notes';

    const checkbox = createElement('INPUT', { type: 'checkbox' }, body);
    checkbox.checked = true;

    const select = createElement('SELECT', {}, body);
    select.value = 'beijing';
    const option = createElement('OPTION', {}, select);
    option.textContent = '北京';
    option.selected = true;
    select.selectedOptions = [option];

    const editable = createElement('DIV', { contenteditable: 'true' }, body);
    editable.isContentEditable = true;
    editable.textContent = '可编辑内容';

    const doc = createDocument(root);
    doc.activeElement = input;
    const page = createPage(doc);

    const map = await collectTaggedRuntimeState(page as never, 'epoch-native');
    const rows = Object.values(map);
    assert.ok(rows.length >= 6);

    const allStateIds = rows.map((row) => row?.stateId || '').filter(Boolean);
    assert.ok(allStateIds.every((id) => /^rpa-state-[a-z0-9-]+$/i.test(id)));
    assert.equal(new Set(allStateIds).size, allStateIds.length);

    const inputRow = findRow(map, (row) => row.tag === 'input' && row.type === 'text');
    assert.equal(inputRow?.value, 'alice');
    assert.equal(inputRow?.focused, 'true');

    const textareaRow = findRow(map, (row) => row.tag === 'textarea');
    assert.equal(textareaRow?.value, 'notes');

    const checkboxRow = findRow(map, (row) => row.tag === 'input' && row.type === 'checkbox');
    assert.equal(checkboxRow?.checked, 'true');

    const selectRow = findRow(map, (row) => row.tag === 'select');
    assert.equal(selectRow?.value, 'beijing');
    assert.equal(selectRow?.selected, '北京');

    const optionRow = findRow(map, (row) => row.tag === 'option');
    assert.equal(optionRow?.selected, 'true');

    const editableRow = findRow(map, (row) => row.tag === 'div' && row.contentEditableText === '可编辑内容');
    assert.equal(editableRow?.value, '可编辑内容');
});

test('runtime collector keeps combobox/listbox derived state fields', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);
    const combo = createElement(
        'DIV',
        {
            role: 'combobox',
            id: 'expenseType',
            'aria-controls': 'expense-popup',
            'aria-labelledby': 'expense-label',
            'aria-describedby': 'expense-help',
            'aria-valuetext': '办公用品',
            'aria-expanded': 'true',
        },
        body,
    );
    combo.textContent = '办公用品';

    const popup = createElement('DIV', { id: 'expense-popup', role: 'listbox' }, body);
    createElement('DIV', { role: 'option', 'aria-selected': 'true' }, popup).textContent = '办公用品';

    const doc = createDocument(root);
    const page = createPage(doc);

    const map = await collectTaggedRuntimeState(page as never, 'epoch-combo');
    const comboRow = findRow(map, (row) => row.role === 'combobox');
    assert.equal(comboRow?.value, '办公用品');
    assert.equal(comboRow?.selected, '办公用品');
    assert.equal(comboRow?.popupSelectedText, '办公用品');
    assert.equal(comboRow?.ariaValueText, '办公用品');
    assert.equal(comboRow?.ariaLabelledBy, 'expense-label');
    assert.equal(comboRow?.ariaDescribedBy, 'expense-help');
    assert.equal(comboRow?.ariaExpanded, 'true');
});

test('runtime collector recurses same-origin iframe and includes iframe scope in state-id', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);
    const mainInput = createElement('INPUT', { type: 'text' }, body);
    mainInput.value = 'main';

    const iframe = createElement('IFRAME', {}, body);
    const frameRoot = createElement('HTML');
    const frameBody = createElement('BODY', {}, frameRoot);
    const frameInput = createElement('INPUT', { type: 'text' }, frameBody);
    frameInput.value = 'subframe';
    iframe.contentDocument = createDocument(frameRoot);

    const doc = createDocument(root);
    const page = createPage(doc);

    const map = await collectTaggedRuntimeState(page as never, 'epoch-iframe');
    const values = Object.values(map);
    assert.ok(values.length >= 2);

    const frameRow = values.find((row) => row?.value === 'subframe');
    assert.ok(frameRow?.stateId);
    const mainRow = values.find((row) => row?.value === 'main');
    assert.notEqual(frameRow?.stateId, mainRow?.stateId);
});

test('runtime collector cleanup removes data-rpa-state-id from page', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);
    const input = createElement('INPUT', { type: 'text' }, body);
    input.value = 'cleanup';

    const doc = createDocument(root);
    const page = createPage(doc);

    const map = await collectTaggedRuntimeState(page as never, 'epoch-cleanup');
    assert.ok(Object.keys(map).length > 0);
    assert.equal(doc.querySelectorAll('[data-rpa-state-id]').length > 0, true);

    await cleanupTaggedRuntimeState(page as never);
    assert.equal(doc.querySelectorAll('[data-rpa-state-id]').length, 0);
});

test('runtime collector restores a page-owned state marker and reuses exact identity', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);
    const input = createElement('INPUT', { type: 'text', 'data-rpa-state-id': 'business-token' }, body);
    input.value = 'stable';

    const doc = createDocument(root);
    const page = createPage(doc);

    const first = await collectTaggedRuntimeState(page as never, 'capture-1');
    const firstId = Object.values(first).find(Boolean)?.stateId;
    assert.ok(firstId);
    await cleanupTaggedRuntimeState(page as never, 'capture-1');
    assert.equal(input.getAttribute('data-rpa-state-id'), 'business-token');

    const second = await collectTaggedRuntimeState(page as never, 'capture-2');
    const secondId = Object.values(second).find(Boolean)?.stateId;
    assert.equal(secondId, firstId);
    await cleanupTaggedRuntimeState(page as never, 'capture-2');
    assert.equal(input.getAttribute('data-rpa-state-id'), 'business-token');
});


test('runtime collection exposes execution failure as unavailable', async () => {
    const page = {
        evaluate: async () => {
            throw new Error('page context unavailable');
        },
    };
    const result = await collectTaggedRuntimeStateCapture(page as never, 'capture-failure');
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.records, {});
    assert.match(result.error ?? '', /page context unavailable/);
});

test('runtime collector preserves explicit empty string for editable control values', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);

    const input = createElement('INPUT', { type: 'text' }, body);
    input.value = '';

    const textarea = createElement('TEXTAREA', {}, body);
    textarea.value = '';

    const select = createElement('SELECT', {}, body);
    select.value = '';

    const doc = createDocument(root);
    const page = createPage(doc);

    const map = await collectTaggedRuntimeState(page as never, 'epoch-empty-values');

    const inputRow = findRow(map, (row) => row.tag === 'input' && row.type === 'text');
    assert.equal(inputRow?.value, '', 'an empty text input must capture its explicit empty value');

    const textareaRow = findRow(map, (row) => row.tag === 'textarea');
    assert.equal(textareaRow?.value, '', 'an empty textarea must capture its explicit empty value');

    const selectRow = findRow(map, (row) => row.tag === 'select');
    assert.equal(selectRow?.value, '', 'an empty select must capture its explicit empty value');
});

test('runtime collector preserves user-entered whitespace in editable values', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);

    const whitespaceOnly = createElement('INPUT', { type: 'text' }, body);
    whitespaceOnly.value = '   ';

    const padded = createElement('TEXTAREA', {}, body);
    padded.value = '  alice  ';

    const doc = createDocument(root);
    const page = createPage(doc);

    const map = await collectTaggedRuntimeState(page as never, 'epoch-whitespace');

    const whitespaceRow = findRow(map, (row) => row.tag === 'input' && row.type === 'text');
    assert.equal(whitespaceRow?.value, '   ', 'whitespace-only input value must be preserved as entered');

    const paddedRow = findRow(map, (row) => row.tag === 'textarea');
    assert.equal(paddedRow?.value, '  alice  ', 'padded textarea value must not be trimmed');
});

test('runtime collector keeps an unreadable editable value as missing instead of empty', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);

    const input = createElement('INPUT', { type: 'text' }, body);
    delete (input as {value?: string}).value;

    const doc = createDocument(root);
    const page = createPage(doc);

    const map = await collectTaggedRuntimeState(page as never, 'epoch-missing');

    const inputRow = findRow(map, (row) => row.tag === 'input' && row.type === 'text');
    assert.equal(inputRow?.value, undefined, 'an unreadable input value must stay missing, not empty');
});

test('runtime collector distinguishes empty contenteditable text from absent editable text', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);

    const emptyEditable = createElement('DIV', { contenteditable: 'true' }, body);
    emptyEditable.isContentEditable = true;
    emptyEditable.textContent = '';

    const whitespaceEditable = createElement('DIV', { contenteditable: 'true' }, body);
    whitespaceEditable.isContentEditable = true;
    whitespaceEditable.textContent = '  ';

    const button = createElement('BUTTON', {}, body);

    const doc = createDocument(root);
    const page = createPage(doc);

    const map = await collectTaggedRuntimeState(page as never, 'epoch-editable-empty');

    const emptyRow = findRow(map, (row) => row.tag === 'div' && row.contentEditableText === '');
    assert.ok(emptyRow, 'an empty contenteditable must capture an explicit empty text state');
    assert.equal(emptyRow?.value, '', 'empty contenteditable value must be captured as empty');

    const whitespaceRow = findRow(map, (row) => row.tag === 'div' && row.contentEditableText === '  ');
    assert.ok(whitespaceRow, 'whitespace contenteditable text must be preserved as entered');
    assert.equal(whitespaceRow?.value, '  ');

    const buttonRow = findRow(map, (row) => row.tag === 'button');
    assert.equal(buttonRow?.contentEditableText, undefined, 'a non-editable element must keep editable text absent');
});

test('runtime collector still normalizes non-editable string fields from empty to absent', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);

    const input = createElement(
        'INPUT',
        {
            type: 'text',
            role: '',
            'aria-valuetext': '',
            'aria-labelledby': '',
            'aria-describedby': '',
        },
        body,
    );
    input.value = 'x';

    const doc = createDocument(root);
    const page = createPage(doc);

    const map = await collectTaggedRuntimeState(page as never, 'epoch-normalized-id');

    const inputRow = findRow(map, (row) => row.tag === 'input' && row.value === 'x');
    assert.ok(inputRow);
    assert.equal(inputRow?.value, 'x');
    assert.equal(inputRow?.role, undefined, 'empty role must remain absent');
    assert.equal(inputRow?.ariaValueText, undefined, 'empty aria-valuetext must remain absent');
    assert.equal(inputRow?.ariaLabelledBy, undefined, 'empty aria-labelledby must remain absent');
    assert.equal(inputRow?.ariaDescribedBy, undefined, 'empty aria-describedby must remain absent');
});

test('captured empty editable value survives the observation join for physical compensation', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);
    const input = createElement('INPUT', { type: 'text' }, body);
    input.value = '';

    const doc = createDocument(root);
    const page = createPage(doc);

    const records = await collectTaggedRuntimeState(page as never, 'epoch-integration');
    const inputRow = Object.values(records).find((row) => row?.tag === 'input');
    assert.equal(inputRow?.value, '');
    assert.ok(inputRow?.stateId);

    const active = {hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true} as const;
    const raw: RawPageCapture = {
        identity: {pageEpoch: 'v2-empty-integration', captureRevision: 1},
        metadata: {schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-08-30T00:00:00.000Z'},
        completeness: {dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete'},
        scopes: [{
            id: 'main',
            kind: 'document',
            rootCaptureId: 'html',
            status: 'captured',
            completeness: {dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete'},
        }],
        nodes: [
            {captureId: 'html', scopeId: 'main', childCaptureIds: ['body'], tag: 'html', attributes: {}, activity: active},
            {captureId: 'body', scopeId: 'main', parentCaptureId: 'html', childCaptureIds: ['field'], tag: 'body', attributes: {}, activity: active},
            {
                captureId: 'field',
                scopeId: 'main',
                parentCaptureId: 'body',
                childCaptureIds: [],
                tag: 'input',
                attributes: {[RUNTIME_STATE_ATTRIBUTE]: inputRow.stateId},
                activity: active,
            },
        ],
        accessibility: [],
        runtimeState: records,
        diagnostics: [],
    };

    const observation = buildPageObservation(raw);
    const nodeId = observation.captureIdToNodeId.field;
    assert.ok(nodeId);
    assert.equal(observation.runtimeState[nodeId]?.value, '', 'empty value must survive capture -> observation join');
});

test('runtime collector redacts sensitive control values before they leave the page context', async () => {
    const root = createElement('HTML');
    const body = createElement('BODY', {}, root);

    const normal = createElement('INPUT', {type: 'text', name: 'username'}, body);
    normal.value = 'alice';

    const password = createElement('INPUT', {type: 'password', autocomplete: 'current-password'}, body);
    password.value = 'password-canary';

    const hidden = createElement('INPUT', {type: 'hidden', name: 'csrfToken'}, body);
    hidden.value = 'hidden-token-canary';

    const apiKey = createElement('INPUT', {type: 'text', name: 'apiKey'}, body);
    apiKey.value = 'api-key-canary';

    const otp = createElement('INPUT', {type: 'text', autocomplete: 'one-time-code'}, body);
    otp.value = '123456';

    const page = createPage(createDocument(root));
    const map = await collectTaggedRuntimeState(page as never, 'epoch-sensitive-values');

    assert.equal(findRow(map, (row) => row.tag === 'input' && row.type === 'text' && row.value === 'alice')?.value, 'alice');
    for (const control of [password, hidden, apiKey, otp]) {
        const stateId = control.getAttribute(RUNTIME_STATE_ATTRIBUTE);
        assert.ok(stateId);
        assert.equal(map[stateId!]?.value, '[redacted]');
    }
    const serialized = JSON.stringify(map);
    assert.equal(serialized.includes('password-canary'), false);
    assert.equal(serialized.includes('hidden-token-canary'), false);
    assert.equal(serialized.includes('api-key-canary'), false);
    assert.equal(serialized.includes('123456'), false);
});
