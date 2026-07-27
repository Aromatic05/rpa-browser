import test from 'node:test';
import assert from 'node:assert/strict';
import {
    setNodeAttr,
    setNodeBbox,
} from '../../../../src/runner/steps/executors/snapshot/core/runtime_store';
import { buildExternalIndexes } from '../../../../src/runner/steps/executors/snapshot/indexes/external_indexes';
import { buildSnapshot } from '../../../../src/runner/steps/executors/snapshot/pipeline/build_snapshot';
import { buildFinalEntityViewFromSnapshot } from '../../../../src/runner/steps/executors/snapshot/core/overlay';
import { applyBusinessEntityRules } from '../../../../src/runner/steps/executors/snapshot/entity_rules/apply';
import type {
    EntityIndex,
    FinalEntityView,
    SnapshotResult,
    UnifiedNode,
    SnapshotPageIdentity,
} from '../../../../src/runner/steps/executors/snapshot/core/types';
import type { NormalizedEntityRuleBundle } from '../../../../src/runner/steps/executors/snapshot/entity_rules/types';
import { createWorkspaceEntityRulesRuntime } from '../../../../src/entity_rules/runtime';
import { loadEntityRuleArtifact } from '../profile_fixture';
import { toEntityRuleBundle } from '../../../../src/workflow/entity_rules';
import type { Workflow, WorkflowEntityRules, WorkflowDummy } from '../../../../src/workflow';
import type { WorkflowCatalogItem } from '../../../../src/workflow/workflow';
import {
    resolveClickedNode,
    buildCandidateChain,
    isStableClassToken,
    pickFromFingerprint,
} from '../../../../src/entity_rules/annotator/picking';
import { recognizeEntities } from '../../../../src/entity_rules/annotator/recognize';
import { importEntityRulesToCanvasDraft } from '../../../../src/entity_rules/annotator/import';
import { compileCanvasDraft } from '../../../../src/entity_rules/annotator/compile';
import { validateEntityRules } from '../../../../src/runner/steps/executors/snapshot/entity_rules/validate';
import {
    buildOpenResult,
    runCheck,
    detectStale,
} from '../../../../src/entity_rules/annotator/pipeline';
import { executeSave } from '../../../../src/entity_rules/annotator/actions';
import {
    computeArtifactRevision,
    isRevisionConflict,
} from '../../../../src/entity_rules/annotator/revision';
import type { CanvasDraft } from '../../../../src/entity_rules/annotator/types';
import type { PickFingerprint } from '../../../../src/entity_rules/annotator/runtime_types';
import type { WorkspaceEntityRulesProvider } from '../../../../src/entity_rules/provider';

const newTextNode = (id: string, role: string, name: string): UnifiedNode => ({
    id,
    role,
    name,
    children: [],
});

type TableFixture = {
    snapshot: SnapshotResult;
    finalEntityView: FinalEntityView;
    editButtonIds: string[];
    deleteButtonIds: string[];
};

