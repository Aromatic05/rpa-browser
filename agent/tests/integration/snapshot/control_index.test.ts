import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildControlSnapshot,
    buildPageObservation,
    buildRelationIndex,
    buildLocatorIndex,
    resolveControlRef,
    type RawCapturedNode,
    type RawPageCapture,
} from '../../../src/snapshot';

const active = () => ({
    hiddenByStyle: false,
    inert: false,
    selfHasBox: true,
    rendered: true,
});

const node = (
    captureId: string,
    tag: string,
    parentCaptureId: string | undefined,
    childCaptureIds: string[],
    attributes: Record<string, string> = {},
    ownText?: string,
): RawCapturedNode => ({
    captureId,
    scopeId: 'main',
    parentCaptureId,
    childCaptureIds,
    tag,
    attributes,
    ownText,
    activity: active(),
});

const capture = (
    nodes: RawCapturedNode[],
    completeness: RawPageCapture['completeness'] = {
        dom: 'complete',
        a11y: 'complete',
        runtime: 'complete',
        geometry: 'complete',
    },
): RawPageCapture => ({
    identity: { pageEpoch: 'control-fixture', captureRevision: 1 },
    metadata: { schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-28T00:00:00.000Z' },
    completeness,
    scopes: [{ id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness }],
    nodes,
    accessibility: [],
    runtimeState: {},
    diagnostics: [],
});

const build = (nodes: RawCapturedNode[], completeness?: RawPageCapture['completeness']) => {
    const observation = buildPageObservation(capture(nodes, completeness));
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    return buildControlSnapshot({ observation, relations, locators });
};

test('native controls and options use canonical locators and preserve raw case', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['select']),
        node('select', 'select', 'body', ['option-a', 'option-b'], { id: 'ExpenseType' }),
        node('option-a', 'option', 'select', [], { value: 'CaseSensitive', 'data-value': 'DATA-Key' }, 'Alpha'),
        node('option-b', 'option', 'select', [], { value: 'lower' }, 'Beta'),
    ]);

    const control = Object.values(snapshot.controls.controls).find((item) => item.kind === 'native_select');
    assert.ok(control);
    assert.equal(control.status, 'complete');
    assert.equal(control.capabilities.includes('select_option'), true);
    assert.equal(control.optionNodeIds.length, 2);
    assert.equal(control.options[0]?.value, 'CaseSensitive');
    assert.equal(control.options[0]?.dataValue, 'DATA-Key');
    assert.equal(snapshot.locators.byNodeId[control.controlNodeId!]?.length, 1);
    for (const optionNodeId of control.optionNodeIds) {
        const option = Object.values(snapshot.controls.controls).find((item) =>
            item.kind === 'option' && item.controlNodeId === optionNodeId);
        assert.ok(option);
        assert.equal(option.capabilities.includes('click'), true);
        assert.equal(snapshot.locators.byNodeId[optionNodeId]?.length, 1);
    }
});


test('atomic input textarea button link and date controls expose only supported capabilities', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['input', 'textarea', 'button', 'link', 'date']),
        node('input', 'input', 'body', [], { id: 'TextInput', type: 'text' }),
        node('textarea', 'textarea', 'body', [], { id: 'Notes' }),
        node('button', 'button', 'body', [], { id: 'Submit' }, 'Submit'),
        node('link', 'a', 'body', [], { id: 'Details', href: '/details' }, 'Details'),
        node('date', 'input', 'body', [], { id: 'DueDate', type: 'date' }),
    ]);
    const controls = Object.values(snapshot.controls.controls);
    const byKind = (kind: string) => controls.find((control) => control.kind === kind);
    assert.deepEqual([...(byKind('input')?.capabilities ?? [])].sort(), ['click', 'fill', 'focus']);
    assert.deepEqual([...(byKind('textarea')?.capabilities ?? [])].sort(), ['click', 'fill', 'focus']);
    assert.deepEqual([...(byKind('button')?.capabilities ?? [])].sort(), ['click', 'focus']);
    assert.deepEqual([...(byKind('link')?.capabilities ?? [])].sort(), ['click', 'focus']);
    assert.deepEqual([...(byKind('date_like')?.capabilities ?? [])].sort(), ['click', 'fill', 'focus']);
    assert.equal(snapshot.controls.validation.ok, true);
});


