import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    validateFormComponentIndex,
    type RawCapturedNode,
    type RawPageCapture,
} from '../../../src/snapshot';

const active = () => ({ hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true });

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

const capture = (nodes: RawCapturedNode[]): RawPageCapture => ({
    identity: { pageEpoch: 'form-fixture', captureRevision: 1 },
    metadata: { schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-28T00:00:00.000Z' },
    completeness: { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' },
    scopes: [{
        id: 'main',
        kind: 'document',
        rootCaptureId: 'html',
        status: 'captured',
        completeness: { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' },
    }],
    nodes,
    accessibility: [],
    runtimeState: {},
    diagnostics: [],
});

const build = (nodes: RawCapturedNode[], selectionScopeCaptureId?: string) => {
    const observation = buildPageObservation(capture(nodes));
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const controls = buildControlSnapshot({ observation, relations, locators }).controls;
    return buildFormSnapshot({
        observation,
        relations,
        locators,
        controls,
        selectionScopeNodeId: selectionScopeCaptureId
            ? observation.captureIdToNodeId[selectionScopeCaptureId]
            : undefined,
    });
};

const onlyForm = (snapshot: ReturnType<typeof build>) => {
    const forms = Object.values(snapshot.forms.forms);
    assert.equal(forms.length, 1);
    return forms[0];
};

test('native label relations, fieldset legend, descriptions and composite controls form typed fields', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form']),
        node('form', 'form', 'body', ['name-label', 'name', 'help', 'error', 'period', 'save', 'reset', 'cancel'], { id: 'profile-form', 'aria-label': 'Profile' }),
        node('name-label', 'label', 'form', [], { for: 'NameInput' }, 'Name'),
        node('name', 'input', 'form', [], { id: 'NameInput', type: 'text', 'aria-describedby': 'name-help', 'aria-errormessage': 'name-error', required: '' }),
        node('help', 'p', 'form', [], { id: 'name-help' }, 'Use legal name'),
        node('error', 'div', 'form', [], { id: 'name-error', role: 'alert' }, 'Name is required'),
        node('period', 'fieldset', 'form', ['legend', 'start', 'end']),
        node('legend', 'legend', 'period', [], {}, 'Period'),
        node('start', 'input', 'period', [], { id: 'StartDate', type: 'date' }),
        node('end', 'input', 'period', [], { id: 'EndDate', type: 'date' }),
        node('save', 'button', 'form', [], { type: 'submit' }, 'Save'),
        node('reset', 'button', 'form', [], { type: 'reset' }, 'Reset'),
        node('cancel', 'button', 'form', [], { type: 'button' }, 'Cancel'),
    ]);

    const form = onlyForm(snapshot);
    assert.equal(form.location.structuralRootNodeId, snapshot.observation.captureIdToNodeId.form);
    assert.equal(form.fields.length, 2);

    const nameField = form.fields.find((field) => field.labelNodeIds.includes(snapshot.observation.captureIdToNodeId['name-label']));
    assert.ok(nameField);
    assert.equal(nameField.controlIds.length, 1);
    assert.deepEqual(nameField.descriptionNodeIds, [snapshot.observation.captureIdToNodeId.help]);
    assert.deepEqual(nameField.errorNodeIds, [snapshot.observation.captureIdToNodeId.error]);
    assert.equal(nameField.required, true);

    const periodField = form.fields.find((field) => field.labelNodeIds.includes(snapshot.observation.captureIdToNodeId.legend));
    assert.ok(periodField);
    assert.equal(periodField.controlIds.length, 2);
    assert.ok(periodField.groupId);

    assert.deepEqual(form.actions.map((action) => action.structuralRole).sort(), ['button', 'reset', 'submit']);
    const cancelAction = form.actions.find((action) => action.nodeId === snapshot.observation.captureIdToNodeId.cancel);
    assert.equal(cancelAction?.suggestions.some((item) => item.value === 'cancel'), true);
    assert.equal(form.suggestions.some((item) => item.value === 'data-entry-form'), true);
    assert.equal(snapshot.forms.reductionTrace.some((item) => item.formId === form.id && item.outcome === 'formed'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(form, 'businessTag'), false);
    assert.equal(snapshot.forms.validation.ok, true, JSON.stringify(snapshot.forms.validation.diagnostics, null, 2));
});

test('explicit form and active dialog consume fields without crossing boundaries or swallowing portal popup', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form', 'external', 'dialog', 'popup', 'utility', 'adjacent-a', 'adjacent-b', 'button-box']),
        node('form', 'form', 'body', ['label-a', 'a', 'submit'], { id: 'OrderForm' }),
        node('label-a', 'label', 'form', [], { for: 'A' }, 'A'),
        node('a', 'input', 'form', [], { id: 'A', type: 'text' }),
        node('submit', 'button', 'form', [], { type: 'submit' }, 'Submit'),
        node('external', 'input', 'body', [], { id: 'External', type: 'text', form: 'OrderForm', 'aria-label': 'External' }),
        node('dialog', 'div', 'body', ['dialog-label-a', 'dialog-a', 'dialog-label-b', 'dialog-b', 'dialog-save'], { role: 'dialog', 'aria-modal': 'true' }),
        node('dialog-label-a', 'label', 'dialog', [], { for: 'DialogA' }, 'Dialog A'),
        node('dialog-a', 'input', 'dialog', [], { id: 'DialogA', type: 'text' }),
        node('dialog-label-b', 'label', 'dialog', [], { for: 'DialogB' }, 'Dialog B'),
        node('dialog-b', 'input', 'dialog', [], { id: 'DialogB', type: 'text' }),
        node('dialog-save', 'button', 'dialog', [], { type: 'button' }, 'Save'),
        node('popup', 'div', 'body', ['option'], { role: 'listbox' }),
        node('option', 'div', 'popup', [], { role: 'option' }, 'Option'),
        node('utility', 'div', 'body', ['utility-input'], { class: 'dt-search' }),
        node('utility-input', 'input', 'utility', [], { type: 'search', 'aria-label': 'Search table' }),
        node('adjacent-a', 'div', 'body', ['adjacent-input-a']),
        node('adjacent-input-a', 'input', 'adjacent-a', [], { type: 'text', 'aria-label': 'Loose A' }),
        node('adjacent-b', 'div', 'body', ['adjacent-input-b']),
        node('adjacent-input-b', 'input', 'adjacent-b', [], { type: 'text', 'aria-label': 'Loose B' }),
        node('button-box', 'div', 'body', ['lonely-button']),
        node('lonely-button', 'button', 'button-box', [], {}, 'Only button'),
    ]);

    const forms = Object.values(snapshot.forms.forms);
    assert.equal(forms.length, 2);
    const explicit = forms.find((form) => form.location.structuralRootNodeId === snapshot.observation.captureIdToNodeId.form);
    const dialog = forms.find((form) => form.location.structuralRootNodeId === snapshot.observation.captureIdToNodeId.dialog);
    assert.ok(explicit);
    assert.ok(dialog);
    assert.equal(explicit.fields.length, 2, 'form attribute must attach the external control');
    assert.equal(dialog.fields.length, 2);
    assert.equal(forms.some((form) => form.location.structuralRootNodeId === snapshot.observation.captureIdToNodeId['button-box']), false);

    const popupControlIds = snapshot.controls.byNodeId[snapshot.observation.captureIdToNodeId.popup] ?? [];
    assert.equal(Object.values(snapshot.forms.fields).some((field) => field.controlIds.some((id) => popupControlIds.includes(id))), false);

    const residualControlNodeIds = snapshot.forms.residualFieldIds
        .map((fieldId) => snapshot.forms.fields[fieldId])
        .flatMap((field) => field?.controlIds ?? [])
        .map((controlId) => snapshot.controls.controls[controlId]?.controlNodeId);
    assert.equal(residualControlNodeIds.includes(snapshot.observation.captureIdToNodeId['utility-input']), true);
    assert.equal(residualControlNodeIds.includes(snapshot.observation.captureIdToNodeId['adjacent-input-a']), true);
    assert.equal(residualControlNodeIds.includes(snapshot.observation.captureIdToNodeId['adjacent-input-b']), true);
    assert.equal(snapshot.forms.reductionTrace.some((item) => item.reason === 'utility-or-table-standalone'), true);
    assert.equal(snapshot.forms.reductionTrace.some((item) => item.reason === 'utility-or-table-standalone'), true);
});