const createTableFixture = (): TableFixture => {
    const editButtons: UnifiedNode[] = [];
    const rows: UnifiedNode[] = [];
    const editIds: string[] = [];
    const deleteIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
        const editId = `edit_btn_${i}`;
        editIds.push(editId);
        const edit = newTextNode(editId, 'button', '编辑');
        setNodeAttr(edit, 'class', 'ant-btn ant-btn-link');
        setNodeAttr(edit, 'tag', 'button');
        setNodeBbox(edit, { x: 10, y: 10 + i * 30, width: 40, height: 20 });
        editButtons.push(edit);
        const delId = `del_btn_${i}`;
        deleteIds.push(delId);
        const del = newTextNode(delId, 'button', '删除');
        setNodeAttr(del, 'class', 'ant-btn ant-btn-link');
        setNodeAttr(del, 'tag', 'button');
        setNodeBbox(del, { x: 60, y: 10 + i * 30, width: 40, height: 20 });
        const orderCell = newTextNode(`cell_order_${i}`, 'cell', `ORD-${i}`);
        setNodeBbox(orderCell, { x: 0, y: 0 + i * 30, width: 100, height: 25 });
        const actionCell: UnifiedNode = { id: `cell_action_${i}`, role: 'cell', children: [edit, del] };
        setNodeAttr(actionCell, 'tag', 'td');
        setNodeBbox(actionCell, { x: 100, y: 0 + i * 30, width: 100, height: 25 });
        const row: UnifiedNode = { id: `row_${i}`, role: 'row', children: [orderCell, actionCell] };
        setNodeAttr(row, 'tag', 'tr');
        rows.push(row);
    }
    const headerOrder = newTextNode('header_order', 'columnheader', '订单编号');
    const headerAction = newTextNode('header_action', 'columnheader', '操作');
    const headerRow: UnifiedNode = {
        id: 'header_row',
        role: 'row',
        children: [headerOrder, headerAction],
    };

    const tableChildren = [headerRow, ...rows];
    const table: UnifiedNode = {
        id: 'table_main',
        role: 'table',
        name: '订单列表',
        children: tableChildren,
    };
    setNodeAttr(table, 'class', 'ant-table');
    setNodeBbox(table, { x: 0, y: 0, width: 200, height: 200 });
    const root: UnifiedNode = { id: 'root', role: 'root', children: [table] };

    const entityIndex: EntityIndex = {
        entities: {
            ent_table: {
                id: 'ent_table',
                type: 'region',
                kind: 'table',
                nodeId: 'table_main',
                name: '订单列表',
            },
        },
        byNodeId: {},
    };
    entityIndex.byNodeId['table_main'] = [
        { type: 'region', entityId: 'ent_table', role: 'container' },
    ];
    for (const id of editIds) {
        entityIndex.byNodeId[id] = [{ type: 'region', entityId: 'ent_table', role: 'descendant' }];
    }
    for (const id of deleteIds) {
        entityIndex.byNodeId[id] = [{ type: 'region', entityId: 'ent_table', role: 'descendant' }];
    }

    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    const bundle: NormalizedEntityRuleBundle = {
        id: 'orders',
        page: { kind: 'table' },
        matchRules: [
            {
                ruleId: 'order_list_main',
                source: 'region',
                expect: 'unique',
                order: 0,
                match: { kind: 'table', nameContains: '订单列表' },
            },
            {
                ruleId: 'order_action_edit',
                source: 'node',
                expect: 'one_or_more',
                order: 1,
                within: 'order_list_main',
                match: { classContains: 'ant-btn', textContains: '编辑' },
            },
        ],
        annotationByRuleId: {
            order_list_main: {
                ruleId: 'order_list_main',
                businessTag: 'order.list.main',
                businessName: '订单主列表',
                columns: [
                    { fieldKey: 'orderNo', name: '订单编号', source: 'annotation' },
                    {
                        fieldKey: 'actions',
                        name: '操作',
                        kind: 'action_column',
                        source: 'annotation',
                        actions: [{ actionIntent: 'edit', text: '编辑' }],
                    },
                ],
            },
        },
    };
    const overlay = applyBusinessEntityRules({ root, entityIndex, bundle });
    const snapshot = buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex: {},
        bboxIndex,
        attrIndex,
        contentStore,
        ruleEntityOverlay: overlay,
    });
    const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
        renamedNodes: {},
        addedEntities: [],
        deletedEntities: [],
    });
    return { snapshot, finalEntityView, editButtonIds: editIds, deleteButtonIds: deleteIds };
};

test('resolveClickedNode resolves by smallest-area bbox and cross-validates tag', () => {
    const { snapshot } = createTableFixture();
    const fingerprint: PickFingerprint = {
        point: { x: 20, y: 15 },
        selectorCandidates: [],
        role: 'button',
        text: '编辑',
        tagName: 'button',
        classTokens: ['ant-btn', 'ant-btn-link'],
        rect: { x: 10, y: 10, width: 40, height: 20 },
        ancestors: [],
    };
    const resolution = resolveClickedNode(snapshot, fingerprint);
    assert.equal(resolution.nodeId, 'edit_btn_0');
    assert.equal(resolution.reason, 'bbox');
});

