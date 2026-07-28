import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import {
    analyzePageObservation,
    buildPageObservation,
    captureRawPage,
    type ObservationFixture,
    type RawPageCapture,
} from '../src/snapshot';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(agentDirectory, '..');
const outputDirectory = path.join(agentDirectory, 'tests/fixtures/observation-v2');
const capturedAt = process.env.SNAPSHOT_FIXTURE_CAPTURED_AT ?? '2026-07-28T08:00:00.000Z';

const browser = await chromium.launch({ headless: true });
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-v2-frameworks-'));
try {
    const element = await buildElementPlusApp(temporaryDirectory);
    const ant = await buildAntDesignApp(temporaryDirectory);
    await captureFixture({
        page: await browser.newPage({ viewport: { width: 1280, height: 800 } }),
        id: 'element-plus-browser',
        category: 'real-framework-browser-capture',
        framework: 'element-plus',
        frameworkVersion: '2.13.7',
        origin: 'package://element-plus@2.13.7',
        outputName: '09-element-plus-browser.v1.json',
        app: element,
        readySelector: '.el-table',
        expectedClass: 'el-table',
    });
    await captureFixture({
        page: await browser.newPage({ viewport: { width: 1280, height: 800 } }),
        id: 'ant-design-browser',
        category: 'real-framework-browser-capture',
        framework: 'ant-design',
        frameworkVersion: '5.29.3',
        origin: 'package://antd@5.29.3',
        outputName: '10-ant-design-browser.v1.json',
        app: ant,
        readySelector: '.ant-table-wrapper',
        expectedClass: 'ant-table-wrapper',
    });
} finally {
    await browser.close();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

type BuiltApp = { script: string; style: string };

type CaptureInput = {
    page: Page;
    id: string;
    category: string;
    framework: 'element-plus' | 'ant-design';
    frameworkVersion: string;
    origin: string;
    outputName: string;
    app: BuiltApp;
    readySelector: string;
    expectedClass: string;
};

async function captureFixture(input: CaptureInput): Promise<void> {
    const browserErrors: string[] = [];
    input.page.on('pageerror', (error) => browserErrors.push(error.message));
    input.page.on('console', (message) => {
        if (message.type() === 'error') {browserErrors.push(message.text());}
    });
    try {
        await input.page.setContent('<!doctype html><html><head></head><body><div id="app"></div></body></html>');
        if (input.app.style) {
            await input.page.addStyleTag({ content: input.app.style });
        }
        await input.page.addScriptTag({ content: input.app.script });
        await input.page.locator(input.readySelector).waitFor({ state: 'visible', timeout: 10000 }).catch((error) => {
            throw new Error(`${input.id} did not mount: ${browserErrors.join(' | ') || String(error)}`);
        });
        await input.page.evaluate(() => new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));

        const raw = await captureRawPage(input.page, {
            captureRuntimeState: true,
            sourceMetadata: {
                framework: input.framework,
                frameworkVersion: input.frameworkVersion,
            },
        });
        try {
            const capture: RawPageCapture = structuredClone(raw.capture);
            capture.metadata.capturedAt = capturedAt;
            const analysis = analyzePageObservation(buildPageObservation(capture));
            if (!analysis.validation.ok) {
                throw new Error(`${input.id} invariant failure: ${analysis.validation.diagnostics.map((item) => item.code).join(', ')}`);
            }
            const classPresent = Object.values(analysis.observation.attributes).some((attributes) =>
                (attributes.class ?? '').split(/\s+/).includes(input.expectedClass));
            if (!classPresent) {
                throw new Error(`${input.id} did not render expected class ${input.expectedClass}`);
            }
            const fixture: ObservationFixture = {
                fixtureVersion: 1,
                id: input.id,
                category: input.category,
                source: {
                    kind: 'browser-capture',
                    framework: input.framework,
                    frameworkVersion: input.frameworkVersion,
                    capturedAt,
                    origin: input.origin,
                },
                truth: {
                    minimumScopeCount: 1,
                    expectedCandidateMinimums: {
                        host: 1,
                        part: 3,
                    },
                    expectedOrphanCount: 0,
                },
                capture,
            };
            const outputPath = path.join(outputDirectory, input.outputName);
            await fs.writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
            console.log(`${outputPath}: ${capture.nodes.length} nodes, ${analysis.relations.edges.length} relations`);
        } finally {
            await raw.cleanup();
        }
    } finally {
        await input.page.close();
    }
}

