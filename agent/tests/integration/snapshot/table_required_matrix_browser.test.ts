import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium, type Page} from 'playwright';
import {captureTableSnapshot, type TableComponent, type TableSnapshot} from '../../../src/snapshot';

const capture = async (page: Page, body: string): Promise<TableSnapshot> => {
    await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
    return await captureTableSnapshot(page);
};

const tableByRootId = (snapshot: TableSnapshot, id: string): TableComponent => {
    const table = Object.values(snapshot.tables.tables).find((candidate) =>
        snapshot.observation.attributes[candidate.location.structuralRootNodeId]?.id === id);
    assert.ok(table, `table root not found: ${id}`);
    return table;
};

test('real clone-based fixed table keeps one logical root and bounds repeated link slots', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage({viewport: {width: 1200, height: 800}});
        const links = Array.from({length: 12}, (_, index) => `<a href="#item-${index}">Item ${index}</a>`).join('');
        const snapshot = await capture(page, `
          <section id="orders-host" role="table" aria-label="Orders card">
            <div id="orders" class="el-table">
              <div class="el-table__header-wrapper"><table><thead><tr><th>Name</th><th>Links</th></tr></thead></table></div>
              <div class="el-table__body-wrapper"><table><tbody>
                <tr data-row-key="a"><td>Alice</td><td>${links}</td></tr>
                <tr data-row-key="b"><td>Bob</td><td>${links}</td></tr>
              </tbody></table></div>
              <div class="el-table__fixed">
                <div class="el-table__fixed-header-wrapper"><table><thead><tr><th>Name</th></tr></thead></table></div>
                <div class="el-table__fixed-body-wrapper"><table><tbody>
                  <tr data-row-key="a"><td>Alice</td></tr><tr data-row-key="b"><td>Bob</td></tr>
                </tbody></table></div>
              </div>
              <div class="el-table__fixed-right">
                <div class="el-table__fixed-right-header-wrapper"><table><thead><tr><th>Actions</th></tr></thead></table></div>
                <div class="el-table__fixed-right-body-wrapper"><table><tbody>
                  <tr data-row-key="a"><td><button>Edit</button></td></tr>
                  <tr data-row-key="b"><td><button>Edit</button></td></tr>
                </tbody></table></div>
              </div>
            </div>
          </section>
        `);

        const tables = Object.values(snapshot.tables.tables);
        assert.equal(tables.length, 1, 'outer role=table host must not become a duplicate logical table');
        const table = tableByRootId(snapshot, 'orders');
        assert.equal(snapshot.observation.attributes[table.location.hostNodeId ?? '']?.id, 'orders-host');
        assert.equal(table.body.visibleRows.length, 2);
        assert.equal(table.mirrors.filter((mirror) => mirror.partKind === 'fixed-left-body' && mirror.kind === 'row').length, 2);
        assert.equal(table.mirrors.every((mirror) => mirror.status === 'resolved'), true);
        assert.ok(table.controlSlots.length <= 5, `control slots grew with link count: ${table.controlSlots.length}`);
        assert.equal(table.controlSlots.reduce((sum, slot) => sum + slot.occurrenceCount, 0), 26);
        assert.equal(snapshot.tables.validation.ok, true, JSON.stringify(snapshot.tables.validation.diagnostics, null, 2));
    } finally {
        await browser.close();
    }
});