test('resolveClickedNode falls back to tag+class+text when point misses every bbox', () => {
    const { snapshot } = createTableFixture();
    const fingerprint: PickFingerprint = {
        point: { x: 9999, y: 9999 },
        selectorCandidates: [],
        tagName: 'button',
        classTokens: ['ant-btn'],
        text: '编辑',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        ancestors: [],
    };
    const resolution = resolveClickedNode(snapshot, fingerprint);
    assert.equal(resolution.reason, 'fallback');
    assert.equal(snapshot.nodeIndex[resolution.nodeId || '']?.role, 'button');
});

test('resolveClickedNode returns none when nothing matches', () => {
    const { snapshot } = createTableFixture();
    const fingerprint: PickFingerprint = {
        point: { x: 9999, y: 9999 },
        selectorCandidates: [],
        tagName: 'marquee',
        classTokens: ['does-not-exist'],
        rect: { x: 0, y: 0, width: 0, height: 0 },
        ancestors: [],
    };
    const resolution = resolveClickedNode(snapshot, fingerprint);
    assert.equal(resolution.nodeId, null);
    assert.equal(resolution.reason, 'none');
});

test('buildCandidateChain produces control/cell/row/region levels and filters noise', () => {
    const { snapshot, finalEntityView, editButtonIds } = createTableFixture();
    const chain = buildCandidateChain(snapshot, finalEntityView, editButtonIds[0]);
    const levels = chain.map((candidate) => candidate.level);

    assert.ok(levels.includes('control'), `chain should include control: ${levels.join(',')}`);
    assert.ok(levels.includes('row'), `chain should include row: ${levels.join(',')}`);
    assert.ok(levels.includes('region'), `chain should include region: ${levels.join(',')}`);

    const region = chain.find((candidate) => candidate.level === 'region');
    assert.equal(region?.nodeId, 'table_main');
    assert.equal(region?.entityRef?.entityId, 'ent_table');
});

test('pick candidate matchCount for repeated row action is >1 and expect one_or_more', () => {
    const { snapshot, finalEntityView, editButtonIds } = createTableFixture();
    const { candidateChain } = pickFromFingerprint(snapshot, finalEntityView, {
        point: { x: 20, y: 15 },
        selectorCandidates: [],
        tagName: 'button',
        classTokens: ['ant-btn'],
        text: '编辑',
        rect: { x: 10, y: 10, width: 40, height: 20 },
        ancestors: [],
    });
    const control = candidateChain.find((candidate) => candidate.level === 'control');
    assert.ok(control, 'control candidate missing');
    assert.ok((control?.matchCount || 0) >= 3, `expected >=3 matches, got ${control?.matchCount}`);
    assert.equal(control?.expect, 'one_or_more');
    assert.equal(control?.stabilityHint, 'stable');
    assert.equal(control?.enclosingEntityNodeId, 'table_main');
});

test('proposeRuleCandidates prefers stable class tokens over hash-like tokens', () => {
    const { snapshot, finalEntityView, editButtonIds } = createTableFixture();
    const editNode = snapshot.nodeIndex[editButtonIds[0]];
    setNodeAttr(editNode, 'class', 'ant-btn css-1a2b3d4e5f6');
    const chain = buildCandidateChain(snapshot, finalEntityView, editButtonIds[0]);
    const control = chain.find((candidate) => candidate.level === 'control');
    const target = control?.proposedTargets?.[0];
    assert.ok(target?.classContains, 'expected a classContains condition');
    assert.equal(target.classContains, 'ant-btn');
    assert.equal(isStableClassToken('ant-btn'), true);
    assert.equal(isStableClassToken('css-1a2b3d4e5f6'), false);
});