test('framework form-item evidence groups composite controls and preserves selection scope separately', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['card']),
        node('card', 'section', 'body', ['form'], { class: 'ant-card' }),
        node('form', 'form', 'card', ['item'], { class: 'ant-form' }),
        node('item', 'div', 'form', ['row'], { class: 'ant-form-item' }),
        node('row', 'div', 'item', ['label-wrap', 'control-wrap'], { class: 'ant-row ant-form-item-row' }),
        node('label-wrap', 'div', 'row', ['label'], { class: 'ant-form-item-label' }),
        node('label', 'label', 'label-wrap', [], {}, 'Range'),
        node('control-wrap', 'div', 'row', ['start', 'end'], { class: 'ant-form-item-control' }),
        node('start', 'input', 'control-wrap', [], { type: 'date' }),
        node('end', 'input', 'control-wrap', [], { type: 'date' }),
    ], 'card');

    const form = onlyForm(snapshot);
    assert.equal(form.location.selectionScopeNodeId, snapshot.observation.captureIdToNodeId.card);
    assert.equal(form.location.structuralRootNodeId, snapshot.observation.captureIdToNodeId.form);
    assert.equal(form.fields.length, 1);
    assert.equal(form.fields[0].controlIds.length, 2);
    assert.equal(form.fields[0].evidence.some((item) => item.code === 'form.field.adapter.ant-form-item' && item.source === 'adapter'), true);
});


