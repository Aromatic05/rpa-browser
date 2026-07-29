import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {enrichInferredFieldNamesFromDom} from '../state/dom_labels.js';
import type {CanvasDraft} from '../types.js';

const makeDraft = (): CanvasDraft => ({
    version: 1,
    profileName: 'orders',
    page: {kind: 'table'},
    entities: [{
        id: 'e0',
        source: 'node',
        kind: 'table',
        name: '订单查询列表',
        businessTag: 'orders.main',
        target: {classContains: 'orders-module'},
        annotations: [
            {
                id: 'order-no',
                type: 'field',
                name: 'orderNo',
                businessKey: 'orderNo',
                target: {idEquals: 'orderNoQuery'},
                origin: 'inferred',
                disposition: 'active',
            },
            {
                id: 'status',
                type: 'field',
                name: '全部',
                businessKey: 'status',
                target: {idEquals: 'statusQuery'},
                origin: 'inferred',
                disposition: 'active',
            },
        ],
        columns: [],
        origin: 'manual',
    }],
    preserved: {
        matchRaw: {},
        annotationRaw: {},
        preservedByCanvasId: {},
        ruleIdToCanvasId: {},
        locatorRules: [],
        ruleRefs: [],
    },
});

test('enrichInferredFieldNamesFromDom uses explicit label relationships', () => {
    const dom = new JSDOM(`
        <label for="orderNoQuery">订单编号</label>
        <input id="orderNoQuery" name="orderNo">
        <label>状态<select id="statusQuery" name="status"><option selected>全部</option></select></label>
    `);
    const enriched = enrichInferredFieldNamesFromDom(makeDraft(), dom.window.document);
    assert.equal(enriched.entities[0].annotations[0].name, '订单编号');
    assert.equal(enriched.entities[0].annotations[1].name, '状态');
});

test('enrichInferredFieldNamesFromDom preserves confirmed user names', () => {
    const draft = makeDraft();
    draft.entities[0].annotations[0].name = '我的订单号';
    draft.entities[0].annotations[0].origin = 'confirmed';
    const dom = new JSDOM('<label for="orderNoQuery">订单编号</label><input id="orderNoQuery">');
    const enriched = enrichInferredFieldNamesFromDom(draft, dom.window.document);
    assert.equal(enriched.entities[0].annotations[0].name, '我的订单号');
});

test('enrichInferredFieldNamesFromDom falls back to aria-label and placeholder', () => {
    const draft = makeDraft();
    const dom = new JSDOM(`
        <input id="orderNoQuery" aria-label="订单编号">
        <input id="statusQuery" placeholder="订单状态">
    `);
    const enriched = enrichInferredFieldNamesFromDom(draft, dom.window.document);
    assert.equal(enriched.entities[0].annotations[0].name, '订单编号');
    assert.equal(enriched.entities[0].annotations[1].name, '订单状态');
});