test('runCheck maps unique / multiple / missing for node annotations', () => {
    const { snapshot } = createTableFixture();
    const draft: CanvasDraft = {
        version: 1,
        profileName: 'check-profile',
        page: { kind: 'table' },
        entities: [
            {
                id: 'e0',
                source: 'region',
                kind: 'table',
                name: '订单列表',
                businessTag: 'order.list.main',
                target: { kind: 'table', nameContains: '订单列表' },
                expect: 'unique',
                annotations: [
                    {
                        id: 'e0_act_unique',
                        type: 'action',
                        businessKey: 'edit',
                        name: '编辑',
                        target: { classContains: 'ant-btn', textContains: '编辑' },
                        expect: 'one_or_more',
                        origin: 'inferred',
                        disposition: 'active',
                    },
                    {
                        id: 'e0_act_unique_single',
                        type: 'action',
                        businessKey: 'tableRoot',
                        name: '表格根',
                        target: { classContains: 'ant-table' },
                        expect: 'one_or_more',
                        origin: 'inferred',
                        disposition: 'active',
                    },
                    {
                        id: 'e0_act_missing',
                        type: 'action',
                        businessKey: 'ghost',
                        target: { classContains: 'does-not-exist-token' },
                        expect: 'unique',
                        origin: 'inferred',
                        disposition: 'active',
                    },
                    {
                        id: 'e0_act_multiple',
                        type: 'action',
                        businessKey: 'anyBtn',
                        target: { classContains: 'ant-btn' },
                        expect: 'unique',
                        origin: 'inferred',
                        disposition: 'active',
                    },
                ],
                columns: [],
                origin: 'inferred',
            },
        ],
        preserved: {
            matchRaw: { version: 1, page: { kind: 'table' }, entities: [] },
            annotationRaw: { version: 1, page: { kind: 'table' }, annotations: [] },
            preservedByCanvasId: {},
            ruleIdToCanvasId: {},
            locatorRules: [],
            ruleRefs: [],
        },
    };

    const result = runCheck(snapshot, draft, 'http://test/entity-rules/fixtures/order-list');
    const byId = new Map(result.results.map((item) => [item.canvasAnnotationId, item]));
    assert.equal(byId.get('e0_act_unique')?.status, 'unique', 'one_or_more with 3 matches is valid');
    assert.equal(byId.get('e0_act_unique')?.expected, 'one_or_more');
    assert.equal(byId.get('e0_act_unique')?.matchCount, 3);
    assert.equal(
        byId.get('e0_act_unique_single')?.status,
        'unique',
        'one_or_more with 1 match is valid',
    );
    assert.equal(byId.get('e0_act_unique_single')?.matchCount, 1);
    assert.equal(byId.get('e0_act_missing')?.status, 'missing');
    assert.equal(byId.get('e0_act_missing')?.message, '没有找到目标');
    assert.equal(byId.get('e0_act_multiple')?.status, 'multiple', 'unique with 3 matches is an error');
    assert.equal(result.stale, false);
});

test('runCheck reports stale when url no longer matches draft urlPattern', () => {
    const { snapshot } = createTableFixture();
    const draft: CanvasDraft = {
        version: 1,
        profileName: 'stale-profile',
        page: { kind: 'table', urlPattern: '/order-list$' },
        entities: [
            {
                id: 'e0',
                source: 'region',
                kind: 'table',
                name: '订单列表',
                businessTag: 'order.list.main',
                target: { kind: 'table', nameContains: '订单列表' },
                expect: 'unique',
                annotations: [],
                columns: [],
                origin: 'inferred',
            },
        ],
        preserved: {
            matchRaw: { version: 1, page: { kind: 'table' }, entities: [] },
            annotationRaw: { version: 1, page: { kind: 'table' }, annotations: [] },
            preservedByCanvasId: {},
            ruleIdToCanvasId: {},
            locatorRules: [],
            ruleRefs: [],
        },
    };
    assert.equal(detectStale('http://test/somewhere-else', draft), true);
    assert.equal(detectStale('http://test/order-list', draft), false);
    const result = runCheck(snapshot, draft, 'http://test/somewhere-else');
    assert.equal(result.stale, true);
});

