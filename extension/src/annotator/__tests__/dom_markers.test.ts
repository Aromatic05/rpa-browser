import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {applyDomMarkers, clearDomMarkers} from '../state/dom_markers.js';
import type {CanvasDraft} from '../types.js';

const makeDraft = (): CanvasDraft => ({
    version: 1,
    profileName: '',
    page: {kind: 'table'},
    entities: [{
        id: 'e0',
        source: 'node',
        kind: 'table',
        name: '订单查询列表',
        businessTag: 'orders.main',
        target: {classContains: 'orders-module'},
        expect: 'unique',
        annotations: [{
            id: 'search-field',
            type: 'field',
            name: '订单编号',
            businessKey: 'orderNo',
            target: {idEquals: 'orderNo'},
            expect: 'unique',
            origin: 'inferred',
            disposition: 'active',
        }],
        columns: [
            {id: 'c0', fieldKey: 'orderNo', name: '订单编号', actions: [], origin: 'inferred', disposition: 'active'},
            {id: 'c1', fieldKey: 'buyer', name: '采购人', actions: [], origin: 'inferred', disposition: 'active'},
            {id: 'c2', fieldKey: 'status', name: '状态', actions: [], origin: 'inferred', disposition: 'active'},
        ],
        primaryKey: {fieldKey: 'orderNo'},
        pagination: {actionIntent: 'nextPage', pageTarget: {idEquals: 'nextPage'}},
        origin: 'manual',
    }],
    preserved: {
        matchRaw: {version: 1, page: {kind: 'table'}, entities: []},
        annotationRaw: {version: 1, page: {kind: 'table'}, annotations: []},
        preservedByCanvasId: {},
        ruleIdToCanvasId: {},
        locatorRules: [],
        ruleRefs: [],
    },
});

test('DOM markers keep the dashed purple header frame, use single column separators and mark the primary key', () => {
    const dom = new JSDOM(`
        <section class="orders-module">
            <input id="orderNo" />
            <table><thead><tr><th>订单编号</th><th>采购人</th><th>状态</th></tr></thead></table>
            <nav aria-label="分页"><button id="previousPage">上一页</button><button id="nextPage">下一页</button></nav>
        </section>
    `);
    const documentRef = dom.window.document;
    applyDomMarkers(makeDraft(), documentRef, null, null);

    const headers = Array.from(documentRef.querySelectorAll('th'));
    assert.deepEqual(headers.map((header) => header.getAttribute('data-rpa-column-position')), [
        'first', 'middle', 'last',
    ]);
    assert.equal(headers[0].getAttribute('data-rpa-primary-key'), 'true');
    assert.equal(headers[1].hasAttribute('data-rpa-primary-key'), false);
    assert.equal(documentRef.querySelector('thead tr')?.getAttribute('data-rpa-column-group'), 'true');

    const style = documentRef.getElementById('rpa-annotator-dom-marker-style')?.textContent || '';
    assert.match(style, /outline: 2px dashed #7c3aed/);
    assert.match(style, /outline-offset: -2px/);
    assert.doesNotMatch(style, /outline-offset: 2px/);
    assert.match(style, /box-shadow: inset -1px 0 0 var\(--rpa-marker-color\)/);
    assert.doesNotMatch(style, /inset 0 -3px 0/);
    assert.match(style, /data-rpa-column-position="last"[^}]*box-shadow: none/s);
});

test('pagination preset marks both previous and next controls as one semantic object', () => {
    const dom = new JSDOM(`
        <section class="orders-module">
            <input id="orderNo" />
            <table><thead><tr><th>订单编号</th><th>采购人</th><th>状态</th></tr></thead></table>
            <nav aria-label="分页"><button id="previousPage">上一页</button><button id="nextPage">下一页</button></nav>
        </section>
    `);
    const documentRef = dom.window.document;
    applyDomMarkers(makeDraft(), documentRef, null, null);
    assert.equal(documentRef.getElementById('previousPage')?.getAttribute('data-rpa-annotation-id'), 'e0_pgpage');
    assert.equal(documentRef.getElementById('nextPage')?.getAttribute('data-rpa-annotation-id'), 'e0_pgpage');
    clearDomMarkers(documentRef);
    assert.equal(documentRef.querySelectorAll('[data-rpa-annotation-id]').length, 0);
});

