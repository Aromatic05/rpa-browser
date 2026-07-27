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
