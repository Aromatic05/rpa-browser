import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    buildTableSnapshot,
    compileEntityRuleQueryPlan,
    executeEntityRuleQueryPlan,
    type RawCapturedNode,
    type RawPageCapture,
} from '../../../src/snapshot';
import type { EntityRuleMatchRecord } from '../../../src/workflow';

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

const capture = (pageEpoch: string, nodes: RawCapturedNode[]): RawPageCapture => {
    const completeness = { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' } as const;
    return {
        identity: { pageEpoch, captureRevision: 1 },
        metadata: { schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-29T00:00:00.000Z' },
        completeness,
        scopes: [{ id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness }],
        nodes,
        accessibility: [],
        runtimeState: {},
        diagnostics: [],
    };
};

const buildBase = (raw: RawPageCapture) => {
    const observation = buildPageObservation(raw);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const controls = buildControlSnapshot({ observation, relations, locators }).controls;
    return { observation, relations, locators, controls };
};

const formSnapshot = () => buildFormSnapshot(buildBase(capture('query-plan-form', [
    node('html', 'html', undefined, ['body']),
    node('body', 'body', 'html', ['form-a', 'form-b']),
    node('form-a', 'form', 'body', ['label-a', 'input-a', 'save-a'], { id: 'FormA', 'aria-label': 'Order form' }),
    node('label-a', 'label', 'form-a', [], { for: 'Buyer' }, 'Buyer'),
    node('input-a', 'input', 'form-a', [], { id: 'Buyer', name: 'BuyerCode', type: 'text' }),
    node('save-a', 'button', 'form-a', [], { type: 'submit' }, 'Save'),
    node('form-b', 'form', 'body', ['label-b', 'input-b'], { id: 'FormB', 'aria-label': 'Order form' }),
    node('label-b', 'label', 'form-b', [], { for: 'Seller' }, 'Seller'),
    node('input-b', 'input', 'form-b', [], { id: 'Seller', type: 'text' }),
])));

const tableSnapshot = () => buildTableSnapshot(buildBase(capture('query-plan-table', [
    node('html', 'html', undefined, ['body']),
    node('body', 'body', 'html', ['card']),
    node('card', 'section', 'body', ['table', 'pager']),
    node('table', 'table', 'card', ['thead', 'tbody'], { id: 'Orders', 'aria-label': 'Orders' }),
    node('thead', 'thead', 'table', ['header-row']),
    node('header-row', 'tr', 'thead', ['name-header']),
    node('name-header', 'th', 'header-row', [], {}, 'Name'),
    node('tbody', 'tbody', 'table', ['row-a', 'row-b']),
    node('row-a', 'tr', 'tbody', ['cell-a']),
    node('cell-a', 'td', 'row-a', [], {}, 'Alice'),
    node('row-b', 'tr', 'tbody', ['cell-b']),
    node('cell-b', 'td', 'row-b', [], {}, 'Bob'),
    node('pager', 'nav', 'card', ['next'], { class: 'ant-pagination', 'aria-label': 'pagination' }),
    node('next', 'button', 'pager', [], { class: 'ant-pagination-next' }, 'Next'),
])));

const compile = (profileName: string, rules: EntityRuleMatchRecord[]) => {
    const result = compileEntityRuleQueryPlan({ profileName, rules });
    assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2));
    if (!result.ok) {throw new Error('query plan compilation failed');}
    return result.plan;
};

test('one compiled form QueryPlan preserves forward dependencies across check save and runtime', () => {
    const plan = compile('orders-form', [
        { ruleId: 'buyer', source: 'node', expect: 'unique', within: 'form', match: { idEquals: 'Buyer' } },
        { ruleId: 'form', source: 'region', expect: 'unique', match: { kind: 'form', idEquals: 'FormA' } },
    ]);
    assert.deepEqual(plan.steps.map((step) => step.ruleId), ['form', 'buyer']);
    const snapshot = formSnapshot();
    const check = executeEntityRuleQueryPlan(plan, { form: snapshot }, { purpose: 'check' });
    const save = executeEntityRuleQueryPlan(plan, { form: snapshot }, { purpose: 'save' });
    const runtime = executeEntityRuleQueryPlan(plan, { form: snapshot }, { purpose: 'runtime' });

    assert.deepEqual(check.byRuleId, save.byRuleId);
    assert.deepEqual(save.byRuleId, runtime.byRuleId);
    assert.equal(runtime.ok, true);
    assert.equal(runtime.byRuleId.form.planStepId, 'orders-form:form');
    assert.equal(runtime.byRuleId.form.matchedComponentIds.length, 1);
    assert.equal(runtime.byRuleId.form.matchedFieldIds.length, 1);
    assert.deepEqual(runtime.byRuleId.buyer.matchedNodeIds, [snapshot.observation.captureIdToNodeId['input-a']]);
});

test('QueryPlan table execution returns canonical table targets and typed pagination nodes', () => {
    const plan = compile('orders-table', [
        {
            ruleId: 'table',
            source: 'region',
            expect: 'unique',
            match: { kind: 'table', idEquals: 'Orders', keyHint: { headerContainsAll: ['Name'] } },
        },
        {
            ruleId: 'next',
            source: 'node',
            expect: 'unique',
            within: 'table',
            match: { relation: 'pagination', classContains: 'ant-pagination-next' },
        },
    ]);
    const snapshot = tableSnapshot();
    const result = executeEntityRuleQueryPlan(plan, { table: snapshot }, { purpose: 'runtime' });

    assert.equal(result.ok, true);
    assert.equal(result.byRuleId.table.matchedComponentIds.length, 1);
    assert.equal(result.byRuleId.table.matchedRowIds.length, 2);
    assert.equal(result.byRuleId.table.matchedColumnIds.length, 1);
    assert.deepEqual(result.byRuleId.next.matchedNodeIds, [snapshot.observation.captureIdToNodeId.next]);
});

test('QueryPlan cardinality diagnostics identify the exact plan step and canonical component targets', () => {
    const plan = compile('ambiguous-form', [
        { ruleId: 'form', source: 'region', expect: 'unique', match: { kind: 'form', nameContains: 'Order form' } },
    ]);
    const result = executeEntityRuleQueryPlan(plan, { form: formSnapshot() }, { purpose: 'check' });
    const diagnostic = result.diagnostics.find((item) => item.code === 'query-plan.cardinality.multiple');

    assert.equal(result.ok, false);
    assert.equal(result.byRuleId.form.cardinality.status, 'multiple');
    assert.equal(result.byRuleId.form.matchedComponentIds.length, 2);
    assert.equal(diagnostic?.planStepId, 'ambiguous-form:form');
    assert.equal(diagnostic?.targetKind, 'form-component');
    assert.equal(diagnostic?.nodeIds.length, 2);
});

test('QueryPlan compiler rejects mixed domains and unsupported conditions before execution', () => {
    const result = compileEntityRuleQueryPlan({
        profileName: 'invalid',
        rules: [
            { ruleId: 'form', source: 'region', expect: 'unique', match: { kind: 'form' } },
            { ruleId: 'table', source: 'region', expect: 'unique', match: { kind: 'table' } },
            { ruleId: 'unknown', source: 'node', expect: 'unique', match: { unknownCondition: true } },
        ],
    });

    assert.equal(result.ok, false);
    if (result.ok) {throw new Error('invalid query plan unexpectedly compiled');}
    assert.equal(result.diagnostics.some((item) => item.code === 'query-plan.domain.mixed'), true);
    assert.equal(result.diagnostics.some((item) => item.code === 'query-plan.match.unsupported'), true);
});
