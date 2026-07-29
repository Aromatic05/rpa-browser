import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    buildSemanticLayer,
    buildTableSnapshot,
    type EntityRuleProfileMatchResult,
    type EntityRuleQueryBinding,
    type EntityRuleQueryExecutionResult,
    type EntityRulesExecutionResult,
    type PageSnapshotCapture,
    type RawCapturedNode,
    type RawPageCapture,
    type SemanticAnnotationRecord,
} from '../../src/snapshot';

const active = () => ({hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true});

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
    backendNodeId: captureId,
    activity: active(),
});

const profileResult = (
    profileName: string,
    domain: 'form' | 'table',
    binding: EntityRuleQueryBinding,
    annotation: SemanticAnnotationRecord,
    capture: Pick<PageSnapshotCapture, 'form' | 'table'>,
): EntityRuleProfileMatchResult => {
    const execution: EntityRuleQueryExecutionResult = {
        planId: profileName,
        profileName,
        domain,
        purpose: 'runtime',
        byRuleId: {[binding.ruleId]: binding},
        diagnostics: [],
        ok: true,
    };
    const semantics = buildSemanticLayer({
        execution,
        annotations: [annotation],
        snapshots: domain === 'form' ? {form: capture.form} : {table: capture.table},
    });
    return {
        profileName,
        domain,
        bindings: {},
        semanticBindings: semantics.bindings,
        semanticSuggestions: semantics.suggestions,
        diagnostics: semantics.bindings.diagnostics,
        ok: true,
    };
};

export const createV2BusinessPage = (): {
    capture: PageSnapshotCapture;
    nodeIds: Record<string, string>;
} => {
    const completeness = {dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete'} as const;
    const raw: RawPageCapture = {
        identity: {pageEpoch: 'v2-business', captureRevision: 1},
        metadata: {schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-29T00:00:00.000Z'},
        completeness,
        scopes: [{id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness}],
        nodes: [
            node('html', 'html', undefined, ['body']),
            node('body', 'body', 'html', ['orders-table', 'orders-form', 'panel']),
            node('orders-table', 'table', 'body', ['thead', 'tbody'], {id: 'OrdersTable'}),
            node('thead', 'thead', 'orders-table', ['header-row']),
            node('header-row', 'tr', 'thead', ['header-order', 'header-operation']),
            node('header-order', 'th', 'header-row', [], {}, '订单编号'),
            node('header-operation', 'th', 'header-row', [], {}, '操作'),
            node('tbody', 'tbody', 'orders-table', ['row-1']),
            node('row-1', 'tr', 'tbody', ['cell-order', 'cell-operation'], {'data-row-key': 'SO-001'}),
            node('cell-order', 'td', 'row-1', [], {}, 'SO-001'),
            node('cell-operation', 'td', 'row-1', ['approve']),
            node('approve', 'button', 'cell-operation', [], {id: 'Approve'}, '审核'),
            node('orders-form', 'form', 'body', ['buyer-label', 'buyer', 'submit'], {id: 'OrdersForm'}),
            node('buyer-label', 'label', 'orders-form', [], {for: 'Buyer'}, '订单编号'),
            node('buyer', 'input', 'orders-form', [], {id: 'Buyer', name: 'orderNo'}),
            node('submit', 'button', 'orders-form', [], {id: 'Submit', type: 'submit'}, '提交'),
            node('panel', 'section', 'body', [], {id: 'Panel'}, '辅助面板'),
        ],
        accessibility: [],
        runtimeState: {},
        diagnostics: [],
    };
    const observation = buildPageObservation(raw);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const control = buildControlSnapshot({observation, relations, locators});
    const form = buildFormSnapshot({observation, relations, locators, controls: control.controls});
    const table = buildTableSnapshot({observation, relations, locators, controls: control.controls});
    const tableComponent = Object.values(table.tables.tables)[0];
    const formComponent = Object.values(form.forms.forms)[0];
    if (!tableComponent || !formComponent) {throw new Error('V2 business fixture did not assemble components');}

    const tableBinding: EntityRuleQueryBinding = {
        planStepId: 'orders-table:root',
        ruleId: 'root',
        domain: 'table',
        source: 'region',
        expect: 'unique',
        targetKind: 'table-component',
        matchedComponentIds: [tableComponent.id],
        matchedNodeIds: [tableComponent.location.structuralRootNodeId],
        matchedFieldIds: [],
        matchedActionIds: [],
        matchedRowIds: [],
        matchedColumnIds: [],
        cardinality: {expected: 'unique', actual: 1, status: 'satisfied'},
        ok: true,
    };
    const formBinding: EntityRuleQueryBinding = {
        planStepId: 'orders-form:root',
        ruleId: 'root',
        domain: 'form',
        source: 'region',
        expect: 'unique',
        targetKind: 'form-component',
        matchedComponentIds: [formComponent.id],
        matchedNodeIds: [formComponent.location.structuralRootNodeId],
        matchedFieldIds: [],
        matchedActionIds: [],
        matchedRowIds: [],
        matchedColumnIds: [],
        cardinality: {expected: 'unique', actual: 1, status: 'satisfied'},
        ok: true,
    };

    const baseCapture = {control, form, table};
    const entityRules: EntityRulesExecutionResult = {
        status: 'ready',
        selection: 'explicit',
        selectedProfiles: ['orders-table', 'orders-form'],
        strict: true,
        profiles: {
            'orders-table': profileResult('orders-table', 'table', tableBinding, {
                ruleId: 'root',
                origin: 'confirmed',
                businessTag: 'order.table.main',
                primaryKey: {fieldKey: 'orderNo', columns: ['订单编号'], source: 'annotation'},
                columns: [
                    {fieldKey: 'orderNo', name: '订单编号', kind: 'text'},
                    {fieldKey: 'operation', name: '操作', kind: 'action_column', actions: [{actionIntent: 'approve', text: '审核'}]},
                ],
            }, baseCapture),
            'orders-form': profileResult('orders-form', 'form', formBinding, {
                ruleId: 'root',
                origin: 'confirmed',
                businessTag: 'order.form.main',
                formFields: [{fieldKey: 'orderNo', kind: 'input', controlNodeId: observation.captureIdToNodeId.buyer}],
                formActions: [{actionIntent: 'submit', nodeId: observation.captureIdToNodeId.submit}],
            }, baseCapture),
        },
        diagnostics: [],
        ok: true,
    };

    return {
        capture: {...baseCapture, entityRules},
        nodeIds: Object.fromEntries(Object.entries(observation.captureIdToNodeId)),
    };
};