test('DOM markers resolve snapshot-normalized Ant classes and placeholder-backed field names', () => {
    const dom = new JSDOM(`
        <main class="ant-layout-content ant-pro-basicLayout-content">
            <input class="ant-input" placeholder="订单编号" />
            <input class="ant-input" placeholder="商品名称" />
            <table><thead><tr><th>订单编号</th><th>商品名称</th></tr></thead></table>
        </main>
    `);
    const draft: CanvasDraft = {
        version: 1,
        profileName: 'yingdao-orders',
        page: {kind: 'table'},
        entities: [{
            id: 'e0',
            source: 'node',
            kind: 'table',
            name: '订单管理',
            businessTag: 'table.main',
            target: {classContains: 'ant-pro-basiclayout-content'},
            expect: 'unique',
            annotations: [
                {id: 'f0', type: 'field', name: '订单编号', businessKey: '订单编号', target: {roleEquals: 'textbox', placeholderEquals: '订单编号'}, expect: 'unique', origin: 'inferred', disposition: 'active'},
                {id: 'f1', type: 'field', name: '商品名称', businessKey: '商品名称', target: {roleEquals: 'textbox', placeholderEquals: '商品名称'}, expect: 'unique', origin: 'inferred', disposition: 'active'},
            ],
            columns: [
                {id: 'c0', fieldKey: '订单编号', name: '订单编号', actions: [], origin: 'inferred', disposition: 'active'},
                {id: 'c1', fieldKey: '商品名称', name: '商品名称', actions: [], origin: 'inferred', disposition: 'active'},
            ],
            origin: 'manual',
        }],
        preserved: {},
    };
    const documentRef = dom.window.document;
    applyDomMarkers(draft, documentRef, null, null);
    assert.equal(documentRef.querySelectorAll('[data-rpa-annotation-kind="field"]').length, 2);
    assert.equal(documentRef.querySelectorAll('[data-rpa-annotation-kind="column"]').length, 2);
});

test('Ant pagination scopes the shared link class to next and marks the previous sibling control', () => {
    const dom = new JSDOM(`
        <main class="ant-pro-basicLayout-content">
            <table><thead><tr><th>订单编号</th></tr></thead></table>
            <ul class="ant-pagination ant-table-pagination">
                <li class="ant-pagination-disabled ant-pagination-prev" title="上一页">
                    <a id="previousLink" class="ant-pagination-item-link"></a>
                </li>
                <li class="ant-pagination-next" title="下一页">
                    <a id="nextLink" class="ant-pagination-item-link"></a>
                </li>
                <li class="ant-pagination-options">
                    <input id="quickJump" />
                </li>
            </ul>
        </main>
    `);
    const draft: CanvasDraft = {
        version: 1,
        profileName: 'yingdao-orders',
        page: {kind: 'table'},
        entities: [{
            id: 'e0',
            source: 'node',
            kind: 'table',
            name: '订单管理',
            businessTag: 'table.main',
            target: {classContains: 'ant-pro-basiclayout-content'},
            expect: 'unique',
            annotations: [],
            columns: [{id: 'c0', fieldKey: '订单编号', name: '订单编号', actions: [], origin: 'inferred', disposition: 'active'}],
            pagination: {
                actionIntent: 'nextPage',
                pageTarget: {classContains: 'ant-pagination-item-link'},
                itemTarget: {ariaContains: '下一页'},
            },
            origin: 'manual',
        }],
        preserved: {},
    };
    const documentRef = dom.window.document;
    applyDomMarkers(draft, documentRef, null, null);
    assert.equal(documentRef.getElementById('previousLink')?.getAttribute('data-rpa-annotation-id'), 'e0_pgpage');
    assert.equal(documentRef.getElementById('nextLink')?.getAttribute('data-rpa-annotation-id'), 'e0_pgpage');
    assert.equal(documentRef.getElementById('quickJump')?.hasAttribute('data-rpa-annotation-id'), false);
});


