import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {annotationIdBelowInteractionShield} from '../state/dom_marker_hit_test.js';

test('interaction shield resolves a marked element without dispatching to the page', () => {
    const dom = new JSDOM('<!doctype html><html><body><button data-rpa-annotation-id="column-order">订单编号</button><div id="shield"></div></body></html>');
    const previousElement = globalThis.Element;
    try {
        globalThis.Element = dom.window.Element;
        const documentRef = dom.window.document;
        const shield = documentRef.getElementById('shield') as HTMLElement;
        const marker = documentRef.querySelector('[data-rpa-annotation-id]') as HTMLElement;
        shield.style.pointerEvents = 'auto';
        Object.defineProperty(documentRef, 'elementFromPoint', {
            value: () => marker,
        });
        const event = {
            clientX: 10,
            clientY: 20,
            composedPath: () => [shield, documentRef.documentElement, documentRef],
        } as unknown as MouseEvent;

        assert.equal(annotationIdBelowInteractionShield(event, shield, documentRef), 'column-order');
        assert.equal(shield.style.pointerEvents, 'auto');
    } finally {
        globalThis.Element = previousElement;
        dom.window.close();
    }
});

test('interaction shield does not reinterpret clicks from annotator controls', () => {
    const dom = new JSDOM('<!doctype html><html><body><button id="control"></button><div id="shield"></div></body></html>');
    const previousElement = globalThis.Element;
    try {
        globalThis.Element = dom.window.Element;
        const documentRef = dom.window.document;
        const shield = documentRef.getElementById('shield') as HTMLElement;
        const control = documentRef.getElementById('control') as HTMLElement;
        let hitTested = false;
        Object.defineProperty(documentRef, 'elementFromPoint', {
            value: () => {
                hitTested = true;
                return null;
            },
        });
        const event = {
            clientX: 10,
            clientY: 20,
            composedPath: () => [control, shield, documentRef],
        } as unknown as MouseEvent;

        assert.equal(annotationIdBelowInteractionShield(event, shield, documentRef), null);
        assert.equal(hitTested, false);
    } finally {
        globalThis.Element = previousElement;
        dom.window.close();
    }
});