test('bottom-up reducer forms a labelled local island but never splits fields inside an explicit form', () => {
    const local = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['panel']),
        node('panel', 'section', 'body', ['item-a', 'item-b', 'search']),
        node('item-a', 'div', 'panel', ['label-a', 'a'], { class: 'form-item' }),
        node('label-a', 'label', 'item-a', [], { for: 'LocalA' }, 'Local A'),
        node('a', 'input', 'item-a', [], { id: 'LocalA', type: 'text' }),
        node('item-b', 'div', 'panel', ['label-b', 'b'], { class: 'form-item' }),
        node('label-b', 'label', 'item-b', [], { for: 'LocalB' }, 'Local B'),
        node('b', 'input', 'item-b', [], { id: 'LocalB', type: 'text' }),
        node('search', 'button', 'panel', [], { type: 'button' }, 'Search'),
    ]);
    const localForm = onlyForm(local);
    assert.equal(localForm.boundaryKind, 'local-island');
    assert.equal(localForm.location.structuralRootNodeId, local.observation.captureIdToNodeId.panel);
    assert.equal(localForm.fields.length, 2);
    assert.equal(localForm.suggestions.some((item) => item.value === 'filter-form'), true);

    const explicit = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form']),
        node('form', 'form', 'body', ['panel']),
        node('panel', 'section', 'form', ['item-a', 'item-b', 'search']),
        node('item-a', 'div', 'panel', ['label-a', 'a'], { class: 'form-item' }),
        node('label-a', 'label', 'item-a', [], { for: 'ExplicitA' }, 'Explicit A'),
        node('a', 'input', 'item-a', [], { id: 'ExplicitA', type: 'text' }),
        node('item-b', 'div', 'panel', ['label-b', 'b'], { class: 'form-item' }),
        node('label-b', 'label', 'item-b', [], { for: 'ExplicitB' }, 'Explicit B'),
        node('b', 'input', 'item-b', [], { id: 'ExplicitB', type: 'text' }),
        node('search', 'button', 'panel', [], { type: 'button' }, 'Search'),
    ]);
    const explicitForm = onlyForm(explicit);
    assert.equal(explicitForm.boundaryKind, 'explicit-form');
    assert.equal(explicitForm.location.structuralRootNodeId, explicit.observation.captureIdToNodeId.form);
    assert.equal(explicitForm.fields.length, 2);
});

