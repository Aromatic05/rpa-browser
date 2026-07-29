import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium, type Page} from 'playwright';
import {createRunnerAnnotatorController} from '../../../src/runner/annotator';
import {createEntityRulesRuntime} from '../../../src/snapshot/rules/runtime';
import type {Action} from '../../../src/actions/action_protocol';
import type {Workflow} from '../../../src/workflow';
import type {
    AnnotatorPickReply,
    AnnotatorProjection,
    AnnotatorProjectionReply,
} from '../../../../shared/annotator-contract/index.js';
import {completeRunStepsDeps} from '../../helpers/run_steps_workspace';
import {buildFrameworkApp, mountFrameworkApp} from '../../helpers/framework_app';

const workflow: Workflow = {
    name: 'ws-1',
    save: (artifact) => artifact,
    get: () => null,
    list: () => [],
    delete: () => false,
};

const invoke = async (
    runtime: ReturnType<typeof createEntityRulesRuntime>,
    type: string,
    payload?: Record<string, unknown>,
) => await runtime.handle({
    action: {
        v: 1,
        id: crypto.randomUUID(),
        type,
        workspaceName: 'ws-1',
        payload,
    } satisfies Action,
    workspace: {name: 'ws-1', workflow} as never,
    workspaceRegistry: {} as never,
});

test('real Element Plus and Ant Design pages expose canonical annotator form table action and dialog targets', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'annotator-frameworks-'));
    const browser = await chromium.launch({headless: true});
    try {
        const elementPage = await browser.newPage({viewport: {width: 1280, height: 900}});
        const antPage = await browser.newPage({viewport: {width: 1280, height: 900}});
        await mountFrameworkApp(
            elementPage,
            await buildFrameworkApp({
                root: temporaryDirectory,
                name: 'element',
                packages: ['vue', 'element-plus'],
                extension: 'ts',
                source: elementSource,
            }),
            ['.el-form', '.el-table'],
        );
        await mountFrameworkApp(
            antPage,
            await buildFrameworkApp({
                root: temporaryDirectory,
                name: 'ant',
                packages: ['react', 'react-dom', 'antd'],
                source: antSource,
            }),
            ['.ant-modal', '.ant-form', '.ant-table-wrapper'],
        );

        await assertFrameworkProjection(elementPage, {requiresDialogHost: false});
        await assertFrameworkProjection(antPage, {requiresDialogHost: true});
    } finally {
        await browser.close();
        await fs.rm(temporaryDirectory, {recursive: true, force: true});
    }
});

const assertFrameworkProjection = async (
    page: Page,
    options: {requiresDialogHost: boolean},
): Promise<void> => {
    const deps = completeRunStepsDeps({pluginHost: {} as never}, {workspaceName: 'ws-1', page});
    const runtime = createEntityRulesRuntime({
        annotator: createRunnerAnnotatorController({runStepsDeps: deps}),
    });
    const opened = await invoke(runtime, 'entity_rules.annotator.open');
    const projection = (opened.reply.payload as AnnotatorProjectionReply).projection;

    assert.ok(projection.components.some((component) => component.domain === 'form'));
    assert.ok(projection.components.some((component) => component.domain === 'table'));
    assertTarget(projection, 'field', 'form', 'Buyer');
    assertTarget(projection, 'action', 'form', 'Save');
    const tableAction = assertTarget(projection, 'action', 'table', 'Edit');
    assert.ok(tableAction.geometry.every((rect) => rect.width > 0 && rect.height > 0));
    if (options.requiresDialogHost) {
        assert.ok(projection.targets.some((target) =>
            target.kind === 'host'
            && target.domain === 'form'
            && target.geometry.length > 0));
    }

    const rect = tableAction.geometry[0];
    const pickedResult = await invoke(runtime, 'entity_rules.annotator.pick', {
        point: {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2},
    });
    const picked = pickedResult.reply.payload as AnnotatorPickReply;
    assert.equal(picked.picked.status, 'resolved');
    assert.equal(picked.projection.selection.status, 'resolved');

    const recognizedResult = await invoke(runtime, 'entity_rules.annotator.recognize');
    const recognized = recognizedResult.reply.payload as AnnotatorProjectionReply;
    assert.equal(recognized.projection.selection.status, 'resolved');
};

const assertTarget = (
    projection: AnnotatorProjection,
    kind: 'field' | 'action',
    domain: 'form' | 'table',
    label: string,
) => {
    const target = projection.targets.find((candidate) =>
        candidate.kind === kind
        && candidate.domain === domain
        && candidate.label?.includes(label)
        && candidate.geometry.length > 0);
    assert.ok(target, `${domain} ${kind} target ${label} must exist with geometry`);
    return target;
};

const elementSource = `
import {createApp, h, ref} from 'vue';
import {ElButton, ElForm, ElFormItem, ElInput, ElTable, ElTableColumn} from 'element-plus';
import 'element-plus/dist/index.css';
const rows = [{id: 'a', name: 'Alice'}, {id: 'b', name: 'Bob'}];
const App = {setup() {
    const buyer = ref('');
    return () => h('main', {style: 'padding:24px;width:980px'}, [
        h(ElForm, {'aria-label': 'Create order', style: 'margin-bottom:24px'}, {
            default: () => [
                h(ElFormItem, {label: 'Buyer', required: true}, {
                    default: () => h(ElInput, {modelValue: buyer.value, 'onUpdate:modelValue': (value) => buyer.value = value}),
                }),
                h(ElFormItem, null, {
                    default: () => h(ElButton, {type: 'primary', nativeType: 'submit'}, {default: () => 'Save'}),
                }),
            ],
        }),
        h(ElTable, {data: rows, rowKey: 'id', border: true}, {
            default: () => [
                h(ElTableColumn, {prop: 'name', label: 'Name', fixed: 'left', width: 220}),
                h(ElTableColumn, {label: 'Actions', fixed: 'right', width: 140}, {
                    default: () => h(ElButton, {size: 'small'}, {default: () => 'Edit'}),
                }),
            ],
        }),
    ]);
}};
createApp(App).mount('#app');
`;

const antSource = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Button, Form, Input, Modal, Space, Table} from 'antd';
import 'antd/dist/reset.css';
const rows = [{key: 'a', name: 'Alice'}, {key: 'b', name: 'Bob'}];
const columns = [
    {title: 'Name', dataIndex: 'name', key: 'name'},
    {title: 'Actions', key: 'actions', fixed: 'right', width: 140, render: () => React.createElement(Button, null, 'Edit')},
];
const App = () => React.createElement(Modal, {
    open: true,
    title: 'Create order',
    footer: null,
    getContainer: false,
    width: 900,
}, React.createElement(React.Fragment, null,
    React.createElement(Form, {name: 'order-form', layout: 'vertical'},
        React.createElement(Form.Item, {name: 'buyer', label: 'Buyer', required: true}, React.createElement(Input)),
        React.createElement(Form.Item, null, React.createElement(Space, null,
            React.createElement(Button, {htmlType: 'submit', type: 'primary'}, 'Save'),
            React.createElement(Button, null, 'Cancel')
        ))
    ),
    React.createElement(Table, {
        columns,
        dataSource: rows,
        rowKey: 'key',
        sticky: true,
        scroll: {x: 700},
        pagination: {pageSize: 2, total: 4, position: ['bottomRight']},
    })
));
createRoot(document.getElementById('app')).render(React.createElement(App));
`;