test('readonly and disabled atomic controls do not expose unsupported capabilities', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['readonly', 'disabled']),
        node('readonly', 'input', 'body', [], { id: 'Readonly', type: 'text', readonly: '' }),
        node('disabled', 'button', 'body', [], { id: 'Disabled', disabled: '' }, 'Disabled'),
    ]);
    const controls = Object.values(snapshot.controls.controls);
    const readonly = controls.find((control) => control.controlNodeId === snapshot.observation.captureIdToNodeId.readonly);
    const disabled = controls.find((control) => control.controlNodeId === snapshot.observation.captureIdToNodeId.disabled);
    assert.deepEqual(readonly?.capabilities, ['focus', 'click']);
    assert.deepEqual(disabled?.capabilities, []);
});

test('duplicate explicit control refs are ambiguous with component context', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['a', 'b']),
        node('a', 'button', 'body', [], { 'data-rpa-control-ref': 'duplicate-ref' }, 'A'),
        node('b', 'button', 'body', [], { 'data-rpa-control-ref': 'duplicate-ref' }, 'B'),
    ]);

    const resolution = resolveControlRef(snapshot.controls, 'duplicate-ref');
    assert.equal(resolution.status, 'ambiguous');
    assert.equal(resolution.status === 'ambiguous' ? resolution.candidates.length : 0, 2);
    const diagnostic = snapshot.controls.diagnostics.find((item) => item.code === 'control.ref.duplicate');
    assert.ok(diagnostic);
    assert.equal(diagnostic?.evidence[0]?.detail?.ref, 'duplicate-ref');
    assert.equal(Array.isArray(diagnostic?.evidence[0]?.detail?.components), true);
});

test('radio and checkbox grouping never crosses safe boundaries', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form']),
        node('form', 'form', 'body', ['item-a', 'item-b', 'check-a', 'check-b']),
        node('item-a', 'div', 'form', ['ra1', 'ra2'], { class: 'form-item' }),
        node('ra1', 'input', 'item-a', [], { type: 'radio', name: 'status', value: 'A' }),
        node('ra2', 'input', 'item-a', [], { type: 'radio', name: 'status', value: 'B' }),
        node('item-b', 'div', 'form', ['rb1', 'rb2'], { class: 'form-item' }),
        node('rb1', 'input', 'item-b', [], { type: 'radio', name: 'status', value: 'C' }),
        node('rb2', 'input', 'item-b', [], { type: 'radio', name: 'status', value: 'D' }),
        node('check-a', 'fieldset', 'form', ['ca1', 'ca2']),
        node('ca1', 'input', 'check-a', [], { type: 'checkbox', value: 'X' }),
        node('ca2', 'input', 'check-a', [], { type: 'checkbox', value: 'Y' }),
        node('check-b', 'div', 'form', ['cb1', 'cb2'], { role: 'group' }),
        node('cb1', 'input', 'check-b', [], { type: 'checkbox', value: 'M' }),
        node('cb2', 'input', 'check-b', [], { type: 'checkbox', value: 'N' }),
    ]);

    const controls = Object.values(snapshot.controls.controls);
    const radios = controls.filter((item) => item.kind === 'radio_group');
    const checks = controls.filter((item) => item.kind === 'checkbox_group');
    assert.equal(radios.length, 2);
    assert.deepEqual(radios.map((item) => item.optionNodeIds.length), [2, 2]);
    assert.equal(checks.length, 2);
    assert.deepEqual(checks.map((item) => item.optionNodeIds.length), [2, 2]);
});