test('form invariant validator rejects duplicate field ownership and unknown controls', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form']),
        node('form', 'form', 'body', ['input']),
        node('input', 'input', 'form', [], { type: 'text', 'aria-label': 'Name' }),
    ]);
    const field = Object.values(snapshot.forms.fields)[0];
    assert.ok(field);
    const malformed = structuredClone(snapshot.forms);
    malformed.fields[field.id].controlIds.push('control:missing');
    malformed.ownership.edges.push({
        owner: { kind: 'form', id: Object.keys(malformed.forms)[0] },
        member: { kind: 'form-field', id: field.id },
        role: 'field',
        evidence: [],
    });
    const validation = validateFormComponentIndex(
        malformed,
        snapshot.observation,
        snapshot.controls,
    );
    assert.equal(validation.ok, false);
    assert.equal(validation.diagnostics.some((item) => item.code === 'form.field.control-missing'), true);
    assert.equal(validation.diagnostics.some((item) => item.code === 'ownership.role.duplicate'), true);
});

test('fieldset groups independent fields without collapsing them into one composite field', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form']),
        node('form', 'form', 'body', ['fieldset']),
        node('fieldset', 'fieldset', 'form', ['legend', 'name-label', 'name', 'email-label', 'email']),
        node('legend', 'legend', 'fieldset', [], {}, 'Identity'),
        node('name-label', 'label', 'fieldset', [], { for: 'Name' }, 'Name'),
        node('name', 'input', 'fieldset', [], { id: 'Name', type: 'text' }),
        node('email-label', 'label', 'fieldset', [], { for: 'Email' }, 'Email'),
        node('email', 'input', 'fieldset', [], { id: 'Email', type: 'email' }),
    ]);
    const form = onlyForm(snapshot);
    assert.equal(form.fields.length, 2);
    assert.deepEqual(form.fields.map((field) => field.controlIds.length), [1, 1]);
    assert.equal(form.groups.length, 1);
    assert.equal(form.groups[0].fieldIds.length, 2);
    assert.deepEqual(form.groups[0].labelNodeIds, [snapshot.observation.captureIdToNodeId.legend]);
    assert.deepEqual(
        form.fields.map((field) => field.labelNodeIds),
        [
            [snapshot.observation.captureIdToNodeId['name-label']],
            [snapshot.observation.captureIdToNodeId['email-label']],
        ],
    );
});

test('native submit inputs and external form-owned actions belong to the target form', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form', 'external-submit']),
        node('form', 'form', 'body', ['label', 'input', 'inline-submit'], { id: 'TargetForm' }),
        node('label', 'label', 'form', [], { for: 'Name' }, 'Name'),
        node('input', 'input', 'form', [], { id: 'Name', type: 'text' }),
        node('inline-submit', 'input', 'form', [], { type: 'submit', value: 'Save' }),
        node('external-submit', 'button', 'body', [], { type: 'submit', form: 'TargetForm' }, 'Save outside'),
    ]);
    const form = onlyForm(snapshot);
    assert.equal(form.fields.length, 1);
    assert.equal(form.actions.length, 2);
    assert.deepEqual(form.actions.map((action) => action.structuralRole), ['submit', 'submit']);
    assert.equal(snapshot.forms.residualActionIds.length, 0);
});

test('ambiguous form attributes surface a form-level ownership diagnostic', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form-a', 'form-b', 'external']),
        node('form-a', 'form', 'body', [], { id: 'DuplicateForm' }),
        node('form-b', 'form', 'body', [], { id: 'DuplicateForm' }),
        node('external', 'input', 'body', [], { type: 'text', form: 'DuplicateForm', 'aria-label': 'External' }),
    ]);
    assert.equal(snapshot.forms.diagnostics.some((item) => item.code === 'form.owner.ambiguous'), true);
    assert.equal(snapshot.forms.residualFieldIds.length, 1);
});
