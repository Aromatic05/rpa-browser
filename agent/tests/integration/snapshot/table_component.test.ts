import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildControlSnapshot,
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

const capture = (nodes: RawCapturedNode[]): RawPageCapture => ({
    identity: { pageEpoch: 'table-fixture', captureRevision: 1 },
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
    return buildTableSnapshot({
        observation,
        relations,
        locators,
        controls,
        selectionScopeNodeId: selectionScopeCaptureId
            ? observation.captureIdToNodeId[selectionScopeCaptureId]
            : undefined,
    });
};

const onlyTable = (snapshot: ReturnType<typeof build>) => {
    const tables = Object.values(snapshot.tables.tables);
    assert.equal(tables.length, 1);
    return tables[0];
};

const executeTableRules = (snapshot: ReturnType<typeof build>, rules: EntityRuleMatchRecord[]) => {
    const compiled = compileEntityRuleQueryPlan({ profileName: 'table-query-test', domain: 'table', rules });
    assert.equal(compiled.ok, true, compiled.ok ? undefined : JSON.stringify(compiled.diagnostics, null, 2));
    if (!compiled.ok) {throw new Error('query plan compilation failed');}
    return executeEntityRuleQueryPlan(compiled.plan, { table: snapshot }, { purpose: 'runtime' });
};

test('native table keeps canonical rows separate from FeatureCover and control templates', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table']),
        node('table', 'table', 'body', ['thead', 'tbody'], { id: 'users' }),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['name-header', 'action-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('action-header', 'th', 'header-row', [], {}, 'Actions'),
        node('tbody', 'tbody', 'table', ['row-a', 'row-b', 'row-c']),
        node('row-a', 'tr', 'tbody', ['name-a', 'action-a']),
        node('name-a', 'td', 'row-a', [], {}, 'Alice'),
        node('action-a', 'td', 'row-a', ['edit-a']),
        node('edit-a', 'button', 'action-a', [], {}, 'Edit'),
        node('row-b', 'tr', 'tbody', ['name-b', 'action-b']),
        node('name-b', 'td', 'row-b', [], {}, 'Bob'),
        node('action-b', 'td', 'row-b', ['edit-b']),
        node('edit-b', 'button', 'action-b', [], {}, 'Edit'),
        node('row-c', 'tr', 'tbody', ['name-c', 'action-c']),
        node('name-c', 'td', 'row-c', [], {}, 'Carol'),
        node('action-c', 'td', 'row-c', ['audit']),
        node('audit', 'a', 'action-c', [], { href: '/audit' }, 'Audit'),
    ]);

    const table = onlyTable(snapshot);
    assert.equal(table.status, 'complete');
    assert.deepEqual(table.columns.map((column) => column.name), ['Name', 'Actions']);
    assert.equal(table.body.visibleRows.length, 3);
    assert.equal(Object.keys(snapshot.tables.rows).length, 3);
    assert.ok(table.body.representativeRowIds.length <= 3);
    assert.equal(table.controlSlots.length, 1);
    assert.equal(table.controlSlots[0].controlKind, 'button');
    assert.equal(table.controlSlots[0].occurrenceCount, 2);
    assert.equal(table.rowExceptions.length, 1);
    assert.equal(table.rowExceptions[0].controlIds.length, 1);
    assert.equal(table.suggestions.some((item) => item.kind === 'primary-key-candidate'), true);
    assert.equal(snapshot.tables.validation.ok, true, JSON.stringify(snapshot.tables.validation.diagnostics, null, 2));
});

