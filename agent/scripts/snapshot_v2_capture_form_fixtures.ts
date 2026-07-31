import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import {
    captureRawPage,
    type FormFixture,
    type FormFixtureTruth,
    type RawPageCapture,
} from '../src/snapshot';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(agentDirectory, '..');
const outputDirectory = path.join(agentDirectory, 'tests/fixtures/form-v2');
const capturedAt = process.env.SNAPSHOT_FIXTURE_CAPTURED_AT ?? '2026-07-28T10:00:00.000Z';
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-v2-form-fixtures-'));
const browser = await chromium.launch({ headless: true });

try {
    await fs.mkdir(outputDirectory, { recursive: true });
    await captureBundledFixture({
        page: await browser.newPage({ viewport: { width: 1100, height: 800 } }),
        id: 'element-plus-create-form',
        category: 'real-framework-create-form-composite',
        framework: 'element-plus',
        frameworkVersion: '2.13.7',
        origin: 'package://element-plus@2.13.7',
        outputName: '01-element-plus-create-form.v1.json',
        app: await buildElementApp(temporaryDirectory),
        readySelector: '.el-form',
        truth: {
            minimumFormCount: 1,
            minimumFieldCount: 2,
            minimumCompositeFieldCount: 1,
            expectedBoundaryKinds: ['explicit-form'],
        },
    });
    await captureBundledFixture({
        page: await browser.newPage({ viewport: { width: 1100, height: 800 } }),
        id: 'ant-design-dialog-form-list',
        category: 'real-framework-dialog-form-list-composite',
        framework: 'ant-design',
        frameworkVersion: '5.29.3',
        origin: 'package://antd@5.29.3',
        outputName: '02-ant-design-dialog-form-list.v1.json',
        app: await buildAntApp(temporaryDirectory),
        readySelector: '.ant-modal .ant-form',
        truth: {
            minimumFormCount: 1,
            minimumFieldCount: 4,
            minimumCompositeFieldCount: 1,
            expectedBoundaryKinds: ['explicit-form'],
            requireDialogHost: true,
        },
    });
    await captureNativeUtilityFixture(await browser.newPage({ viewport: { width: 1100, height: 800 } }));
    await captureDataTablesFixture(await browser.newPage({ viewport: { width: 1280, height: 900 } }));
} finally {
    await browser.close();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

type BuiltApp = { script: string; style: string };
type CaptureBundledInput = {
    page: Page;
    id: string;
    category: string;
    framework: 'element-plus' | 'ant-design';
    frameworkVersion: string;
    origin: string;
    outputName: string;
    app: BuiltApp;
    readySelector: string;
    truth: FormFixtureTruth;
};

async function captureBundledFixture(input: CaptureBundledInput): Promise<void> {
    try {
        await input.page.setContent('<!doctype html><html><head></head><body><div id="app"></div></body></html>');
        if (input.app.style) await input.page.addStyleTag({ content: input.app.style });
        await input.page.addScriptTag({ content: input.app.script });
        await input.page.locator(input.readySelector).waitFor({ state: 'visible', timeout: 10000 });
        await settle(input.page);
        await writeFixture(input.page, {
            id: input.id,
            category: input.category,
            framework: input.framework,
            frameworkVersion: input.frameworkVersion,
            origin: input.origin,
            outputName: input.outputName,
            truth: input.truth,
        });
    } finally {
        await input.page.close();
    }
}

async function captureNativeUtilityFixture(page: Page): Promise<void> {
    try {
        await page.setContent(`<!doctype html><html><body>
          <main>
            <form id="profile-form" aria-label="Profile form">
              <label for="profile-name">Name</label>
              <input id="profile-name" type="text">
              <button type="submit">Save</button>
            </form>
            <section class="dt-container" aria-label="Orders table utilities">
              <div class="dt-search"><label for="dt-search">Search table</label><input id="dt-search" type="search"></div>
              <div class="dt-length"><label for="dt-length">Page size</label><select id="dt-length"><option value="10">10</option><option value="25">25</option></select></div>
              <table><thead><tr><th>Order</th></tr></thead><tbody><tr><td>SO-001</td></tr></tbody></table>
            </section>
            <nav aria-label="Document tools"><button type="button">Print document</button></nav>
          </main>
        </body></html>`);
        await settle(page);
        await writeFixture(page, {
            id: 'native-utility-controls',
            category: 'browser-native-datatables-signature-and-document-utility',
            framework: 'native',
            frameworkVersion: 'html-2026',
            origin: 'inline://native-datatables-dom-signature',
            outputName: '03-native-utility-controls.v1.json',
            truth: {
                minimumFormCount: 1,
                minimumFieldCount: 3,
                minimumResidualFieldCount: 2,
                expectedBoundaryKinds: ['explicit-form'],
            },
        });
    } finally {
        await page.close();
    }
}


async function captureDataTablesFixture(page: Page): Promise<void> {
    try {
        await page.goto('https://datatables.net/examples/basic_init/zero_configuration.html', {
            waitUntil: 'networkidle',
            timeout: 30000,
        });
        await page.locator('.dt-search input').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('.dt-length select').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('table.dataTable').waitFor({ state: 'visible', timeout: 10000 });
        await settle(page);
        const frameworkVersion = await page.evaluate(() => {
            const scope = globalThis as typeof globalThis & {
                DataTable?: { version?: string };
                jQuery?: { fn?: { dataTable?: { version?: string } } };
            };
            return scope.DataTable?.version ?? scope.jQuery?.fn?.dataTable?.version ?? 'unknown';
        });
        await writeFixture(page, {
            id: 'datatables-official-zero-configuration',
            category: 'real-datatables-toolbar-utility-controls',
            framework: 'datatables',
            frameworkVersion,
            origin: page.url(),
            outputName: '04-datatables-official-zero-configuration.v1.json',
            truth: {
                minimumFormCount: 1,
                minimumFieldCount: 3,
                minimumResidualFieldCount: 2,
                expectedBoundaryKinds: ['explicit-form'],
            },
        });
    } finally {
        await page.close();
    }
}

async function writeFixture(page: Page, input: {
    id: string;
    category: string;
    framework: FormFixture['source']['framework'];
    frameworkVersion: string;
    origin: string;
    outputName: string;
    truth: FormFixtureTruth;
}): Promise<void> {
    const captured = await captureRawPage(page, {
        captureRuntimeState: true,
        sourceMetadata: { framework: input.framework, frameworkVersion: input.frameworkVersion },
    });
    try {
        const capture: RawPageCapture = structuredClone(captured.capture);
        capture.metadata.capturedAt = capturedAt;
        const fixture: FormFixture = {
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
            truth: input.truth,
            capture,
        };
        const outputPath = path.join(outputDirectory, input.outputName);
        await fs.writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
        console.log(`${outputPath}: ${capture.nodes.length} nodes`);
    } finally {
        await captured.cleanup();
    }
}

async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function buildElementApp(root: string): Promise<BuiltApp> {
    const directory = path.join(root, 'element');
    await preparePackageLinks(directory, ['vue', 'element-plus']);
    const entry = path.join(directory, 'entry.ts');
    await fs.writeFile(entry, `
      import { createApp, h, ref } from 'vue';
      import { ElButton, ElDatePicker, ElForm, ElFormItem, ElInput } from 'element-plus';
      import 'element-plus/dist/index.css';
      const App = { setup() {
        const name = ref(''); const period = ref([]);
        return () => h(ElForm, { 'aria-label': 'Create user', style: 'padding:32px;width:700px' }, {
          default: () => [
            h(ElFormItem, { label: 'Name', required: true }, { default: () => h(ElInput, { modelValue: name.value, 'onUpdate:modelValue': (v) => name.value = v }) }),
            h(ElFormItem, { label: 'Period' }, { default: () => h(ElDatePicker, { type: 'daterange', modelValue: period.value, 'onUpdate:modelValue': (v) => period.value = v }) }),
            h(ElFormItem, null, { default: () => h(ElButton, { type: 'primary', nativeType: 'submit' }, { default: () => 'Save' }) }),
          ],
        });
      }};
      createApp(App).mount('#app');
    `);
    return bundle(directory, entry);
}

async function buildAntApp(root: string): Promise<BuiltApp> {
    const directory = path.join(root, 'ant');
    await preparePackageLinks(directory, ['react', 'react-dom', 'antd']);
    const entry = path.join(directory, 'entry.tsx');
    await fs.writeFile(entry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Button, DatePicker, Form, Input, Modal, Space } from 'antd';
      import 'antd/dist/reset.css';
      const App = () => React.createElement(Modal, { open: true, title: 'Create order', footer: null, getContainer: false },
        React.createElement(Form, { name: 'order-form', layout: 'vertical' },
          React.createElement(Form.Item, { name: 'buyer', label: 'Buyer', required: true }, React.createElement(Input)),
          React.createElement(Form.Item, { name: 'period', label: 'Period' }, React.createElement(DatePicker.RangePicker)),
          React.createElement(Form.List, { name: 'contacts', initialValue: [{ name: 'Alice' }, { name: 'Bob' }] },
            (fields) => React.createElement(React.Fragment, null, ...fields.map((field) =>
              React.createElement(Form.Item, { key: field.key, name: [field.name, 'name'], label: 'Contact' }, React.createElement(Input))
            ))
          ),
          React.createElement(Form.Item, null, React.createElement(Space, null,
            React.createElement(Button, { htmlType: 'submit', type: 'primary' }, 'Save'),
            React.createElement(Button, null, 'Cancel')
          ))
        )
      );
      createRoot(document.getElementById('app')).render(React.createElement(App));
    `);
    return bundle(directory, entry);
}

async function preparePackageLinks(directory: string, packageNames: string[]): Promise<void> {
    const nodeModules = path.join(directory, 'node_modules');
    await fs.mkdir(nodeModules, { recursive: true });
    for (const packageName of packageNames) {
        const packageDirectory = await resolvePnpmPackage(packageName);
        const link = path.join(nodeModules, ...packageName.split('/'));
        await fs.mkdir(path.dirname(link), { recursive: true });
        await fs.symlink(packageDirectory, link, 'dir');
    }
}

async function resolvePnpmPackage(packageName: string): Promise<string> {
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
}

async function bundle(directory: string, entry: string): Promise<BuiltApp> {
    const outputDirectory = path.join(directory, 'dist');
    const result = await build({
        entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser',
        outdir: outputDirectory, write: true, metafile: true,
        define: { 'process.env.NODE_ENV': '"production"' },
    });
    const outputs = Object.keys(result.metafile.outputs);
    const script = outputs.find((item) => item.endsWith('.js'));
    const style = outputs.find((item) => item.endsWith('.css'));
    if (!script) throw new Error(`bundle produced no JavaScript: ${entry}`);
    return {
        script: await fs.readFile(path.resolve(script), 'utf8'),
        style: style ? await fs.readFile(path.resolve(style), 'utf8') : '',
    };
}