test('custom select is partial while closed and complete only with exact popup ownership', () => {
    const closed = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['combo']),
        node('combo', 'input', 'body', [], {
            id: 'ExpenseType', role: 'combobox', 'aria-controls': 'ExpensePopup', 'aria-expanded': 'false',
        }),
    ]);
    const closedControl = Object.values(closed.controls.controls).find((item) => item.kind === 'custom_select');
    assert.ok(closedControl);
    assert.equal(closedControl.status, 'partial');
    assert.equal(closedControl.capabilities.includes('open_popup'), true);
    assert.equal(closedControl.capabilities.includes('select_option'), false);

    const open = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['combo', 'popup']),
        node('combo', 'input', 'body', [], {
            id: 'ExpenseType', role: 'combobox', 'aria-controls': 'ExpensePopup', 'aria-expanded': 'true',
        }),
        node('popup', 'div', 'body', ['opt-a', 'opt-b'], { id: 'ExpensePopup', role: 'listbox' }),
        node('opt-a', 'div', 'popup', [], { role: 'option', 'data-value': 'Office' }, '办公用品'),
        node('opt-b', 'div', 'popup', [], { role: 'option', 'data-value': 'Travel' }, '差旅'),
    ]);
    const openControl = Object.values(open.controls.controls).find((item) => item.kind === 'custom_select');
    assert.ok(openControl);
    assert.equal(openControl.status, 'complete');
    assert.equal(openControl.capabilities.includes('select_option'), true);
    assert.equal(openControl.popupNodeId, open.observation.captureIdToNodeId.popup);
    assert.deepEqual(openControl.options.map((item) => item.dataValue), ['Office', 'Travel']);
});

test('ambiguous popup ownership and incomplete facts suppress executable capability', () => {
    const ambiguous = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['combo', 'popup-a', 'popup-b']),
        node('combo', 'input', 'body', [], {
            role: 'combobox', 'aria-controls': 'same-popup', 'aria-expanded': 'true',
        }),
        node('popup-a', 'div', 'body', [], { id: 'same-popup', role: 'listbox' }),
        node('popup-b', 'div', 'body', [], { id: 'same-popup', role: 'listbox' }),
    ]);
    const ambiguousControl = Object.values(ambiguous.controls.controls).find((item) => item.kind === 'custom_select');
    assert.ok(ambiguousControl);
    assert.equal(ambiguousControl.status, 'ambiguous');
    assert.equal(ambiguousControl.capabilities.includes('select_option'), false);

    const partial = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['combo', 'popup']),
        node('combo', 'input', 'body', [], {
            role: 'combobox', 'aria-controls': 'popup', 'aria-expanded': 'true',
        }),
        node('popup', 'div', 'body', ['option'], { id: 'popup', role: 'listbox' }),
        node('option', 'div', 'popup', [], { role: 'option' }, 'A'),
    ], { dom: 'complete', geometry: 'complete', a11y: 'unavailable', runtime: 'unavailable' });
    const partialControl = Object.values(partial.controls.controls).find((item) => item.kind === 'custom_select');
    assert.ok(partialControl);
    assert.equal(partialControl.status, 'partial');
    assert.equal(partialControl.capabilities.includes('select_option'), false);
    assert.equal(partialControl.diagnostics.some((item) => item.code === 'control.completeness.inherited'), true);
});

test('control collector registry has deterministic order and rejects duplicate collector ids', async () => {
    const { ControlCollectorRegistry, createDefaultControlCollectorRegistry } = await import('../../../src/snapshot');
    assert.deepEqual(createDefaultControlCollectorRegistry().list(), [
        'radio-groups',
        'checkbox-groups',
        'custom-selects',
        'native-selects',
        'popup-options',
        'atomic-controls',
    ]);
    const registry = new ControlCollectorRegistry();
    registry.register({ id: 'one', collect: () => undefined });
    assert.throws(
        () => registry.register({ id: 'one', collect: () => undefined }),
        /duplicate control collector/,
    );
});