test('Element wrapper clusters header, body, fixed-right, footer and sibling pagination into one table', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['card']),
        node('card', 'section', 'body', ['pager-top', 'table-root', 'pager-bottom'], { role: 'table', class: 'el-card' }),
        node('pager-top', 'div', 'card', [], { class: 'el-pagination', 'aria-label': 'top pagination' }),
        node('table-root', 'div', 'card', ['header-wrap', 'body-wrap', 'fixed-right', 'footer-wrap'], { class: 'el-table' }),
        node('header-wrap', 'div', 'table-root', ['header-table'], { class: 'el-table__header-wrapper' }),
        node('header-table', 'table', 'header-wrap', ['header-row']),
        node('header-row', 'tr', 'header-table', ['name-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('body-wrap', 'div', 'table-root', ['body-table'], { class: 'el-table__body-wrapper' }),
        node('body-table', 'table', 'body-wrap', ['row-a', 'row-b']),
        node('row-a', 'tr', 'body-table', ['name-a'], { 'data-row-key': 'a' }),
        node('name-a', 'td', 'row-a', [], {}, 'Alice'),
        node('row-b', 'tr', 'body-table', ['name-b'], { 'data-row-key': 'b' }),
        node('name-b', 'td', 'row-b', [], {}, 'Bob'),
        node('fixed-right', 'div', 'table-root', ['fixed-header-wrap', 'fixed-body-wrap'], { class: 'el-table__fixed-right' }),
        node('fixed-header-wrap', 'div', 'fixed-right', ['fixed-header-table'], { class: 'el-table__fixed-header-wrapper' }),
        node('fixed-header-table', 'table', 'fixed-header-wrap', ['fixed-header-row']),
        node('fixed-header-row', 'tr', 'fixed-header-table', ['action-header']),
        node('action-header', 'th', 'fixed-header-row', [], {}, 'Actions'),
        node('fixed-body-wrap', 'div', 'fixed-right', ['fixed-body-table'], { class: 'el-table__fixed-body-wrapper' }),
        node('fixed-body-table', 'table', 'fixed-body-wrap', ['fixed-row-a', 'fixed-row-b']),
        node('fixed-row-a', 'tr', 'fixed-body-table', ['action-a'], { 'data-row-key': 'a' }),
        node('action-a', 'td', 'fixed-row-a', ['edit-a']),
        node('edit-a', 'button', 'action-a', [], {}, 'Edit'),
        node('fixed-row-b', 'tr', 'fixed-body-table', ['action-b'], { 'data-row-key': 'b' }),
        node('action-b', 'td', 'fixed-row-b', ['edit-b']),
        node('edit-b', 'button', 'action-b', [], {}, 'Edit'),
        node('footer-wrap', 'div', 'table-root', ['footer-table'], { class: 'el-table__footer-wrapper' }),
        node('footer-table', 'table', 'footer-wrap', ['footer-row']),
        node('footer-row', 'tr', 'footer-table', ['footer-cell']),
        node('footer-cell', 'td', 'footer-row', [], {}, 'Total 2'),
        node('pager-bottom', 'div', 'card', [], { class: 'el-pagination', 'aria-label': 'bottom pagination' }),
    ], 'card');

    const table = onlyTable(snapshot);
    assert.equal(table.location.selectionScopeNodeId, snapshot.observation.captureIdToNodeId.card);
    assert.equal(table.location.hostNodeId, snapshot.observation.captureIdToNodeId.card);
    assert.equal(table.location.structuralRootNodeId, snapshot.observation.captureIdToNodeId['table-root']);
    assert.equal(table.parts.physicalTableNodeIds.length, 5);
    assert.deepEqual(table.columns.map((column) => column.name), ['Name', 'Actions']);
    assert.equal(table.body.visibleRows.length, 2);
    assert.equal(Object.keys(snapshot.tables.rows).length, 2);
    assert.equal(table.controlSlots.length, 1);
    assert.equal(table.controlSlots[0].occurrenceCount, 2);
    assert.equal(table.footer?.rowNodeIds.length, 1, JSON.stringify({
        parts: table.parts,
        footer: table.footer,
    }, null, 2));
    assert.equal(table.pagination?.nodeIds.length, 2);
    assert.equal(snapshot.tables.validation.ok, true, JSON.stringify(snapshot.tables.validation.diagnostics, null, 2));
});

test('nested native tables use direct row ownership and remain separate logical components', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['outer']),
        node('outer', 'table', 'body', ['outer-body']),
        node('outer-body', 'tbody', 'outer', ['outer-row']),
        node('outer-row', 'tr', 'outer-body', ['outer-cell']),
        node('outer-cell', 'td', 'outer-row', ['inner'], {}, 'Outer'),
        node('inner', 'table', 'outer-cell', ['inner-body']),
        node('inner-body', 'tbody', 'inner', ['inner-row']),
        node('inner-row', 'tr', 'inner-body', ['inner-cell']),
        node('inner-cell', 'td', 'inner-row', [], {}, 'Inner'),
    ]);

    const tables = Object.values(snapshot.tables.tables);
    assert.equal(tables.length, 2);
    const outer = tables.find((table) => table.location.structuralRootNodeId === snapshot.observation.captureIdToNodeId.outer);
    const inner = tables.find((table) => table.location.structuralRootNodeId === snapshot.observation.captureIdToNodeId.inner);
    assert.equal(outer?.body.visibleRows.length, 1);
    assert.equal(inner?.body.visibleRows.length, 1);
    assert.equal(Object.keys(snapshot.tables.rows).length, 2);
});

