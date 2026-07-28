import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    matchFormComponentRules,
    type FormComponentMatchRule,
    type RawCapturedNode,
    type RawPageCapture,
} from '../../../src/snapshot';

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
    activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
});

const build = () => {
    const nodes = [
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['a', 'b']),
        node('a', 'form', 'body', ['a-label', 'a-input', 'a-submit'], { id: 'FormA', 'aria-label': 'Order form' }),
        node('a-label', 'label', 'a', [], { for: 'Buyer' }, 'Buyer'),
        node('a-input', 'input', 'a', [], { id: 'Buyer', name: 'BuyerCode', type: 'text' }),
        node('a-submit', 'button', 'a', [], { type: 'submit' }, 'Save A'),
        node('b', 'form', 'body', ['b-label', 'b-input', 'b-submit'], { id: 'FormB', 'aria-label': 'Order form' }),
        node('b-label', 'label', 'b', [], { for: 'Seller' }, 'Seller'),
        node('b-input', 'input', 'b', [], { id: 'Seller', name: 'SellerCode', type: 'text' }),
        node('b-submit', 'button', 'b', [], { type: 'submit' }, 'Save B'),
    ];
    const completeness = { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' } as const;
    const raw: RawPageCapture = {
        identity: { pageEpoch: 'bridge', captureRevision: 1 },
        metadata: { schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-28T00:00:00.000Z' },
        completeness,
        scopes: [{ id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness }],
        nodes,
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

test('form bridge preserves unique and one_or_more cardinality using only components and canonical nodes', () => {
    const snapshot = build();
    const rules: FormComponentMatchRule[] = [
        {
            ruleId: 'all-forms',
            source: 'region',
            expect: 'one_or_more',
            match: { kind: 'form', nameContains: 'Order form' },
        },
        {
            ruleId: 'form-a',
            source: 'group',
            expect: 'unique',
            match: { kind: 'form', idEquals: 'FormA' },
        },
        {
            ruleId: 'buyer',
            source: 'node',
            expect: 'unique',
            within: 'form-a',
            match: { idEquals: 'Buyer', nameEquals: 'BuyerCode' },
        },
    ];
    const result = matchFormComponentRules(snapshot, rules);
    assert.equal(result.byRuleId['all-forms'].ok, true);
    assert.equal(result.byRuleId['all-forms'].matchedComponentIds.length, 2);
    assert.equal(result.byRuleId['form-a'].ok, true);
    assert.equal(result.byRuleId['form-a'].matchedComponentIds.length, 1);
    assert.equal(result.byRuleId.buyer.ok, true);
    assert.deepEqual(result.byRuleId.buyer.matchedNodeIds, [snapshot.observation.captureIdToNodeId['a-input']]);
    assert.equal(result.diagnostics.length, 0);
});

test('form bridge reports structural ambiguity at components and does not invent business semantics', () => {
    const snapshot = build();
    const result = matchFormComponentRules(snapshot, [{
        ruleId: 'ambiguous-form',
        source: 'region',
        expect: 'unique',
        match: { kind: 'form', nameContains: 'Order form' },
    }]);
    const binding = result.byRuleId['ambiguous-form'];
    assert.equal(binding.ok, false);
    assert.equal(binding.matchedComponentIds.length, 2);
    assert.equal(result.diagnostics.some((item) => item.code === 'form.bridge.cardinality.multiple'), true);
    for (const form of Object.values(snapshot.forms.forms)) {
        assert.equal(Object.prototype.hasOwnProperty.call(form, 'businessTag'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(form, 'fieldKey'), false);
    }
});

test('node within scopes include descendants and component bindings expose member fields and actions', () => {
    const snapshot = build();
    const result = matchFormComponentRules(snapshot, [
        { ruleId: 'scope-node', source: 'node', expect: 'unique', match: { idEquals: 'FormA' } },
        { ruleId: 'child-node', source: 'node', expect: 'unique', within: 'scope-node', match: { idEquals: 'Buyer' } },
        { ruleId: 'form-a-members', source: 'region', expect: 'unique', match: { kind: 'form', idEquals: 'FormA' } },
    ]);
    assert.equal(result.byRuleId['scope-node'].ok, true);
    assert.equal(result.byRuleId['child-node'].ok, true);
    assert.deepEqual(result.byRuleId['child-node'].matchedNodeIds, [snapshot.observation.captureIdToNodeId['a-input']]);
    assert.equal(result.byRuleId['form-a-members'].matchedFieldIds.length, 1);
    assert.equal(result.byRuleId['form-a-members'].matchedActionIds.length, 1);
});

test('form bridge excludes hidden canonical nodes from cardinality', () => {
    const completeness = { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' } as const;
    const raw: RawPageCapture = {
        identity: { pageEpoch: 'bridge-hidden', captureRevision: 1 },
        metadata: { schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-28T00:00:00.000Z' },
        completeness,
        scopes: [{ id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness }],
        nodes: [
            node('html', 'html', undefined, ['body']),
            node('body', 'body', 'html', ['visible', 'hidden']),
            node('visible', 'input', 'body', [], { role: 'textbox' }),
            { ...node('hidden', 'input', 'body', [], { role: 'textbox' }), activity: { hiddenByStyle: true, inert: false, selfHasBox: false, rendered: false } },
        ],
        accessibility: [], runtimeState: {}, diagnostics: [],
    };
    const observation = buildPageObservation(raw);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const controls = buildControlSnapshot({ observation, relations, locators }).controls;
    const snapshot = buildFormSnapshot({ observation, relations, locators, controls });
    const result = matchFormComponentRules(snapshot, [{
        ruleId: 'visible-copy', source: 'node', expect: 'unique', match: { roleEquals: 'textbox' },
    }]);
    assert.equal(result.byRuleId['visible-copy'].ok, true);
    assert.deepEqual(result.byRuleId['visible-copy'].matchedNodeIds, [observation.captureIdToNodeId.visible]);
});
