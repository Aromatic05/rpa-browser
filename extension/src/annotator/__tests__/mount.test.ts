import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    ANNOTATOR_HOST_ID,
    createAnnotatorHost,
    mountAnnotator,
    type AnnotatorAppHandle,
    type AnnotatorHandlers,
} from '../mount.js';
import { initialState } from '../state/annotator_state.js';
import type { AnnotatorOpenResult } from '../types.js';

const noopHandlers: AnnotatorHandlers = {
    onExit: () => undefined,
    onUndo: () => undefined,
    onRedo: () => undefined,
    onCheck: () => undefined,
    onSave: () => undefined,
};

type MountAppFn = (root: ShadowRoot, handlers: AnnotatorHandlers) => AnnotatorAppHandle;

const noopMountApp: MountAppFn = (_root, _handlers) => ({
    setState: () => undefined,
    getState: () => initialState(),
    unmount: () => undefined,
});

const createMockApp = (calls: string[]): MountAppFn => (root, _handlers) => {
    calls.push('mount');
    const node = root.ownerDocument.createElement('div');
    node.textContent = 'mock-app';
    root.appendChild(node);
    return {
        setState: () => undefined,
        getState: () => initialState(),
        unmount: () => { calls.push('unmount'); },
    };
};

test('createAnnotatorHost creates host with snapshot-ignore and panel attributes', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const { host, shadow } = createAnnotatorHost(dom.window.document);
    assert.equal(host.id, ANNOTATOR_HOST_ID);
    assert.equal(host.getAttribute('data-rpa-panel'), 'true');
    assert.equal(host.getAttribute('data-rpa-snapshot-ignore'), 'true');
    assert.equal(shadow.mode, 'open');
});

test('createAnnotatorHost starts hidden with display none', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const { host } = createAnnotatorHost(dom.window.document);
    assert.equal(host.style.display, 'none');
});

test('createAnnotatorHost removes a pre-existing host before creating a new one', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const doc = dom.window.document;
    const stale = doc.createElement('div');
    stale.id = ANNOTATOR_HOST_ID;
    doc.body.appendChild(stale);
    assert.equal(doc.getElementById(ANNOTATOR_HOST_ID), stale);
    const { host } = createAnnotatorHost(doc);
    assert.notEqual(host, stale);
    assert.equal(doc.getElementById(ANNOTATOR_HOST_ID), null);
    assert.equal(stale.parentNode, null);
});

test('annotator host and debug panel host coexist in the document', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const doc = dom.window.document;
    const debugHost = doc.createElement('div');
    debugHost.id = 'rpa-floating-panel';
    debugHost.setAttribute('data-rpa-panel', 'true');
    debugHost.setAttribute('data-rpa-snapshot-ignore', 'true');
    doc.documentElement.appendChild(debugHost);
    const { host } = createAnnotatorHost(doc);
    doc.documentElement.appendChild(host);
    assert.equal(doc.getElementById('rpa-floating-panel'), debugHost);
    assert.equal(doc.getElementById(ANNOTATOR_HOST_ID), host);
    assert.equal(doc.querySelectorAll('[data-rpa-panel="true"]').length, 2);
});

test('mountAnnotator appends host to documentElement and returns a handle that can show/hide', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const doc = dom.window.document;
    let mountedHandlers: AnnotatorHandlers | null = null;
    const handle = mountAnnotator({
        document: doc,
        handlers: noopHandlers,
        mountApp: (root, handlers) => {
            mountedHandlers = handlers;
            return noopMountApp(root, handlers);
        },
    });
    const host = doc.getElementById(ANNOTATOR_HOST_ID) as HTMLDivElement;
    assert.ok(host, 'host should be attached to document');
    assert.equal(host.style.display, 'none');
    handle.show();
    assert.equal(host.style.display, 'block');
    assert.equal(host.style.pointerEvents, 'auto', 'editing mode must keep toolbar and labels interactive');
    mountedHandlers?.onPickModeChange?.(true);
    assert.equal(host.style.pointerEvents, 'none', 'pick mode must let pointer input reach the page');
    mountedHandlers?.onPickModeChange?.(false);
    assert.equal(host.style.pointerEvents, 'auto', 'leaving pick mode restores canvas interaction');
    handle.hide();
    assert.equal(host.style.display, 'none');
    handle.unmount();
    assert.equal(doc.getElementById(ANNOTATOR_HOST_ID), null);
});

test('mount handle opens through the formal state transition and exits without losing its draft', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    let state = initialState();
    const handle = mountAnnotator({
        document: dom.window.document,
        handlers: noopHandlers,
        mountApp: () => ({
            setState: (next) => { state = next; },
            getState: () => state,
            unmount: () => undefined,
        }),
    });
    const result: AnnotatorOpenResult = {
        workspaceName: 'ws', tabName: 'tab', url: 'https://example.test/orders',
        pageKind: 'table', profileName: 'orders', artifactRevision: 'rev-1',
        canvasDraft: { version: 1, profileName: 'orders', page: {kind: 'table'}, entities: [], preserved: {} },
        visualTargetRefs: [{entityId: 'orders', nodeId: 'table-1', role: 'entity'}],
    };
    handle.open(result);
    assert.equal(state.mode, 'editing');
    assert.deepEqual(state.pageIdentity, {workspaceName: 'ws', tabName: 'tab', url: 'https://example.test/orders'});
    assert.deepEqual(state.visualBindings, result.visualTargetRefs);
    handle.exit();
    assert.equal(state.mode, 'idle');
    assert.equal(state.canvasDraft, result.canvasDraft);
    assert.equal(state.currentAnnotationId, null);
});

test('unmounting annotator leaves debug host intact', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const doc = dom.window.document;
    const debugHost = doc.createElement('div');
    debugHost.id = 'rpa-floating-panel';
    doc.documentElement.appendChild(debugHost);
    const handle = mountAnnotator({
        document: doc,
        handlers: noopHandlers,
        mountApp: noopMountApp,
    });
    handle.unmount();
    assert.equal(doc.getElementById('rpa-floating-panel'), debugHost);
    assert.equal(doc.getElementById(ANNOTATOR_HOST_ID), null);
});

test('mountAnnotator invokes mountApp and unmount calls app.unmount', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const doc = dom.window.document;
    const calls: string[] = [];
    const handle = mountAnnotator({
        document: doc,
        handlers: noopHandlers,
        mountApp: createMockApp(calls),
    });
    assert.deepEqual(calls, ['mount']);
    handle.unmount();
    assert.deepEqual(calls, ['mount', 'unmount']);
});

test('annotator host shadow root is distinct from debug host shadow root', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const doc = dom.window.document;
    const debugHost = doc.createElement('div');
    debugHost.id = 'rpa-floating-panel';
    const debugShadow = debugHost.attachShadow({ mode: 'open' });
    debugShadow.appendChild(doc.createTextNode('debug'));
    doc.documentElement.appendChild(debugHost);
    const { host, shadow } = createAnnotatorHost(doc);
    doc.documentElement.appendChild(host);
    assert.notEqual(host, debugHost);
    assert.notEqual(shadow, debugShadow);
    assert.equal(debugShadow.textContent, 'debug');
    assert.equal(host.shadowRoot, shadow);
});