test('multi-level headers produce a header tree and stable leaf columns', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table']),
        node('table', 'table', 'body', ['thead', 'tbody']),
        node('thead', 'thead', 'table', ['header-one', 'header-two']),
        node('header-one', 'tr', 'thead', ['name', 'details']),
        node('name', 'th', 'header-one', [], { rowspan: '2' }, 'Name'),
        node('details', 'th', 'header-one', [], { colspan: '2' }, 'Details'),
        node('header-two', 'tr', 'thead', ['age', 'city']),
        node('age', 'th', 'header-two', [], {}, 'Age'),
        node('city', 'th', 'header-two', [], {}, 'City'),
        node('tbody', 'tbody', 'table', ['row']),
        node('row', 'tr', 'tbody', ['name-cell', 'age-cell', 'city-cell']),
        node('name-cell', 'td', 'row', [], {}, 'Alice'),
        node('age-cell', 'td', 'row', [], {}, '30'),
        node('city-cell', 'td', 'row', [], {}, 'Tokyo'),
    ]);

    const table = onlyTable(snapshot);
    assert.equal(table.header.rowCount, 2);
    assert.equal(table.header.leafColumnIds.length, 3);
    assert.deepEqual(table.columns.map((column) => column.name), ['Name', 'Details / Age', 'Details / City']);
    const details = Object.values(table.header.cells).find((cell) => cell.nodeId === snapshot.observation.captureIdToNodeId.details);
    assert.equal(details?.childCellIds.length, 2);
});

test('treegrid hierarchy preserves evidence and reports an invalid level jump', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['tree']),
        node('tree', 'div', 'body', ['header', 'row-a', 'row-b'], { role: 'treegrid' }),
        node('header', 'div', 'tree', ['header-cell'], { role: 'row' }),
        node('header-cell', 'div', 'header', [], { role: 'columnheader' }, 'Name'),
        node('row-a', 'div', 'tree', ['cell-a'], { role: 'row', 'aria-level': '1' }),
        node('cell-a', 'div', 'row-a', [], { role: 'gridcell' }, 'Root'),
        node('row-b', 'div', 'tree', ['cell-b'], { role: 'row', 'aria-level': '3' }),
        node('cell-b', 'div', 'row-b', [], { role: 'gridcell' }, 'Invalid child'),
    ]);

    const table = onlyTable(snapshot);
    assert.equal(table.hierarchy?.source, 'aria-level');
    assert.equal(table.status, 'partial');
    assert.equal(table.diagnostics.some((item) => item.code === 'table.hierarchy.invalid-level-jump'), true);
});

test('FeatureCover remains bounded while the canonical RowIndex retains every visible row', () => {
    const rowCount = 80;
    const bodyChildren = Array.from({ length: rowCount }, (_, index) => `row-${index}`);
    const nodes: RawCapturedNode[] = [
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table']),
        node('table', 'table', 'body', ['thead', 'tbody']),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['header']),
        node('header', 'th', 'header-row', [], {}, 'Value'),
        node('tbody', 'tbody', 'table', bodyChildren),
    ];
    for (let index = 0; index < rowCount; index += 1) {
        nodes.push(node(`row-${index}`, 'tr', 'tbody', [`cell-${index}`]));
        nodes.push(node(`cell-${index}`, 'td', `row-${index}`, [], {}, `Value ${index}`));
    }

    const snapshot = build(nodes);
    const table = onlyTable(snapshot);
    assert.equal(table.body.visibleRows.length, rowCount);
    assert.equal(Object.keys(snapshot.tables.rows).length, rowCount);
    assert.ok(table.body.representativeRowIds.length <= 2);
    assert.deepEqual(table.featureCover.uncoveredFeatures, []);
});