test('control refs are scope-local and anonymous choice groups do not collide with their first option', () => {
    const completeness = { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' } as const;
    const raw: RawPageCapture = {
        identity: { pageEpoch: 'scope-control', captureRevision: 1 },
        metadata: { schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-28T00:00:00.000Z' },
        completeness,
        scopes: [
            { id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness },
            { id: 'frame', kind: 'iframe', parentScopeId: 'main', hostCaptureId: 'frame-host', rootCaptureId: 'frame-html', status: 'captured', completeness },
        ],
        nodes: [
            { ...node('html', 'html', undefined, ['body']), scopeId: 'main' },
            { ...node('body', 'body', 'html', ['same-main', 'group', 'frame-host']), scopeId: 'main' },
            { ...node('same-main', 'button', 'body', [], { id: 'same' }, 'Main'), scopeId: 'main' },
            { ...node('group', 'div', 'body', ['r1', 'r2'], { role: 'radiogroup' }), scopeId: 'main' },
            { ...node('r1', 'input', 'group', [], { id: 'R1', type: 'radio', name: 'choice', value: 'A' }), scopeId: 'main' },
            { ...node('r2', 'input', 'group', [], { id: 'R2', type: 'radio', name: 'choice', value: 'B' }), scopeId: 'main' },
            { ...node('frame-host', 'iframe', 'body', [], { id: 'Frame' }), scopeId: 'main' },
            { ...node('frame-html', 'html', undefined, ['frame-body']), scopeId: 'frame' },
            { ...node('frame-body', 'body', 'frame-html', ['same-frame']), scopeId: 'frame' },
            { ...node('same-frame', 'button', 'frame-body', [], { id: 'same' }, 'Frame'), scopeId: 'frame' },
        ],
        accessibility: [], runtimeState: {}, diagnostics: [],
    };
    const observation = buildPageObservation(raw);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const snapshot = buildControlSnapshot({ observation, relations, locators });
    const sameButtons = Object.values(snapshot.controls.controls).filter((control) => control.kind === 'button');
    assert.equal(sameButtons.length, 2);
    assert.notEqual(sameButtons[0].ref, sameButtons[1].ref);
    assert.equal(sameButtons.every((control) => control.status === 'complete'), true);
    const group = Object.values(snapshot.controls.controls).find((control) => control.kind === 'radio_group');
    assert.ok(group);
    assert.equal(group.status, 'complete');
    assert.equal(group.capabilities.includes('select_option'), true);
    assert.notEqual(group.ref, Object.values(snapshot.controls.controls).find((control) => control.kind === 'option')?.ref);
});

test('control capabilities respect activity, completeness, input type, aria disabled state and group option state', () => {
    const nodes = [
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['hidden', 'submit', 'file', 'single-check', 'aria-button', 'group', 'combo', 'popup']),
        { ...node('hidden', 'input', 'body', [], { id: 'Hidden', type: 'hidden' }), activity: { hiddenByStyle: true, inert: false, selfHasBox: false, rendered: false } },
        node('submit', 'input', 'body', [], { id: 'Submit', type: 'submit', value: 'Save' }),
        node('file', 'input', 'body', [], { id: 'File', type: 'file' }),
        node('single-check', 'input', 'body', [], { id: 'SingleCheck', type: 'checkbox' }),
        node('aria-button', 'div', 'body', [], { id: 'AriaButton', role: 'button', 'aria-disabled': 'true' }, 'Disabled'),
        node('group', 'div', 'body', ['r1', 'r2'], { id: 'Group', role: 'radiogroup' }),
        node('r1', 'input', 'group', [], { id: 'R1', type: 'radio', name: 'choice', value: 'A', disabled: '' }),
        node('r2', 'input', 'group', [], { id: 'R2', type: 'radio', name: 'choice', value: 'B' }),
        node('combo', 'button', 'body', [], { id: 'Combo', role: 'combobox', 'aria-controls': 'Popup', 'aria-expanded': 'true' }, 'Choose'),
        node('popup', 'div', 'body', ['option'], { id: 'Popup', role: 'listbox' }),
        node('option', 'button', 'popup', [], { role: 'option', 'data-value': 'X', 'aria-disabled': 'true' }, 'X'),
    ];
    const snapshot = build(nodes);
    const controls = Object.values(snapshot.controls.controls);
    assert.equal(controls.some((control) => control.controlNodeId === snapshot.observation.captureIdToNodeId.hidden), false);
    const submit = controls.find((control) => control.controlNodeId === snapshot.observation.captureIdToNodeId.submit);
    assert.equal(submit?.kind, 'button');
    assert.deepEqual([...(submit?.capabilities ?? [])].sort(), ['click', 'focus']);
    assert.equal(controls.some((control) => control.controlNodeId === snapshot.observation.captureIdToNodeId.file), false);
    const singleCheck = controls.find((control) => control.controlNodeId === snapshot.observation.captureIdToNodeId['single-check']);
    assert.deepEqual([...(singleCheck?.capabilities ?? [])].sort(), ['click', 'focus', 'toggle']);
    const ariaButton = controls.find((control) => control.controlNodeId === snapshot.observation.captureIdToNodeId['aria-button']);
    assert.deepEqual(ariaButton?.capabilities, []);
    const group = controls.find((control) => control.kind === 'radio_group');
    assert.equal(group?.state.disabled, false);
    assert.equal(group?.capabilities.includes('select_option'), true);
    const combo = controls.find((control) => control.kind === 'custom_select');
    assert.equal(combo?.options[0]?.disabled, true);

    const partial = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['input']),
        node('input', 'input', 'body', [], { id: 'Partial', type: 'text' }),
    ], { dom: 'complete', a11y: 'partial', runtime: 'partial', geometry: 'complete' });
    const partialInput = Object.values(partial.controls.controls).find((control) => control.kind === 'input');
    assert.deepEqual(partialInput?.capabilities, []);
});