test('real browser preserves merged, nested, hierarchy, virtual, loading and empty table facts', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage({viewport: {width: 1400, height: 1200}});
        const snapshot = await capture(page, `
          <table id="merged">
            <thead><tr><th rowspan="2">Group</th><th colspan="2">Details</th></tr><tr><th>Name</th><th>Status</th></tr></thead>
            <tbody>
              <tr><td rowspan="2">A</td><td>Alice</td><td>Open</td></tr>
              <tr><td>Bob</td><td>Closed</td></tr>
              <tr><td colspan="3">Summary</td></tr>
            </tbody>
          </table>
          <table id="outer"><tbody><tr><td>Outer<table id="inner"><tbody><tr><td>Inner</td></tr></tbody></table></td></tr></tbody></table>
          <div id="tree-unknown" role="treegrid"><div role="row"><div role="columnheader">Name</div></div><div role="row"><div role="gridcell">Root</div></div></div>
          <div id="virtual" role="grid" aria-rowcount="100"><div role="row"><div role="columnheader">Name</div></div><div role="row"><div role="gridcell">A</div></div><div role="row"><div role="gridcell">B</div></div></div>
          <div id="empty" class="ant-table-wrapper"><table><thead><tr><th>Name</th></tr></thead><tbody></tbody></table><div class="ant-empty" role="status">No data</div></div>
          <div id="loading" class="el-table"><div class="el-table__header-wrapper"><table><thead><tr><th>Name</th></tr></thead></table></div><div class="el-table__body-wrapper"><table><tbody></tbody></table></div><div class="el-loading-mask" role="progressbar">Loading</div></div>
        `);

        const merged = tableByRootId(snapshot, 'merged');
        assert.equal(merged.header.rowCount, 2);
        assert.deepEqual(merged.columns.map((column) => column.name), ['Group', 'Details / Name', 'Details / Status']);
        const mergedCells = merged.body.visibleRows.flatMap((row) => row.cellIds.map((cellId) => snapshot.tables.cells[cellId]));
        assert.equal(mergedCells.some((cell) => cell.rowSpan === 2), true);
        assert.equal(mergedCells.some((cell) => cell.columnSpan === 3), true);

        assert.equal(tableByRootId(snapshot, 'outer').body.visibleRows.length, 1);
        assert.equal(tableByRootId(snapshot, 'inner').body.visibleRows.length, 1);
        assert.equal(tableByRootId(snapshot, 'tree-unknown').hierarchy?.source, 'unknown');

        const virtual = tableByRootId(snapshot, 'virtual');
        assert.equal(virtual.body.visibleRows.length, 2);
        assert.equal(virtual.body.rowWindow.totalCount, 100);
        assert.equal(virtual.body.rowWindow.completeness, 'partial');

        assert.equal(tableByRootId(snapshot, 'empty').body.visibleRows.length, 0);
        assert.equal(tableByRootId(snapshot, 'loading').body.visibleRows.length, 0);
        assert.equal(snapshot.tables.validation.ok, true, JSON.stringify(snapshot.tables.validation.diagnostics, null, 2));
    } finally {
        await browser.close();
    }
});

test('real sibling pagination remains ambiguous for two logical tables', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        const snapshot = await capture(page, `
          <section id="shared-card">
            <div id="orders-a" class="el-table"><div class="el-table__body-wrapper"><table><tbody><tr><td>A</td></tr></tbody></table></div></div>
            <div id="orders-b" class="el-table"><div class="el-table__body-wrapper"><table><tbody><tr><td>B</td></tr></tbody></table></div></div>
            <nav class="el-pagination" aria-label="Pagination"><button>1</button><button>2</button></nav>
          </section>
        `);
        const tables = [tableByRootId(snapshot, 'orders-a'), tableByRootId(snapshot, 'orders-b')];
        assert.equal(tables.every((table) => table.pagination?.status === 'ambiguous'), true);
        assert.equal(tables.every((table) => table.status === 'ambiguous'), true);
        assert.equal(tables.every((table) => table.diagnostics.some((item) => item.code === 'table.pagination.ambiguous-owner')), true);
    } finally {
        await browser.close();
    }
});


test('real responsive table excludes hidden columns and preserves row selection', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        const snapshot = await capture(page, `
          <table id="responsive">
            <thead><tr><th>Name</th><th style="display:none">Email</th></tr></thead>
            <tbody>
              <tr aria-selected="true"><td>Alice</td><td style="display:none">alice@example.test</td></tr>
              <tr aria-selected="false"><td>Bob</td><td style="display:none">bob@example.test</td></tr>
            </tbody>
          </table>
        `);
        const table = tableByRootId(snapshot, 'responsive');
        assert.deepEqual(table.columns.map((column) => column.name), ['Name']);
        assert.deepEqual(table.body.visibleRows.map((row) => row.selected), [true, false]);
        assert.deepEqual(table.body.visibleRows.map((row) => row.cellIds.length), [1, 1]);
        assert.equal(Object.values(snapshot.tables.cells).some((cell) => cell.text.includes('@')), false);
    } finally {
        await browser.close();
    }
});
