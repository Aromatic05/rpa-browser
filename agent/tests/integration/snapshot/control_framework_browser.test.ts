import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import { captureControlSnapshot, executeSelectOptionOnPage } from '../../../src/automation/snapshot';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repositoryDirectory = path.resolve(agentDirectory, '..');

test('Element Plus and Ant Design selects execute through exact popup ownership', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-stage2-frameworks-'));
    const browser = await chromium.launch({ headless: true });
    try {
        const elementApp = await buildElementApp(temporaryDirectory);
        const antApp = await buildAntApp(temporaryDirectory);
        const elementPage = await browser.newPage({ viewport: { width: 900, height: 600 } });
        const antPage = await browser.newPage({ viewport: { width: 900, height: 600 } });
        await mount(elementPage, elementApp, '.el-select');
        await mount(antPage, antApp, '.ant-select');

        const elementInitial = await captureControlSnapshot(elementPage);
        const elementNodeId = nodeById(elementInitial, 'ElementSelect');
        const elementControl = controlForNode(elementInitial, elementNodeId, 'custom_select');
        assert.equal(elementControl.status, 'partial');
        const elementResult = await executeSelectOptionOnPage(elementPage, {
            kind: 'custom_select',
            nodeId: elementNodeId,
            values: ['差旅'],
        });
        assert.equal(elementResult.ok, true, elementResult.ok ? undefined : JSON.stringify(elementResult));
        assert.equal((await elementPage.locator('.el-select__placeholder').textContent())?.trim(), '差旅');

        const antInitial = await captureControlSnapshot(antPage);
        const antNodeId = nodeById(antInitial, 'AntSelect');
        const antControl = controlForNode(antInitial, antNodeId, 'custom_select');
        assert.equal(antControl.status, 'partial');
        const antResult = await executeSelectOptionOnPage(antPage, {
            kind: 'custom_select',
            nodeId: antNodeId,
            values: ['Travel'],
        });
        assert.equal(antResult.ok, true, antResult.ok ? undefined : JSON.stringify(antResult));
        assert.equal((await antPage.locator('.ant-select-selection-item').textContent())?.trim(), '差旅');
    } finally {
        await browser.close();
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});

type BuiltApp = { script: string; style: string };

const mount = async (page: Page, app: BuiltApp, readySelector: string) => {
    await page.setContent('<!doctype html><html><head></head><body><div id="app"></div></body></html>');
    if (app.style) await page.addStyleTag({ content: app.style });
    await page.addScriptTag({ content: app.script });
    await page.locator(readySelector).waitFor({ state: 'visible', timeout: 10000 });
};

const nodeById = (snapshot: Awaited<ReturnType<typeof captureControlSnapshot>>, id: string): string => {
    const nodeId = Object.keys(snapshot.observation.nodes).find((candidate) => snapshot.observation.attributes[candidate]?.id === id);
    assert.ok(nodeId, `node ${id} not found`);
    return nodeId;
};

const controlForNode = (
    snapshot: Awaited<ReturnType<typeof captureControlSnapshot>>,
    nodeId: string,
    kind: string,
) => {
    const control = (snapshot.controls.byNodeId[nodeId] ?? [])
        .map((id) => snapshot.controls.controls[id])
        .find((candidate) => candidate?.kind === kind);
    assert.ok(control, `control ${kind} not found for ${nodeId}`);
    return control;
};

const buildElementApp = async (root: string): Promise<BuiltApp> => {
    const directory = path.join(root, 'element');
    await preparePackageLinks(directory, ['vue', 'element-plus']);
    const entry = path.join(directory, 'entry.ts');
    await fs.writeFile(entry, `
      import { createApp, h, ref } from 'vue';
      import { ElOption, ElSelect } from 'element-plus';
      import 'element-plus/dist/index.css';
      const App = { setup() {
        const value = ref('Office');
        return () => h(ElSelect, {
          id: 'ElementSelect', modelValue: value.value,
          'onUpdate:modelValue': (next) => { value.value = next; },
          style: 'width:240px;margin:40px',
        }, { default: () => [
          h(ElOption, { label: '办公用品', value: 'Office' }),
          h(ElOption, { label: '差旅', value: 'Travel' }),
        ]});
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
      import { Select } from 'antd';
      import 'antd/dist/reset.css';
      const App = () => React.createElement(Select, {
        id: 'AntSelect', defaultValue: 'Office', style: { width: 240, margin: 40 },
        options: [
          { label: '办公用品', value: 'Office' },
          { label: '差旅', value: 'Travel' },
        ],
      });
      createRoot(document.getElementById('app')!).render(React.createElement(App));
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
        await fs.symlink(packageDirectory, link, process.platform === 'win32' ? 'junction' : 'dir');
    }
};

const resolvePnpmPackage = async (packageName: string): Promise<string> => {
    const store = path.join(repositoryDirectory, 'node_modules/.pnpm');
    for (const entry of (await fs.readdir(store)).sort()) {
        const candidate = path.join(store, entry, 'node_modules', ...packageName.split('/'));
        try {
            const metadata = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')) as { name?: string };
            if (metadata.name === packageName) return candidate;
        } catch {
            // Continue.
        }
    }
    throw new Error(`package not found: ${packageName}`);
};

const bundle = async (directory: string, entry: string): Promise<BuiltApp> => {
    const outputDirectory = path.join(directory, 'dist');
    const result = await build({
        entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser',
        outdir: outputDirectory, write: true, metafile: true,
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