async function buildElementPlusApp(root: string): Promise<BuiltApp> {
    const appDirectory = path.join(root, 'element-plus');
    await preparePackageLinks(appDirectory, ['vue', 'element-plus']);
    const entry = path.join(appDirectory, 'entry.ts');
    await fs.writeFile(entry, `
        import { createApp, h, ref } from 'vue';
        import {
          ElButton,
          ElForm,
          ElFormItem,
          ElInput,
          ElTable,
          ElTableColumn,
        } from 'element-plus';
        import 'element-plus/dist/index.css';

        const rows = [
          { name: 'Alice', department: 'Platform', status: 'Active', city: 'Tokyo' },
          { name: 'Bob', department: 'Security', status: 'Pending', city: 'Osaka' },
          { name: 'Carol', department: 'Runtime', status: 'Active', city: 'Kyoto' },
        ];
        const App = {
          setup() {
            const query = ref('');
            return () => h('div', { style: 'padding:24px' }, [
              h(ElForm, { inline: true, 'aria-label': 'User filters' }, {
                default: () => [
                  h(ElFormItem, { label: 'Name' }, {
                    default: () => h(ElInput, {
                      modelValue: query.value,
                      'onUpdate:modelValue': (value) => { query.value = value; },
                    }),
                  }),
                  h(ElFormItem, null, {
                    default: () => h(ElButton, { type: 'primary' }, { default: () => 'Search' }),
                  }),
                ],
              }),
              h(ElTable, { data: rows, height: 320, style: 'width:760px' }, {
                default: () => [
                  h(ElTableColumn, { fixed: true, prop: 'name', label: 'Name', width: 160 }),
                  h(ElTableColumn, { prop: 'department', label: 'Department', width: 180 }),
                  h(ElTableColumn, { prop: 'status', label: 'Status', width: 180 }),
                  h(ElTableColumn, { prop: 'city', label: 'City', width: 180 }),
                  h(ElTableColumn, { fixed: 'right', label: 'Actions', width: 140 }, {
                    default: () => h(ElButton, { link: true, type: 'primary' }, { default: () => 'Edit' }),
                  }),
                ],
              }),
            ]);
          },
        };
        createApp(App).mount('#app');
    `, 'utf8');
    return await bundleApp(appDirectory, entry);
}

async function buildAntDesignApp(root: string): Promise<BuiltApp> {
    const appDirectory = path.join(root, 'ant-design');
    await preparePackageLinks(appDirectory, ['react', 'react-dom', 'antd']);
    const entry = path.join(appDirectory, 'entry.tsx');
    await fs.writeFile(entry, `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Button, Form, Input, Table } from 'antd';
        import 'antd/dist/reset.css';

        const rows = [
          { key: '1', name: 'Alice', department: 'Platform', status: 'Active', city: 'Tokyo' },
          { key: '2', name: 'Bob', department: 'Security', status: 'Pending', city: 'Osaka' },
          { key: '3', name: 'Carol', department: 'Runtime', status: 'Active', city: 'Kyoto' },
        ];
        const columns = [
          { title: 'Name', dataIndex: 'name', key: 'name', width: 160, fixed: 'left' },
          { title: 'Department', dataIndex: 'department', key: 'department', width: 180 },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 180 },
          { title: 'City', dataIndex: 'city', key: 'city', width: 180 },
          { title: 'Actions', key: 'actions', width: 140, fixed: 'right', render: () => React.createElement(Button, { type: 'link' }, 'Edit') },
        ];
        const App = () => React.createElement('div', { style: { padding: 24 } },
          React.createElement(Form, { layout: 'inline', 'aria-label': 'User filters' },
            React.createElement(Form.Item, { label: 'Name' }, React.createElement(Input)),
            React.createElement(Form.Item, null, React.createElement(Button, { type: 'primary' }, 'Search')),
          ),
          React.createElement(Table, {
            columns,
            dataSource: rows,
            scroll: { x: 840, y: 260 },
            pagination: { pageSize: 2, total: 3, showSizeChanger: true },
            style: { width: 780, marginTop: 20 },
          }),
        );
        createRoot(document.getElementById('app')!).render(React.createElement(App));
    `, 'utf8');
    return await bundleApp(appDirectory, entry);
}

async function preparePackageLinks(appDirectory: string, packageNames: string[]): Promise<void> {
    const nodeModules = path.join(appDirectory, 'node_modules');
    await fs.mkdir(nodeModules, { recursive: true });
    for (const packageName of packageNames) {
        const packageDirectory = await resolvePnpmPackage(packageName);
        const linkPath = path.join(nodeModules, ...packageName.split('/'));
        await fs.mkdir(path.dirname(linkPath), { recursive: true });
        await fs.symlink(packageDirectory, linkPath, 'dir');
    }
}

async function resolvePnpmPackage(packageName: string): Promise<string> {
    const storeDirectory = path.join(repositoryDirectory, 'node_modules/.pnpm');
    const entries = (await fs.readdir(storeDirectory)).sort();
    for (const entry of entries) {
        const candidate = path.join(storeDirectory, entry, 'node_modules', ...packageName.split('/'));
        try {
            const metadata = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')) as { name?: string };
            if (metadata.name === packageName) {return candidate;}
        } catch {
            // Not this package entry.
        }
    }
    throw new Error(`package ${packageName} is not present in the pnpm store`);
}

async function bundleApp(appDirectory: string, entry: string): Promise<BuiltApp> {
    const outputDirectory = path.join(appDirectory, 'dist');
    await fs.mkdir(outputDirectory, { recursive: true });
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        outdir: outputDirectory,
        write: true,
        metafile: true,
        define: {
            'process.env.NODE_ENV': '"production"',
        },
    });
    const outputs = Object.keys(result.metafile.outputs);
    const scriptPath = outputs.find((item) => item.endsWith('.js'));
    const stylePath = outputs.find((item) => item.endsWith('.css'));
    if (!scriptPath) {throw new Error(`bundle for ${entry} produced no JavaScript`);}
    return {
        script: await fs.readFile(path.resolve(scriptPath), 'utf8'),
        style: stylePath ? await fs.readFile(path.resolve(stylePath), 'utf8') : '',
    };
}