test('Ant wrapper assembles sticky header, fixed-right action and summary without duplicate rows', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['card']),
        node('card', 'section', 'body', ['ant-root', 'pager'], { class: 'ant-card' }),
        node('ant-root', 'div', 'card', ['header-wrap', 'body-wrap', 'fixed-right'], { class: 'ant-table-wrapper' }),
        node('header-wrap', 'div', 'ant-root', ['header-table'], { class: 'ant-table-header ant-table-sticky-holder' }),
        node('header-table', 'table', 'header-wrap', ['header-row']),
        node('header-row', 'tr', 'header-table', ['name-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('body-wrap', 'div', 'ant-root', ['body-table'], { class: 'ant-table-body' }),
        node('body-table', 'table', 'body-wrap', ['row-a', 'row-b', 'summary']),
        node('row-a', 'tr', 'body-table', ['name-a'], { 'data-row-key': 'a' }),
        node('name-a', 'td', 'row-a', [], {}, 'Alice'),
        node('row-b', 'tr', 'body-table', ['name-b'], { 'data-row-key': 'b' }),
        node('name-b', 'td', 'row-b', [], {}, 'Bob'),
        node('summary', 'tfoot', 'body-table', ['summary-row'], { class: 'ant-table-summary' }),
        node('summary-row', 'tr', 'summary', ['summary-cell']),
        node('summary-cell', 'td', 'summary-row', [], {}, 'Total 2'),
        node('fixed-right', 'div', 'ant-root', ['fixed-header', 'fixed-body'], { class: 'ant-table-fixed-right' }),
        node('fixed-header', 'table', 'fixed-right', ['fixed-header-row'], { class: 'ant-table-header' }),
        node('fixed-header-row', 'tr', 'fixed-header', ['action-header']),
        node('action-header', 'th', 'fixed-header-row', [], {}, 'Actions'),
        node('fixed-body', 'table', 'fixed-right', ['fixed-row-a', 'fixed-row-b'], { class: 'ant-table-body' }),
        node('fixed-row-a', 'tr', 'fixed-body', ['action-a'], { 'data-row-key': 'a' }),
        node('action-a', 'td', 'fixed-row-a', ['edit-a']),
        node('edit-a', 'button', 'action-a', [], {}, 'Edit'),
        node('fixed-row-b', 'tr', 'fixed-body', ['action-b'], { 'data-row-key': 'b' }),
        node('action-b', 'td', 'fixed-row-b', ['edit-b']),
        node('edit-b', 'button', 'action-b', [], {}, 'Edit'),
        node('pager', 'ul', 'card', [], { class: 'ant-pagination' }),
    ]);

    const table = onlyTable(snapshot);
    assert.deepEqual(table.columns.map((column) => column.name), ['Name', 'Actions']);
    assert.equal(table.body.visibleRows.length, 2);
    assert.equal(table.footer?.rowNodeIds.length, 1);
    assert.equal(table.controlSlots[0]?.occurrenceCount, 2);
    assert.equal(table.pagination?.status, 'resolved');
    assert.equal(snapshot.tables.validation.ok, true, JSON.stringify(snapshot.tables.validation.diagnostics, null, 2));
});

test('virtualized grid reports a partial row window without inventing hidden rows', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['grid']),
        node('grid', 'div', 'body', ['header', 'row-a', 'row-b'], { role: 'grid', 'aria-rowcount': '100', class: 'virtual-grid' }),
        node('header', 'div', 'grid', ['header-cell'], { role: 'row' }),
        node('header-cell', 'div', 'header', [], { role: 'columnheader' }, 'Name'),
        node('row-a', 'div', 'grid', ['cell-a'], { role: 'row', 'aria-rowindex': '20' }),
        node('cell-a', 'div', 'row-a', [], { role: 'gridcell' }, 'Alice'),
        node('row-b', 'div', 'grid', ['cell-b'], { role: 'row', 'aria-rowindex': '21' }),
        node('cell-b', 'div', 'row-b', [], { role: 'gridcell' }, 'Bob'),
    ]);

    const table = onlyTable(snapshot);
    assert.equal(table.body.visibleRows.length, 2);
    assert.equal(table.body.rowWindow.totalCount, 100);
    assert.equal(table.body.rowWindow.completeness, 'partial');
    assert.equal(Object.keys(snapshot.tables.rows).length, 2);
});

test('shared sibling pagination remains ambiguous when two logical tables are possible owners', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['card']),
        node('card', 'section', 'body', ['table-a', 'table-b', 'pager'], { class: 'card' }),
        node('table-a', 'table', 'card', ['body-a']),
        node('body-a', 'tbody', 'table-a', ['row-a']),
        node('row-a', 'tr', 'body-a', ['cell-a']),
        node('cell-a', 'td', 'row-a', [], {}, 'A'),
        node('table-b', 'table', 'card', ['body-b']),
        node('body-b', 'tbody', 'table-b', ['row-b']),
        node('row-b', 'tr', 'body-b', ['cell-b']),
        node('cell-b', 'td', 'row-b', [], {}, 'B'),
        node('pager', 'nav', 'card', [], { role: 'navigation', 'aria-label': 'Pagination' }),
    ]);

    const tables = Object.values(snapshot.tables.tables);
    assert.equal(tables.length, 2);
    assert.equal(tables.every((table) => table.pagination?.status === 'ambiguous'), true);
    assert.equal(tables.every((table) => table.status === 'ambiguous'), true);
});

