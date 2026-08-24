import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import { captureFormSnapshot } from '../../../src/automation/snapshot';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repositoryDirectory = path.resolve(agentDirectory, '..');

test('Element Plus and Ant Design real forms assemble composite fields, list fields and dialog boundaries', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-stage3-frameworks-'));
    const browser = await chromium.launch({ headless: true });
    try {
        const elementPage = await browser.newPage({ viewport: { width: 1100, height: 800 } });
        const antPage = await browser.newPage({ viewport: { width: 1100, height: 800 } });
        await mount(elementPage, await buildElementApp(temporaryDirectory), '.el-form');
        await mount(antPage, await buildAntApp(temporaryDirectory), '.ant-modal');

        const element = await captureFormSnapshot(elementPage);
        const elementForms = Object.values(element.forms.forms);
        const elementFields = Object.values(element.forms.fields);
        assert.equal(elementForms.length, 1);
        assert.equal(elementFields.length, 2);
        assert.equal(elementFields.filter((field) => field.controlIds.length > 1).length, 1);
        assert.equal(elementFields.filter((field) => field.required).length, 1);
        assert.deepEqual(elementFields.map((field) => field.labelNodeIds.map((id) => element.observation.text[id])), [['Name'], ['Period']]);
        assert.equal(Object.keys(element.forms.actions).length, 9);
        assert.deepEqual(elementForms[0].actions.map((action) => action.structuralRole), ['submit']);
        assert.equal(element.forms.residualActionIds.length, 8);
        assert.equal(element.forms.residualFieldIds.length, 0);
        assert.equal(elementForms[0].evidence.some((item) => item.code === 'form.boundary.adapter.element-form'), true);
        assert.equal(element.forms.validation.ok, true);

        const ant = await captureFormSnapshot(antPage);
        const antForms = Object.values(ant.forms.forms);
        const antFields = Object.values(ant.forms.fields);
        assert.equal(antForms.length, 1);
        assert.equal(antFields.length, 4);
        assert.equal(antFields.filter((field) => field.controlIds.length > 1).length, 1);
        assert.equal(antFields.filter((field) => field.required).length, 1);
        assert.deepEqual(antFields.map((field) => field.labelNodeIds.map((id) => ant.observation.text[id])), [['Buyer'], ['Period'], ['Contact'], ['Contact']]);
        assert.equal(Object.keys(ant.forms.actions).length, 3);
        assert.deepEqual(antForms[0].actions.map((action) => action.structuralRole), ['submit', 'button']);
        assert.equal(ant.forms.residualActionIds.length, 1);
        assert.equal(ant.forms.residualFieldIds.length, 0);
        assert.equal(antForms[0].location.hostNodeId !== undefined, true, 'active dialog should be retained as host boundary');
        assert.equal(antForms[0].evidence.some((item) => item.code === 'form.boundary.adapter.ant-form'), true);
        assert.equal(ant.forms.validation.ok, true);
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
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
};

const buildElementApp = async (root: string): Promise<BuiltApp> => {
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
};

const buildAntApp = async (root: string): Promise<BuiltApp> => {
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
