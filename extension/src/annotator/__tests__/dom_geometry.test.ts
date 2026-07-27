import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {enrichVisualBindingsFromDom, resolveEntityElement} from '../state/dom_geometry.js';
import type {CanvasDraft, PickRect, VisualTargetRef} from '../types.js';

const setRect = (element: Element, rect: PickRect): void => {
    Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => ({
            ...rect,
            top: rect.y,
            left: rect.x,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
            toJSON: () => rect,
        }),
    });
};

test('DOM geometry replaces incorrect entity bindings and adds exact table-header bindings', () => {
    const dom = new JSDOM(`
        <section class="orders-module" aria-label="订单查询列表">
            <table><thead><tr><th>订单编号</th><th>采购人</th></tr></thead></table>
        </section>
    `);
    const documentRef = dom.window.document;
    const entityElement = documentRef.querySelector('.orders-module')!;
    const headers = Array.from(documentRef.querySelectorAll('th'));
    setRect(entityElement, {x: 20, y: 24, width: 800, height: 420});
    setRect(headers[0], {x: 40, y: 180, width: 160, height: 44});
    setRect(headers[1], {x: 200, y: 180, width: 140, height: 44});
    const draft: CanvasDraft = {
        version: 1,
        profileName: '',
        page: {kind: 'table'},
        entities: [{
            id: 'e0',
            source: 'node',
            kind: 'table',
            name: '订单查询列表',
            businessTag: 'table.main',
            target: {classContains: 'orders-module', ariaContains: '订单查询列表'},
            expect: 'unique',
            annotations: [],
            columns: [
                {id: 'c0', fieldKey: 'orderNo', name: '订单编号', actions: [], origin: 'inferred', disposition: 'active'},
                {id: 'c1', fieldKey: 'buyer', name: '采购人', actions: [], origin: 'inferred', disposition: 'active'},
            ],
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
    };
    const stale: VisualTargetRef[] = [{
        entityId: 'e0',
        nodeId: 'wrong',
        role: 'entity',
        matchedNodeBoxes: [
            {x: 0, y: 0, width: 1200, height: 900},
            {x: 20, y: 24, width: 800, height: 420},
        ],
    }];
    const enriched = enrichVisualBindingsFromDom(draft, stale, documentRef);
    const entityBinding = enriched.find((binding) => binding.role === 'entity');
    assert.deepEqual(entityBinding?.bbox, {x: 20, y: 24, width: 800, height: 420});
    assert.equal(entityBinding?.matchedNodeBoxes, undefined);
    const columns = enriched.filter((binding) => binding.role === 'column');
    assert.deepEqual(columns.map((binding) => binding.canvasAnnotationId), ['c0', 'c1']);
    assert.deepEqual(columns.map((binding) => binding.bbox), [
        {x: 40, y: 180, width: 160, height: 44},
        {x: 200, y: 180, width: 140, height: 44},
    ]);
});

test('DOM geometry resolves imported semantic table targets to the outer table region', () => {
    const dom = new JSDOM(`
        <section role="table" aria-label="订单主表格">
            <table>
                <thead><tr><th>订单编号</th><th>采购人</th></tr></thead>
                <tbody><tr><td>ORD-1</td><td>张三</td></tr></tbody>
            </table>
            <nav aria-label="分页"><button>上一页</button><button>下一页</button></nav>
        </section>
    `);
    const documentRef = dom.window.document;
    const draft: CanvasDraft = {
        version: 1,
        profileName: 'orders',
        page: {kind: 'table'},
        entities: [{
            id: 'e0',
            source: 'region',
            kind: 'table',
            name: '订单主列表',
            businessTag: 'order.list.main',
            target: {kind: 'table'},
            expect: 'unique',
            annotations: [],
            columns: [
                {id: 'c0', fieldKey: 'orderNo', name: '订单编号', actions: [], origin: 'confirmed', disposition: 'active'},
                {id: 'c1', fieldKey: 'buyer', name: '采购人', actions: [], origin: 'confirmed', disposition: 'active'},
            ],
            origin: 'confirmed',
        }],
        preserved: {},
    };
    const resolved = resolveEntityElement(draft.entities[0], documentRef);
    assert.equal(resolved, documentRef.querySelector('[role="table"]'));
    assert.ok(resolved?.querySelector('nav[aria-label="分页"]'));
});