test('table QueryPlan binds only complete table components and canonical descendants', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table']),
        node('table', 'table', 'body', ['thead', 'tbody'], { id: 'Orders', 'aria-label': 'Orders' }),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['header']),
        node('header', 'th', 'header-row', [], {}, 'Customer'),
        node('tbody', 'tbody', 'table', ['row']),
        node('row', 'tr', 'tbody', ['cell']),
        node('cell', 'td', 'row', [], {}, 'Alice'),
    ]);
    const result = executeTableRules(snapshot, [
        {
            ruleId: 'orders',
            source: 'region',
            expect: 'unique',
            match: { kind: 'table', nameContains: 'Orders' },
        },
        {
            ruleId: 'customer',
            source: 'node',
            expect: 'unique',
            within: 'orders',
            match: { nameContains: 'Alice' },
        },
    ]);

    assert.equal(result.byRuleId.orders.ok, true);
    assert.equal(result.byRuleId.orders.matchedComponentIds.length, 1);
    assert.deepEqual(result.byRuleId.orders.matchedRowIds, [Object.keys(snapshot.tables.rows)[0]]);
    assert.deepEqual(result.byRuleId.customer.matchedNodeIds, [snapshot.observation.captureIdToNodeId.cell]);
    assert.deepEqual(result.diagnostics, []);
});

test('portal cell editor binds through exact IDREF ownership and unresolved closed state stays partial', () => {
    const open = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table', 'editor']),
        node('table', 'table', 'body', ['thead', 'tbody'], { id: 'editable-table' }),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['name-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('tbody', 'tbody', 'table', ['row']),
        node('row', 'tr', 'tbody', ['cell'], { 'data-row-key': 'user-1' }),
        node('cell', 'td', 'row', ['edit-trigger'], { 'aria-controls': 'cell-editor' }, 'Alice'),
        node('edit-trigger', 'button', 'cell', [], {}, 'Edit'),
        node('editor', 'div', 'body', ['editor-input'], { id: 'cell-editor', role: 'dialog' }),
        node('editor-input', 'input', 'editor', [], { id: 'editor-name', type: 'text' }),
    ]);
    const openTable = onlyTable(open);
    const openCell = Object.values(open.tables.cells)[0];
    const editorControl = Object.values(open.controls.controls)
        .find((control) => control.controlNodeId === open.observation.captureIdToNodeId['editor-input']);
    assert.ok(editorControl);
    assert.equal(openTable.editors.length, 1);
    assert.equal(openTable.editors[0].status, 'resolved');
    assert.equal(openTable.editors[0].cellId, openCell.id);
    assert.deepEqual(openTable.editors[0].controlIds, [editorControl.id]);
    assert.equal(openCell.controlIds.includes(editorControl.id), true);
    const cellOwnership = open.tables.ownership.byOwner[`table-cell:${openCell.id}`] ?? [];
    assert.equal(cellOwnership.some((index) => open.tables.ownership.edges[index]?.role === 'editor'), true);
    assert.equal(openTable.status, 'complete');

    const closed = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table']),
        node('table', 'table', 'body', ['thead', 'tbody'], { id: 'editable-table' }),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['name-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('tbody', 'tbody', 'table', ['row']),
        node('row', 'tr', 'tbody', ['cell'], { 'data-row-key': 'user-1' }),
        node('cell', 'td', 'row', [], { 'aria-controls': 'cell-editor' }, 'Alice'),
    ]);
    const closedTable = onlyTable(closed);
    assert.equal(closedTable.editors.length, 1);
    assert.equal(closedTable.editors[0].status, 'unresolved');
    assert.equal(closedTable.status, 'partial');
    assert.equal(closedTable.diagnostics.some((item) => item.code === 'table.editor.target.unresolved'), true);
});