test('buildOpenResult reads workflow artifact, profile, revision and visual targets', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-order-form');
    const bundle = toEntityRuleBundle(artifact);
    const { snapshot, finalEntityView } = (() => {
        const root: UnifiedNode = { id: 'root', role: 'root', children: [] };
        return {
            snapshot: buildSnapshot({
                root,
                nodeIndex: { root },
                entityIndex: { entities: {}, byNodeId: {} },
                locatorIndex: {},
                bboxIndex: {},
                attrIndex: {},
                contentStore: {},
            }),
            finalEntityView: {
                entities: [],
                byNodeId: {},
                bindingIndex: { fieldsByEntity: {}, actionsByEntity: {}, columnsByEntity: {} },
            },
        };
    })();

    const provider: WorkspaceEntityRulesProvider = {
        listBundles: () => [bundle],
        getBundle: (name) => (name === artifact.name ? bundle : null),
        resolveBundle: () => bundle,
    };
    const getArtifact = (name: string) => (name === artifact.name ? artifact : null);
    const pageIdentity: SnapshotPageIdentity = {
        workspaceName: 'ws',
        tabName: 'tab',
        url: 'http://test/entity-rules/fixtures/order-form',
    };

    const open = buildOpenResult({
        snapshot,
        finalEntityView,
        pageIdentity,
        provider,
        getArtifact,
    });
    assert.equal(open.profileName, artifact.name);
    assert.ok(open.canvasDraft, 'canvasDraft should be imported');
    assert.ok(open.artifactRevision, 'artifactRevision should be computed');
    assert.equal(open.artifactRevision, computeArtifactRevision(artifact));
    assert.equal(open.pageKind, 'form');
    assert.equal(open.workspaceName, 'ws');
});

test('buildOpenResult populates bbox, matchedNodeBoxes, and canvasAnnotationId in visual target refs', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-orders');
    const bundle = toEntityRuleBundle(artifact);
    const { snapshot, finalEntityView } = createTableFixture();

    const provider: WorkspaceEntityRulesProvider = {
        listBundles: () => [bundle],
        getBundle: (name) => (name === artifact.name ? bundle : null),
        resolveBundle: () => bundle,
    };
    const getArtifact = (name: string) => (name === artifact.name ? artifact : null);
    const pageIdentity: SnapshotPageIdentity = {
        workspaceName: 'ws',
        tabName: 'tab',
        url: 'http://test/entity-rules/fixtures/order-list',
    };

    const open = buildOpenResult({
        snapshot,
        finalEntityView,
        pageIdentity,
        provider,
        getArtifact,
    });

    const refsWithBbox = open.visualTargetRefs.filter((ref) => ref.bbox);
    assert.ok(refsWithBbox.length > 0, 'expected at least one ref with bbox');
    for (const ref of refsWithBbox) {
        assert.equal(typeof ref.bbox!.x, 'number', 'bbox.x should be number');
        assert.equal(typeof ref.bbox!.y, 'number', 'bbox.y should be number');
        assert.equal(typeof ref.bbox!.width, 'number', 'bbox.width should be number');
        assert.equal(typeof ref.bbox!.height, 'number', 'bbox.height should be number');
    }

    const editRefs = open.visualTargetRefs.filter((ref) => ref.actionIntent === 'edit');
    assert.ok(editRefs.length > 0, 'expected at least one edit action ref');
    const editWithBoxes = editRefs.find(
        (ref) => ref.matchedNodeBoxes && ref.matchedNodeBoxes.length > 1,
    );
    assert.ok(editWithBoxes, 'expected edit ref with matchedNodeBoxes length > 1');
    assert.equal(editWithBoxes!.matchedNodeBoxes!.length, 3);

    const deleteRefs = open.visualTargetRefs.filter((ref) => ref.actionIntent === 'delete');
    assert.ok(deleteRefs.length > 0, 'expected at least one delete action ref');
    const deleteWithBoxes = deleteRefs.find(
        (ref) => ref.matchedNodeBoxes && ref.matchedNodeBoxes.length > 1,
    );
    assert.ok(deleteWithBoxes, 'expected delete ref with matchedNodeBoxes length > 1');
    assert.equal(deleteWithBoxes!.matchedNodeBoxes!.length, 3);

    const refsWithCanvasId = open.visualTargetRefs.filter((ref) => ref.canvasAnnotationId);
    assert.ok(
        refsWithCanvasId.length > 0,
        'expected refs with canvasAnnotationId set for canvas annotation correlation',
    );
    assert.ok(
        refsWithCanvasId.some((ref) => ref.actionIntent === 'edit'),
        'edit ref should carry canvasAnnotationId',
    );
});