test('choice grouping requires native radio identity or an explicit checkbox boundary', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form-a', 'form-b', 'outside-a', 'outside-b']),
        node('form-a', 'form', 'body', ['unnamed-a', 'unnamed-b', 'terms', 'news'], { id: 'FormA' }),
        node('unnamed-a', 'input', 'form-a', [], { type: 'radio', value: 'A' }),
        node('unnamed-b', 'input', 'form-a', [], { type: 'radio', value: 'B' }),
        node('terms', 'input', 'form-a', [], { type: 'checkbox', name: 'terms', value: 'yes' }),
        node('news', 'input', 'form-a', [], { type: 'checkbox', name: 'newsletter', value: 'yes' }),
        node('form-b', 'form', 'body', [], { id: 'FormB' }),
        node('outside-a', 'input', 'body', [], { type: 'radio', name: 'external', form: 'FormA', value: 'A' }),
        node('outside-b', 'input', 'body', [], { type: 'radio', name: 'external', form: 'FormB', value: 'B' }),
    ]);
    const controls = Object.values(snapshot.controls.controls);
    assert.equal(controls.filter((control) => control.kind === 'radio_group').length, 0);
    assert.equal(controls.filter((control) => control.kind === 'checkbox_group').length, 0);
    assert.equal(controls.filter((control) => control.kind === 'input').length, 6);
});

test('partial accessibility facts make atomic controls partial and non-executable', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['input']),
        node('input', 'input', 'body', [], { id: 'PartialA11y', type: 'text' }),
    ], { dom: 'complete', a11y: 'partial', runtime: 'complete', geometry: 'complete' });
    const control = Object.values(snapshot.controls.controls).find((item) => item.kind === 'input');
    assert.ok(control);
    assert.equal(control.status, 'partial');
    assert.deepEqual(control.capabilities, []);
    assert.equal(control.diagnostics.some((item) => item.code === 'control.completeness.inherited'), true);
});