test('fixed-left clone maps to canonical rows and cells while fixed-right contributes one action column', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table-root']),
        node('table-root', 'div', 'body', ['header-wrap', 'body-wrap', 'fixed-left', 'fixed-right'], { class: 'el-table' }),
        node('header-wrap', 'div', 'table-root', ['header-table'], { class: 'el-table__header-wrapper' }),
        node('header-table', 'table', 'header-wrap', ['header-row']),
        node('header-row', 'tr', 'header-table', ['name-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('body-wrap', 'div', 'table-root', ['body-table'], { class: 'el-table__body-wrapper' }),
        node('body-table', 'table', 'body-wrap', ['body-a', 'body-b']),
        node('body-a', 'tr', 'body-table', ['name-a'], { 'data-row-key': 'u1' }),
        node('name-a', 'td', 'body-a', [], {}, 'Alice'),
        node('body-b', 'tr', 'body-table', ['name-b'], { 'data-row-key': 'u2' }),
        node('name-b', 'td', 'body-b', [], {}, 'Bob'),
        node('fixed-left', 'div', 'table-root', ['left-header-wrap', 'left-body-wrap'], { class: 'el-table__fixed' }),
        node('left-header-wrap', 'div', 'fixed-left', ['left-header-table'], { class: 'el-table__fixed-header-wrapper' }),
        node('left-header-table', 'table', 'left-header-wrap', ['left-header-row']),
        node('left-header-row', 'tr', 'left-header-table', ['left-name-header']),
        node('left-name-header', 'th', 'left-header-row', [], {}, 'Name'),
        node('left-body-wrap', 'div', 'fixed-left', ['left-body-table'], { class: 'el-table__fixed-body-wrapper' }),
        node('left-body-table', 'table', 'left-body-wrap', ['left-a', 'left-b']),
        node('left-a', 'tr', 'left-body-table', ['left-name-a'], { 'data-row-key': 'u1' }),
        node('left-name-a', 'td', 'left-a', [], {}, 'Alice'),
        node('left-b', 'tr', 'left-body-table', ['left-name-b'], { 'data-row-key': 'u2' }),
        node('left-name-b', 'td', 'left-b', [], {}, 'Bob'),
        node('fixed-right', 'div', 'table-root', ['right-header-wrap', 'right-body-wrap'], { class: 'el-table__fixed-right' }),
        node('right-header-wrap', 'div', 'fixed-right', ['right-header-table'], { class: 'el-table__fixed-right-header-wrapper' }),
        node('right-header-table', 'table', 'right-header-wrap', ['right-header-row']),
        node('right-header-row', 'tr', 'right-header-table', ['action-header']),
        node('action-header', 'th', 'right-header-row', [], {}, 'Actions'),
        node('right-body-wrap', 'div', 'fixed-right', ['right-body-table'], { class: 'el-table__fixed-right-body-wrapper' }),
        node('right-body-table', 'table', 'right-body-wrap', ['right-a', 'right-b']),
        node('right-a', 'tr', 'right-body-table', ['action-a'], { 'data-row-key': 'u1' }),
        node('action-a', 'td', 'right-a', ['edit-a']),
        node('edit-a', 'button', 'action-a', [], {}, 'Edit'),
        node('right-b', 'tr', 'right-body-table', ['action-b'], { 'data-row-key': 'u2' }),
        node('action-b', 'td', 'right-b', ['edit-b']),
        node('edit-b', 'button', 'action-b', [], {}, 'Edit'),
    ]);

    const table = onlyTable(snapshot);
    assert.deepEqual(table.columns.map((column) => column.name), ['Name', 'Actions']);
    assert.equal(table.body.visibleRows.length, 2);
    assert.equal(table.controlSlots.length, 1);
    assert.equal(table.mirrors.filter((item) => item.partKind === 'fixed-left-body' && item.kind === 'row').length, 2);
    assert.equal(table.mirrors.filter((item) => item.partKind === 'fixed-left-body' && item.kind === 'cell').length, 2);
    assert.equal(table.mirrors.every((item) => item.status === 'resolved'), true);
    assert.equal(snapshot.tables.validation.ok, true, JSON.stringify(snapshot.tables.validation.diagnostics, null, 2));
});

test('cell custom-select popup remains control-owned and is not classified as a portal editor', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table', 'popup']),
        node('table', 'table', 'body', ['thead', 'tbody']),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['status-header']),
        node('status-header', 'th', 'header-row', [], {}, 'Status'),
        node('tbody', 'tbody', 'table', ['row']),
        node('row', 'tr', 'tbody', ['cell']),
        node('cell', 'td', 'row', ['select-trigger']),
        node('select-trigger', 'div', 'cell', [], {
            role: 'combobox',
            'aria-controls': 'status-popup',
            'aria-expanded': 'true',
        }),
        node('popup', 'div', 'body', ['option-a'], { id: 'status-popup', role: 'listbox' }),
        node('option-a', 'div', 'popup', [], { role: 'option', 'aria-selected': 'true' }, 'Active'),
    ]);

    const table = onlyTable(snapshot);
    const cell = Object.values(snapshot.tables.cells)[0];
    assert.equal(table.editors.length, 0);
    assert.equal(cell.controlIds.some((controlId) => snapshot.controls.controls[controlId]?.kind === 'custom_select'), true);
});