test('computeArtifactRevision is deterministic and order-independent', () => {
    const artifact = {
        kind: 'entity_rules' as const,
        name: 'x',
        match: { b: 2, a: 1 },
        annotation: { y: [1, 2] },
    };
    const reversed = {
        kind: 'entity_rules' as const,
        name: 'x',
        match: { a: 1, b: 2 },
        annotation: { y: [1, 2] },
    };
    assert.equal(computeArtifactRevision(artifact), computeArtifactRevision(reversed));
});

test('isRevisionConflict detects mismatch and allows new profile when expected is null', () => {
    const artifact: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'p',
        match: {},
        annotation: {},
    };
    assert.equal(isRevisionConflict(artifact, 'stale'), true);
    assert.equal(isRevisionConflict(artifact, computeArtifactRevision(artifact)), false);
    assert.equal(isRevisionConflict(null, null), false);
});

const createInMemoryWorkflow = (): Workflow => {
    const store = new Map<string, WorkflowEntityRules>();
    return {
        name: 'ws-test',
        save: (value) => {
            const a = value as WorkflowEntityRules;
            store.set(a.name, a);
            return a;
        },
        get: (name, dummy: WorkflowDummy) =>
            dummy.kind === 'entity_rules' ? store.get(name) ?? null : null,
        list: (dummy: WorkflowDummy): WorkflowCatalogItem[] =>
            dummy.kind === 'entity_rules'
                ? [...store.values()].map((a) => ({
                      kind: 'entity_rules',
                      name: a.name,
                      title: a.name,
                      createdAt: 0,
                      updatedAt: 0,
                      summary: '',
                  }))
                : [],
        delete: (name, dummy: WorkflowDummy) =>
            dummy.kind === 'entity_rules' ? store.delete(name) : false,
    };
};

const buildValidDraft = (profileName: string, urlPattern?: string): CanvasDraft => ({
    version: 1,
    profileName,
    page: { kind: 'form', ...(urlPattern ? { urlPattern } : {}) },
    entities: [
        {
            id: 'e0',
            source: 'region',
            kind: 'form',
            name: '订单表单',
            businessTag: 'form.main',
            target: { kind: 'form', nameContains: '订单表单' },
            expect: 'unique',
            annotations: [
                {
                    id: 'e0_field0',
                    type: 'field',
                    businessKey: 'buyer',
                    name: '采购人',
                    target: { classContains: 'ant-input' },
                    expect: 'unique',
                    origin: 'inferred',
                    disposition: 'active',
                },
            ],
            columns: [],
            origin: 'inferred',
        },
    ],
    preserved: {
        matchRaw: { version: 1, page: { kind: 'form' }, entities: [] },
        annotationRaw: { version: 1, page: { kind: 'form' }, annotations: [] },
        preservedByCanvasId: {},
        ruleIdToCanvasId: {},
        locatorRules: [],
        ruleRefs: [],
    },
});

const stablePageIdentity: SnapshotPageIdentity = {
    workspaceName: 'ws',
    tabName: 'tab',
    url: 'http://test/form',
};

