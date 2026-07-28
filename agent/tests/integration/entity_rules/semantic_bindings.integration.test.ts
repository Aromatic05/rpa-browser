import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    buildSemanticLayer,
    compileEntityRuleQueryPlan,
    executeEntityRuleQueryPlan,
    mergeSemanticBindings,
    type EntityRuleQueryBinding,
    type EntityRuleQueryExecutionResult,
    type RawCapturedNode,
    type RawPageCapture,
    type SemanticAnnotationRecord,
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

const formSnapshot = () => {
    const completeness = { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' } as const;
    const raw: RawPageCapture = {
        identity: { pageEpoch: 'semantic-form', captureRevision: 1 },
        metadata: { schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-29T00:00:00.000Z' },
        completeness,
        scopes: [{ id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness }],
        nodes: [
            node('html', 'html', undefined, ['body']),
            node('body', 'body', 'html', ['form']),
            node('form', 'form', 'body', ['label', 'input', 'submit'], { id: 'OrderForm', 'aria-label': 'Order form' }),
            node('label', 'label', 'form', [], { for: 'Buyer' }, 'Buyer'),
            node('input', 'input', 'form', [], { id: 'Buyer', type: 'text' }),
            node('submit', 'button', 'form', [], { id: 'Submit', type: 'submit' }, 'Save'),
        ],
        accessibility: [],
        runtimeState: {},
        diagnostics: [],
    };
    const observation = buildPageObservation(raw);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const controls = buildControlSnapshot({ observation, relations, locators }).controls;
    return buildFormSnapshot({ observation, relations, locators, controls });
};

const queryBinding = (
    profileName: string,
    ruleId: string,
    nodeIds: string[],
    componentIds: string[] = [],
    ok = true,
): EntityRuleQueryBinding => ({
    planStepId: `${profileName}:${ruleId}`,
    ruleId,
    domain: 'form',
    source: componentIds.length > 0 ? 'region' : 'node',
    expect: 'unique',
    targetKind: componentIds.length > 0 ? 'form-component' : 'node',
    matchedComponentIds: componentIds,
    matchedNodeIds: nodeIds,
    matchedFieldIds: [],
    matchedActionIds: [],
    matchedRowIds: [],
    matchedColumnIds: [],
    cardinality: { expected: 'unique', actual: ok ? 1 : 0, status: ok ? 'satisfied' : 'missing' },
    ok,
});

const execution = (
    profileName: string,
    bindings: EntityRuleQueryBinding[],
): EntityRuleQueryExecutionResult => ({
    planId: profileName,
    profileName,
    domain: 'form',
    purpose: 'runtime',
    byRuleId: Object.fromEntries(bindings.map((binding) => [binding.ruleId, binding])),
    diagnostics: [],
    ok: bindings.every((binding) => binding.ok),
});

test('SemanticBindings keep confirmed annotations separate from inferred component suggestions', () => {
    const snapshot = formSnapshot();
    const compiled = compileEntityRuleQueryPlan({
        profileName: 'orders',
        rules: [
            { ruleId: 'form', source: 'region', expect: 'unique', match: { kind: 'form', idEquals: 'OrderForm' } },
            { ruleId: 'submit', source: 'node', expect: 'unique', within: 'form', match: { idEquals: 'Submit' } },
            { ruleId: 'buyer', source: 'node', expect: 'unique', within: 'form', match: { idEquals: 'Buyer' } },
        ],
    });
    assert.equal(compiled.ok, true);
    if (!compiled.ok) {throw new Error('query plan compilation failed');}
    const query = executeEntityRuleQueryPlan(compiled.plan, { form: snapshot }, { purpose: 'runtime' });
    const layer = buildSemanticLayer({
        execution: query,
        annotations: [
            { ruleId: 'form', businessTag: 'order.form' },
            { ruleId: 'submit', actionIntent: 'submit' },
            { ruleId: 'buyer', origin: 'inferred', fieldKey: 'buyer' },
        ],
        snapshots: { form: snapshot },
    });

    const formBinding = layer.bindings.byId['orders:form'];
    const submitBinding = layer.bindings.byId['orders:submit'];
    const buyerBinding = layer.bindings.byId['orders:buyer'];
    const formId = query.byRuleId.form.matchedComponentIds[0];
    const submitNodeId = query.byRuleId.submit.matchedNodeIds[0];
    assert.equal(formBinding.origin, 'confirmed');
    assert.equal(formBinding.status, 'active');
    assert.equal(layer.bindings.forms[formId]?.id, formBinding.id);
    assert.equal(submitBinding.annotation.actionIntent, 'submit');
    assert.equal(layer.bindings.nodes[submitNodeId]?.some((binding) => binding.id === submitBinding.id), true);
    assert.equal(buyerBinding.status, 'invalidated');
    assert.equal(layer.bindings.diagnostics.some((item) => item.code === 'semantic-binding.inferred.protected-key'), true);
    assert.equal(layer.suggestions.items.some((item) => item.kind === 'action-intent' && item.source === 'inferred'), true);
    assert.equal(layer.suggestions.items.every((item) => !Object.prototype.hasOwnProperty.call(item, 'actionIntent')), true);
});

test('protective merge preserves confirmed and manual targets, refreshes inferred, and keeps ignored unindexed', () => {
    const profileName = 'lifecycle';
    const existingAnnotations: SemanticAnnotationRecord[] = [
        { ruleId: 'confirmed', origin: 'confirmed', businessTag: 'confirmed', primaryKey: {fieldKey: 'id'} },
        { ruleId: 'manual', origin: 'manual', actionIntent: 'manual-action' },
        { ruleId: 'ignored', origin: 'confirmed', disposition: 'ignored', fieldKey: 'ignored-field' },
        { ruleId: 'inferred', origin: 'inferred', businessTag: 'inferred' },
    ];
    const existing = buildSemanticLayer({
        execution: execution(profileName, [
            queryBinding(profileName, 'confirmed', ['node-old-confirmed']),
            queryBinding(profileName, 'manual', ['node-old-manual']),
            queryBinding(profileName, 'ignored', ['node-old-ignored']),
            queryBinding(profileName, 'inferred', ['node-old-inferred']),
        ]),
        annotations: existingAnnotations,
        snapshots: {},
    }).bindings;
    const fresh = buildSemanticLayer({
        execution: execution(profileName, [
            queryBinding(profileName, 'confirmed', ['node-new-confirmed']),
            queryBinding(profileName, 'ignored', ['node-new-ignored']),
            queryBinding(profileName, 'inferred', ['node-new-inferred']),
        ]),
        annotations: existingAnnotations.filter((item) => item.ruleId !== 'manual'),
        snapshots: {},
    }).bindings;

    const merged = mergeSemanticBindings(existing, fresh);
    assert.equal(merged.bindings.byId['lifecycle:confirmed'].status, 'invalidated');
    assert.deepEqual(merged.bindings.byId['lifecycle:confirmed'].target.nodeIds, ['node-old-confirmed']);
    assert.equal(merged.bindings.byId['lifecycle:manual'].status, 'invalidated');
    assert.deepEqual(merged.bindings.byId['lifecycle:manual'].target.nodeIds, ['node-old-manual']);
    assert.equal(merged.bindings.byId['lifecycle:ignored'].status, 'active');
    assert.deepEqual(merged.bindings.byId['lifecycle:ignored'].target.nodeIds, ['node-old-ignored']);
    assert.equal(merged.bindings.nodes['node-old-ignored'], undefined);
    assert.equal(merged.bindings.byId['lifecycle:inferred'].status, 'active');
    assert.deepEqual(merged.bindings.byId['lifecycle:inferred'].target.nodeIds, ['node-new-inferred']);
    assert.equal(merged.stats.invalidated, 2);
    assert.equal(merged.stats.refreshed, 1);
    assert.equal(merged.bindings.diagnostics.filter((item) => item.code === 'semantic-binding.target.invalidated').length, 2);
    assert.notEqual(
        merged.bindings.byId['lifecycle:confirmed'].annotation.primaryKey,
        existing.byId['lifecycle:confirmed'].annotation.primaryKey,
    );
});