test('duplicate canonical row keys make fixed mirror ownership ambiguous instead of falling back by position', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table-root']),
        node('table-root', 'div', 'body', ['header-wrap', 'body-wrap', 'fixed-left'], { class: 'el-table' }),
        node('header-wrap', 'div', 'table-root', ['header-table'], { class: 'el-table__header-wrapper' }),
        node('header-table', 'table', 'header-wrap', ['header-row']),
        node('header-row', 'tr', 'header-table', ['name-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('body-wrap', 'div', 'table-root', ['body-table'], { class: 'el-table__body-wrapper' }),
        node('body-table', 'table', 'body-wrap', ['body-a', 'body-b']),
        node('body-a', 'tr', 'body-table', ['name-a'], { 'data-row-key': 'duplicate' }),
        node('name-a', 'td', 'body-a', [], {}, 'Alice'),
        node('body-b', 'tr', 'body-table', ['name-b'], { 'data-row-key': 'duplicate' }),
        node('name-b', 'td', 'body-b', [], {}, 'Bob'),
        node('fixed-left', 'div', 'table-root', ['left-body-wrap'], { class: 'el-table__fixed' }),
        node('left-body-wrap', 'div', 'fixed-left', ['left-body-table'], { class: 'el-table__fixed-body-wrapper' }),
        node('left-body-table', 'table', 'left-body-wrap', ['left-a']),
        node('left-a', 'tr', 'left-body-table', ['left-name-a'], { 'data-row-key': 'duplicate' }),
        node('left-name-a', 'td', 'left-a', [], {}, 'Alice'),
    ]);

    const table = onlyTable(snapshot);
    const rowMirror = table.mirrors.find((item) => item.partKind === 'fixed-left-body' && item.kind === 'row');
    assert.equal(rowMirror?.status, 'ambiguous');
    assert.equal(rowMirror?.canonicalId, undefined);
    assert.equal(table.status, 'ambiguous');
    assert.equal(table.diagnostics.some((item) => item.code === 'table.mirror.ambiguous'), true);
});

test('duplicate portal editor ids stay ambiguous and never attach either control to the cell', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table', 'editor-a', 'editor-b']),
        node('table', 'table', 'body', ['thead', 'tbody']),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['name-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('tbody', 'tbody', 'table', ['row']),
        node('row', 'tr', 'tbody', ['cell']),
        node('cell', 'td', 'row', [], { 'aria-controls': 'cell-editor' }, 'Alice'),
        node('editor-a', 'div', 'body', ['input-a'], { id: 'cell-editor', role: 'dialog' }),
        node('input-a', 'input', 'editor-a', [], { type: 'text' }),
        node('editor-b', 'div', 'body', ['input-b'], { id: 'cell-editor', role: 'dialog' }),
        node('input-b', 'input', 'editor-b', [], { type: 'text' }),
    ]);

    const table = onlyTable(snapshot);
    const cell = Object.values(snapshot.tables.cells)[0];
    assert.equal(table.editors.length, 1);
    assert.equal(table.editors[0].status, 'ambiguous');
    assert.equal(table.editors[0].controlIds.length, 2);
    assert.equal(cell.controlIds.length, 0);
    assert.equal(table.status, 'ambiguous');
    assert.equal(table.diagnostics.some((item) => item.code === 'table.editor.target.ambiguous'), true);
});