const createFormSnapshot = (): SnapshotResult => {
    const input = newTextNode('input_buyer', 'textbox', '');
    setNodeAttr(input, 'class', 'ant-input');
    setNodeAttr(input, 'tag', 'input');
    setNodeBbox(input, { x: 10, y: 10, width: 200, height: 24 });
    const form = newTextNode('form_main', 'form', '订单表单');
    setNodeAttr(form, 'class', 'ant-form');
    setNodeAttr(form, 'tag', 'form');
    setNodeBbox(form, { x: 0, y: 0, width: 400, height: 300 });
    form.children = [input];
    const root: UnifiedNode = { id: 'root', role: 'root', children: [form] };
    const entityIndex: EntityIndex = {
        entities: {
            ent_form: {
                id: 'ent_form',
                type: 'region',
                kind: 'form',
                nodeId: 'form_main',
                name: '订单表单',
            },
        },
        byNodeId: {},
    };
    entityIndex.byNodeId['form_main'] = [
        { type: 'region', entityId: 'ent_form', role: 'container' },
    ];
    entityIndex.byNodeId['input_buyer'] = [
        { type: 'region', entityId: 'ent_form', role: 'descendant' },
    ];
    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    return buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex: {},
        bboxIndex,
        attrIndex,
        contentStore,
    });
};

const emptySnapshot = (): SnapshotResult => {
    const root: UnifiedNode = { id: 'root', role: 'root', children: [] };
    return buildSnapshot({
        root,
        nodeIndex: { root },
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {},
        bboxIndex: {},
        attrIndex: {},
        contentStore: {},
    });
};

test('executeSave saves a new profile when expectedRevision is null', () => {
    const runtime = createWorkspaceEntityRulesRuntime(createInMemoryWorkflow());
    const draft = buildValidDraft('brand-new');
    const snapshot = createFormSnapshot();
    const result = executeSave(runtime, stablePageIdentity, snapshot, draft, 'brand-new', null);
    assert.equal(result.saved, true);
    assert.equal(result.profileName, 'brand-new');
    assert.equal(result.artifactRevision, computeArtifactRevision(result.entityRules));
    assert.equal(runtime.get('brand-new')?.name, 'brand-new');
});

test('executeSave rejects with ERR_CONFLICT when expectedRevision mismatches stored', () => {
    const runtime = createWorkspaceEntityRulesRuntime(createInMemoryWorkflow());
    const draft = buildValidDraft('conflict-profile');
    const snapshot = createFormSnapshot();
    executeSave(runtime, stablePageIdentity, snapshot, draft, 'conflict-profile', null);
    assert.throws(
        () =>
            executeSave(
                runtime,
                stablePageIdentity,
                snapshot,
                draft,
                'conflict-profile',
                'stale-revision',
            ),
        (error: unknown) => (error as { code?: string }).code === 'ERR_CONFLICT',
    );
});

test('executeSave re-save succeeds when expectedRevision matches current stored', () => {
    const runtime = createWorkspaceEntityRulesRuntime(createInMemoryWorkflow());
    const draft = buildValidDraft('idempotent');
    const snapshot = createFormSnapshot();
    const first = executeSave(runtime, stablePageIdentity, snapshot, draft, 'idempotent', null);
    const second = executeSave(
        runtime,
        stablePageIdentity,
        snapshot,
        draft,
        'idempotent',
        first.artifactRevision,
    );
    assert.equal(second.saved, true);
    assert.equal(second.artifactRevision, first.artifactRevision);
});

test('executeSave rejects with ERR_STALE when page url no longer matches draft urlPattern', () => {
    const runtime = createWorkspaceEntityRulesRuntime(createInMemoryWorkflow());
    const draft = buildValidDraft('stale-profile', '/order-form$');
    assert.throws(
        () =>
            executeSave(
                runtime,
                { workspaceName: 'ws', tabName: 'tab', url: 'http://test/other' },
                emptySnapshot(),
                draft,
                'stale-profile',
                null,
            ),
        (error: unknown) => (error as { code?: string }).code === 'ERR_STALE',
    );
});

