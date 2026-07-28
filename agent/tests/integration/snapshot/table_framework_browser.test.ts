import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import { captureTableSnapshot } from '../../../src/snapshot';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repositoryDirectory = path.resolve(agentDirectory, '..');

test('real Element and Ant tables assemble logical components instead of physical table fragments', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-stage4-frameworks-'));
    const browser = await chromium.launch({ headless: true });
    try {
        const elementPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const antPage = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        await mount(elementPage, await buildElementApp(temporaryDirectory), '.el-table');
        await mount(antPage, await buildAntApp(temporaryDirectory), '.ant-table-wrapper');

        const elementLogicalCount = await elementPage.locator('.el-table').count();
        const elementPhysicalCount = await elementPage.locator('table').count();
        assert.equal(elementLogicalCount, 23);
        assert.ok(elementPhysicalCount > elementLogicalCount);

        const element = await captureTableSnapshot(elementPage);
        const elementTables = Object.values(element.tables.tables);
        assert.equal(elementTables.length, 23);
        assert.equal(elementTables.reduce((sum, table) => sum + table.body.visibleRows.length, 0), 46);
        assert.equal(elementTables.every((table) => table.columns.length === 2), true);
        assert.equal(elementTables.every((table) => table.controlSlots.length === 1), true);
        assert.equal(elementTables.every((table) => table.footer?.rowNodeIds.length === 1), true);
        assert.equal(element.tables.validation.ok, true, JSON.stringify(element.tables.validation.diagnostics, null, 2));

        const ant = await captureTableSnapshot(antPage);
        const antTables = Object.values(ant.tables.tables);
        assert.equal(antTables.length, 1);
        assert.equal(antTables[0].body.visibleRows.length, 1);
        assert.equal(antTables[0].body.rowWindow.visibleCount, 1);
        assert.deepEqual(antTables[0].columns.map((column) => column.name), ['Name', 'Actions']);
        assert.equal(antTables[0].footer?.rowNodeIds.length, 1);
        assert.equal(antTables[0].pagination?.status, 'resolved');
        assert.equal(antTables[0].pagination?.nodeIds.length, 2);
        assert.equal(ant.tables.validation.ok, true, JSON.stringify(ant.tables.validation.diagnostics, null, 2));
    } finally {
        await browser.close();
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});

type BuiltApp = { script: string; style: string };

const mount = async (page: Page, app: BuiltApp, readySelector: string) => {
    await page.setContent('<!doctype html><html><head></head><body><div id="app"></div></body></html>');
    if (app.style) {await page.addStyleTag({ content: app.style });}
    await page.addScriptTag({ content: app.script });
    await page.locator(readySelector).first().waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

const buildElementApp = async (root: string): Promise<BuiltApp> => {
    const directory = path.join(root, 'element');
    await preparePackageLinks(directory, ['vue', 'element-plus']);
    const entry = path.join(directory, 'entry.ts');
    await fs.writeFile(entry, `
      import { createApp, h } from 'vue';
      import { ElButton, ElTable, ElTableColumn } from 'element-plus';
      import 'element-plus/dist/index.css';
      const rows = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }];
      const App = { render() {
        return h('main', { style: 'padding:16px;width:1000px' }, Array.from({ length: 23 }, (_, index) =>
          h('section', { key: index, style: 'margin-bottom:20px' }, [
            h(ElTable, { data: rows, rowKey: 'id', showSummary: true, border: true }, {
              default: () => [
                h(ElTableColumn, { prop: 'name', label: 'Name' }),
                h(ElTableColumn, { label: 'Actions', fixed: 'right', width: 120 }, {
                  default: () => h(ElButton, { size: 'small' }, { default: () => 'Edit' }),
                }),
              ],
            }),
          ])
        ));
      }};
      createApp(App).mount('#app');
    `);
    return bundle(directory, entry);
};

const buildAntApp = async (root: string): Promise<BuiltApp> => {
    const directory = path.join(root, 'ant');
    await preparePackageLinks(directory, ['react', 'react-dom', 'antd']);
    const entry = path.join(directory, 'entry.tsx');
    await fs.writeFile(entry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Button, Card, Table } from 'antd';
      import 'antd/dist/reset.css';
      const data = [{ key: 'a', name: 'Alice' }, { key: 'b', name: 'Bob' }];
      const columns = [
        { title: 'Name', dataIndex: 'name', key: 'name' },
        { title: 'Actions', key: 'actions', fixed: 'right', width: 120, render: () => React.createElement(Button, null, 'Edit') },
      ];
      const summary = () => React.createElement(Table.Summary, null,
        React.createElement(Table.Summary.Row, null,
          React.createElement(Table.Summary.Cell, { index: 0, colSpan: 2 }, 'Total 2')
        )
      );
      const App = () => React.createElement(Card, { title: 'Orders', style: { margin: 24 } },
        React.createElement(Table, {
          columns, dataSource: data, rowKey: 'key', sticky: true, scroll: { x: 700 }, summary,
          pagination: { pageSize: 1, total: 2, position: ['topRight', 'bottomRight'] },
        })
      );
      createRoot(document.getElementById('app')).render(React.createElement(App));
    `);
    return bundle(directory, entry);
};

const preparePackageLinks = async (directory: string, packageNames: string[]) => {
    const nodeModules = path.join(directory, 'node_modules');
    await fs.mkdir(nodeModules, { recursive: true });
    for (const packageName of packageNames) {
        const packageDirectory = await resolvePnpmPackage(packageName);
        const link = path.join(nodeModules, ...packageName.split('/'));
        await fs.mkdir(path.dirname(link), { recursive: true });
        await fs.symlink(packageDirectory, link, 'dir');
    }
};

const resolvePnpmPackage = async (packageName: string): Promise<string> => {
    const store = path.join(repositoryDirectory, 'node_modules/.pnpm');
    for (const entry of (await fs.readdir(store)).sort()) {
        const candidate = path.join(store, entry, 'node_modules', ...packageName.split('/'));
        try {
            const metadata = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')) as { name?: string };
            if (metadata.name === packageName) {return candidate;}
        } catch {
            // Continue searching the pnpm virtual store.
        }
    }
    throw new Error(`package not found: ${packageName}`);
};

const bundle = async (directory: string, entry: string): Promise<BuiltApp> => {
    const outputDirectory = path.join(directory, 'dist');
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        outdir: outputDirectory,
        write: true,
        metafile: true,
        define: { 'process.env.NODE_ENV': '"production"' },
    });
    const outputs = Object.keys(result.metafile.outputs);
    const script = outputs.find((item) => item.endsWith('.js'));
    const style = outputs.find((item) => item.endsWith('.css'));
    assert.ok(script);
    return {
        script: await fs.readFile(path.resolve(script), 'utf8'),
        style: style ? await fs.readFile(path.resolve(style), 'utf8') : '',
    };
};