test('body merged cells preserve rowspan and colspan without shifting canonical columns', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table']),
        node('table', 'table', 'body', ['thead', 'tbody']),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['group-header', 'name-header', 'status-header']),
        node('group-header', 'th', 'header-row', [], {}, 'Group'),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('status-header', 'th', 'header-row', [], {}, 'Status'),
        node('tbody', 'tbody', 'table', ['row-a', 'row-b', 'row-c']),
        node('row-a', 'tr', 'tbody', ['group-a', 'name-a', 'status-a']),
        node('group-a', 'td', 'row-a', [], {rowspan: '2'}, 'Admin'),
        node('name-a', 'td', 'row-a', [], {}, 'Alice'),
        node('status-a', 'td', 'row-a', [], {}, 'Active'),
        node('row-b', 'tr', 'tbody', ['name-b', 'status-b']),
        node('name-b', 'td', 'row-b', [], {}, 'Bob'),
        node('status-b', 'td', 'row-b', [], {}, 'Disabled'),
        node('row-c', 'tr', 'tbody', ['summary-c']),
        node('summary-c', 'td', 'row-c', [], {colspan: '3'}, 'Total 2'),
    ]);

    const table = onlyTable(snapshot);
    const cells = Object.values(snapshot.tables.cells);
    const mergedGroup = cells.find((cell) => cell.nodeId === snapshot.observation.captureIdToNodeId['group-a']);
    const mergedSummary = cells.find((cell) => cell.nodeId === snapshot.observation.captureIdToNodeId['summary-c']);
    const nameB = cells.find((cell) => cell.nodeId === snapshot.observation.captureIdToNodeId['name-b']);
    const statusB = cells.find((cell) => cell.nodeId === snapshot.observation.captureIdToNodeId['status-b']);

    assert.equal(mergedGroup?.columnIndex, 0);
    assert.equal(mergedGroup?.rowSpan, 2);
    assert.equal(nameB?.columnIndex, 1);
    assert.equal(statusB?.columnIndex, 2);
    assert.equal(mergedSummary?.columnIndex, 0);
    assert.equal(mergedSummary?.columnSpan, 3);
    assert.equal(table.columns.length, 3);
    assert.equal(snapshot.tables.validation.ok, true, JSON.stringify(snapshot.tables.validation.diagnostics, null, 2));
});

test('expandable rows retain expanded state and hierarchy evidence', () => {
    const snapshot = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table']),
        node('table', 'table', 'body', ['thead', 'tbody'], {role: 'treegrid'}),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['name-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('tbody', 'tbody', 'table', ['parent-row', 'child-row']),
        node('parent-row', 'tr', 'tbody', ['parent-cell'], {'aria-level': '1', 'aria-expanded': 'true'}),
        node('parent-cell', 'td', 'parent-row', [], {}, 'Parent'),
        node('child-row', 'tr', 'tbody', ['child-cell'], {'aria-level': '2'}),
        node('child-cell', 'td', 'child-row', [], {}, 'Child'),
    ]);

    const table = onlyTable(snapshot);
    const parent = table.body.visibleRows.find((row) => row.nodeId === snapshot.observation.captureIdToNodeId['parent-row']);
    const child = table.body.visibleRows.find((row) => row.nodeId === snapshot.observation.captureIdToNodeId['child-row']);
    assert.equal(parent?.expanded, true);
    assert.equal(parent?.level, 1);
    assert.equal(child?.level, 2);
    assert.equal(table.hierarchy?.parentRowIdByRowId[child!.id], parent?.id);
    assert.equal(table.featureCover.coveredFeatures.includes('expanded:true'), true);
});

test('empty and loading tables remain explicit without fabricating canonical rows', () => {
    const empty = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table-root']),
        node('table-root', 'div', 'body', ['table', 'empty-state'], {class: 'ant-table-wrapper'}),
        node('table', 'table', 'table-root', ['thead', 'tbody']),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['name-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('tbody', 'tbody', 'table', []),
        node('empty-state', 'div', 'table-root', [], {class: 'ant-empty', role: 'status'}, 'No data'),
    ]);
    const loading = build([
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table-root']),
        node('table-root', 'div', 'body', ['table', 'spinner'], {class: 'el-table', 'aria-busy': 'true'}),
        node('table', 'table', 'table-root', ['thead', 'tbody']),
        node('thead', 'thead', 'table', ['header-row']),
        node('header-row', 'tr', 'thead', ['name-header']),
        node('name-header', 'th', 'header-row', [], {}, 'Name'),
        node('tbody', 'tbody', 'table', []),
        node('spinner', 'div', 'table-root', [], {class: 'el-loading-mask', role: 'progressbar'}, 'Loading'),
    ]);

    const emptyTable = onlyTable(empty);
    const loadingTable = onlyTable(loading);
    assert.equal(emptyTable.body.visibleRows.length, 0);
    assert.equal(loadingTable.body.visibleRows.length, 0);
    assert.equal(Object.keys(empty.tables.rows).length, 0);
    assert.equal(Object.keys(loading.tables.rows).length, 0);
    assert.equal(emptyTable.body.rowWindow.visibleCount, 0);
    assert.equal(loadingTable.body.rowWindow.visibleCount, 0);
    assert.equal(empty.tables.validation.ok, true);
    assert.equal(loading.tables.validation.ok, true);
});