test('executeSave rejects with ERR_BAD_ARGS when draft does not compile', () => {
    const runtime = createWorkspaceEntityRulesRuntime(createInMemoryWorkflow());
    const draft = buildValidDraft('bad-profile');
    draft.entities[0].target = {};
    assert.throws(
        () => executeSave(runtime, stablePageIdentity, emptySnapshot(), draft, 'bad-profile', null),
        (error: unknown) => (error as { code?: string }).code === 'ERR_BAD_ARGS',
    );
});

test('recognizeEntities produces an inferred entity from finalEntityView without existing draft', () => {
    const root: UnifiedNode = { id: 'root', role: 'root', children: [] };
    const snapshot = buildSnapshot({
        root,
        nodeIndex: { root },
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {},
        bboxIndex: {},
        attrIndex: {},
        contentStore: {},
    });
    const finalEntityView: FinalEntityView = {
        entities: [
            {
                id: 'ent_form',
                nodeId: 'form_main',
                kind: 'form',
                type: 'region',
                name: '订单表单',
                businessTag: 'form.main',
                businessName: '订单表单',
                source: 'auto',
                formFields: [{ fieldKey: 'buyer', name: '采购人' }],
                formActions: [{ actionIntent: 'submit', text: '提交' }],
            },
        ],
        byNodeId: {},
        bindingIndex: { fieldsByEntity: {}, actionsByEntity: {}, columnsByEntity: {} },
    };
    const { canvasDraft, recognized } = recognizeEntities(snapshot, finalEntityView);
    assert.ok(canvasDraft.entities.length >= 1);
    const form = canvasDraft.entities.find((entity) => entity.kind === 'form');
    assert.ok(form, 'inferred form entity missing');
    assert.equal(form?.origin, 'inferred');
    assert.ok(recognized.some((item) => item.fieldCount > 0));
});

test('full save round-trip: edit -> check (all unique) -> save -> reload -> semantic preserved', () => {
    const runtime = createWorkspaceEntityRulesRuntime(createInMemoryWorkflow());
    const snapshot = createFormSnapshot();
    const draft = buildValidDraft('round-trip');

    const editedEntity = {
        ...draft.entities[0],
        name: '编辑后的表单',
        target: { kind: 'form' as const, nameContains: '订单表单' },
        annotations: [
            {
                ...draft.entities[0].annotations[0],
                name: '采购人',
                target: { classContains: 'ant-input' },
                origin: 'confirmed' as const,
            },
        ],
    };
    const editedDraft: CanvasDraft = {
        ...draft,
        entities: [editedEntity],
    };

    const checkBeforeSave = runCheck(snapshot, editedDraft, stablePageIdentity.url);
    const entityResultBefore = checkBeforeSave.results.find((r) =>
        r.canvasAnnotationId === 'entity:e0',
    );
    assert.ok(entityResultBefore);
    assert.equal(entityResultBefore!.status, 'unique');
    assert.equal(entityResultBefore!.matchCount, 1);

    const saved = executeSave(
        runtime,
        stablePageIdentity,
        snapshot,
        editedDraft,
        'round-trip',
        null,
    );
    assert.equal(saved.saved, true);

    const reloaded = runtime.get('round-trip');
    assert.ok(reloaded, 'reloaded artifact must exist');
    const revalidated = validateEntityRules(reloaded!.name, reloaded!.match, reloaded!.annotation);
    assert.equal(revalidated.ok, true, 'reloaded artifact must re-validate');

    const recompiled = compileCanvasDraft(importEntityRulesToCanvasDraft(reloaded!));
    assert.equal(recompiled.ok, true, 're-imported canvas draft must recompile');

    const checkAfterReload = runCheck(snapshot, importEntityRulesToCanvasDraft(reloaded!), stablePageIdentity.url);
    const entityResultAfter = checkAfterReload.results.find((r) =>
        r.canvasAnnotationId === 'entity:e0',
    );
    assert.ok(entityResultAfter);
    assert.equal(entityResultAfter!.status, 'unique', 'entity still resolves after round-trip');
    assert.equal(entityResultAfter!.matchCount, 1);
});