test('DOM markers resolve an outer business scope even when its entity kind is table', () => {
    const dom = new JSDOM(`
        <main>
            <section aria-label="订单查询列表">
                <form><input id="orderNo"></form>
                <table aria-label="订单结果"><thead><tr><th>订单编号</th></tr></thead></table>
            </section>
        </main>
    `);
    const draft = makeDraft();
    draft.entities[0].target = {
        kind: 'table',
        ariaContains: '订单查询列表',
        v2Match: {kind: 'table', ariaContains: '订单结果'},
    };
    draft.entities[0].annotations[0].target = {idEquals: 'orderNo'};
    draft.entities[0].columns = [
        {id: 'c0', fieldKey: 'orderNo', name: '订单编号', actions: [], origin: 'inferred', disposition: 'active'},
    ];
    draft.entities[0].pagination = undefined;

    const documentRef = dom.window.document;
    applyDomMarkers(draft, documentRef, null, null);
    assert.equal(documentRef.getElementById('orderNo')?.getAttribute('data-rpa-annotation-kind'), 'field');
    assert.equal(documentRef.querySelector('th')?.getAttribute('data-rpa-annotation-kind'), 'column');
});

test('repeated row actions mark every instance and carry the row primary key', () => {
    const dom = new JSDOM(`
        <section class="orders-module">
            <table>
                <thead><tr><th>订单编号</th><th>操作</th></tr></thead>
                <tbody>
                    <tr><td>SO-001</td><td><a id="ship-1">确认发货</a></td></tr>
                    <tr><td>SO-002</td><td><a id="ship-2">确认发货</a></td></tr>
                </tbody>
            </table>
        </section>
    `);
    const draft = makeDraft();
    draft.profileName = 'orders-rule';
    draft.entities[0].annotations = [];
    draft.entities[0].columns = [
        {id: 'order-column', fieldKey: 'orderNo', name: '订单编号', actions: [], origin: 'confirmed', disposition: 'active'},
        {
            id: 'action-column',
            fieldKey: 'actions',
            name: '操作',
            kind: 'action_column',
            actions: [{
                id: 'confirm-shipment',
                actionIntent: 'confirmShipment',
                text: '确认发货',
                target: {textContains: '确认发货'},
                origin: 'confirmed',
                disposition: 'active',
            }],
            origin: 'confirmed',
            disposition: 'active',
        },
    ];
    draft.entities[0].primaryKey = {fieldKey: 'orderNo'};
    draft.entities[0].pagination = undefined;

    const documentRef = dom.window.document;
    applyDomMarkers(draft, documentRef, null, null);

    const semantics = ['ship-1', 'ship-2'].map((id) => {
        const element = documentRef.getElementById(id);
        assert.equal(element?.getAttribute('data-rpa-annotation-id'), 'confirm-shipment');
        return JSON.parse(element?.getAttribute('data-rpa-record-semantic') || '{}') as Record<string, unknown>;
    });
    assert.deepEqual(semantics, [
        {
            profileName: 'orders-rule',
            businessTag: 'orders.main',
            entityKind: 'table',
            actionIntent: 'confirmShipment',
            actionRole: 'row',
            rowPrimaryKey: {fieldKey: 'orderNo', value: 'SO-001'},
        },
        {
            profileName: 'orders-rule',
            businessTag: 'orders.main',
            entityKind: 'table',
            actionIntent: 'confirmShipment',
            actionRole: 'row',
            rowPrimaryKey: {fieldKey: 'orderNo', value: 'SO-002'},
        },
    ]);
});
