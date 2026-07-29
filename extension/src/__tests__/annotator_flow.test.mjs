import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {
    createAnnotatorClient,
    createAnnotatorOverlay,
    createAnnotatorSession,
} from '../../dist/annotator/index.js';

const log = async (name, fn) => {
    try {
        await fn();
        console.warn(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

const projection = {
    schemaVersion: 1,
    identity: {pageEpoch: 'epoch-1', captureRevision: 3},
    pageUrl: 'https://example.test/orders',
    selection: {status: 'none'},
    components: [],
    targets: [{
        id: 'target:submit',
        kind: 'action',
        domain: 'form',
        componentId: 'form:orders',
        memberId: 'action:submit',
        nodeIds: ['node:submit'],
        geometry: [{x: 100, y: 120, width: 80, height: 32}],
        label: '提交',
    }],
    semanticBindings: [],
    suggestions: [],
    diagnostics: [],
};

await log('annotator client sends only canonical action payloads', async () => {
    const sent = [];
    const client = createAnnotatorClient(async (type, payload) => {
        sent.push({type, payload});
        return {
            v: 1,
            id: `reply-${sent.length}`,
            type: `${type}.result`,
            payload: type === 'entity_rules.annotator.pick'
                ? {projection, picked: {status: 'resolved', nodeId: 'node:submit', anchor: {
                    pageEpoch: 'epoch-1', captureRevision: 3, nodeId: 'node:submit', backendNodeId: 'submit',
                }}}
                : {projection},
        };
    });

    await client.open('orders');
    await client.pick({x: 140, y: 136});
    await client.recognize('orders');

    assert.deepEqual(sent, [
        {type: 'entity_rules.annotator.open', payload: {profileName: 'orders'}},
        {type: 'entity_rules.annotator.pick', payload: {point: {x: 140, y: 136}}},
        {type: 'entity_rules.annotator.recognize', payload: {profileName: 'orders', refresh: true}},
    ]);
    assert.equal(JSON.stringify(sent).includes('selector'), false);
    assert.equal(JSON.stringify(sent).includes('element'), false);
});

await log('annotator overlay renders agent geometry and captures viewport coordinates', async () => {
    const dom = new JSDOM('<!doctype html><html><body><main>page</main></body></html>', {url: 'https://example.test'});
    const points = [];
    const overlay = createAnnotatorOverlay({
        document: dom.window.document,
        onPick: async (point) => {points.push(point);},
    });
    overlay.render(projection);

    const root = dom.window.document.getElementById('rpa-annotator-overlay');
    assert.ok(root);
    assert.equal(root?.getAttribute('data-page-epoch'), 'epoch-1');
    const box = root?.querySelector('[data-annotator-target-id="target:submit"]');
    assert.ok(box);
    assert.equal(box?.getAttribute('style')?.includes('left: 100px'), true);

    overlay.startPicking();
    const surface = dom.window.document.getElementById('rpa-annotator-pick-surface');
    assert.ok(surface);
    surface?.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        clientX: 140,
        clientY: 136,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(points, [{x: 140, y: 136}]);
    assert.equal(dom.window.document.getElementById('rpa-annotator-pick-surface'), null);
    overlay.dispose();
    assert.equal(dom.window.document.getElementById('rpa-annotator-overlay'), null);
});

await log('annotator session updates projection without local structural recovery', async () => {
    const calls = [];
    const client = createAnnotatorClient(async (type, payload) => {
        calls.push({type, payload});
        return {v: 1, id: `reply-${calls.length}`, type: `${type}.result`, payload: {projection}};
    });
    const rendered = [];
    const session = createAnnotatorSession({
        client,
        overlay: {
            render: (value) => rendered.push(value.identity.captureRevision),
            startPicking: () => undefined,
            stopPicking: () => undefined,
            dispose: () => undefined,
        },
    });

    await session.open('orders');
    assert.equal(session.getState().projection?.identity.pageEpoch, 'epoch-1');
    assert.deepEqual(rendered, [3]);
    assert.equal(session.getState().status, 'ready');
});



await log('annotator session preserves profile page applicability in the editable draft', async () => {
    const profile = {
        kind: 'entity_rules',
        name: 'orders-page',
        page: {kind: 'table', urlPattern: '/orders'},
        match: {version: 2, rules: [{ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'table'}}]},
        annotation: {version: 2, bindings: []},
    };
    const client = createAnnotatorClient(async (type) => ({
        v: 1,
        id: `reply-${type}`,
        type: `${type}.result`,
        payload: {projection, profile},
    }));
    const session = createAnnotatorSession({
        client,
        overlay: {
            render: () => undefined,
            startPicking: () => undefined,
            stopPicking: () => undefined,
            dispose: () => undefined,
        },
    });
    await session.open('orders-page');
    assert.deepEqual(session.getState().draft?.page, {kind: 'table', urlPattern: '/orders'});
});

await log('annotator source does not recover page structure from DOM', async () => {
    const files = fs.readdirSync(new URL('../annotator', import.meta.url), {withFileTypes: true})
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => new URL(`../annotator/${entry.name}`, import.meta.url));
    const forbidden = [
        'elementFromPoint',
        '.closest(',
        '.matches(',
        'querySelector(',
        'parentElement',
        'parentNode',
        'compileEntityRuleQueryPlan',
        'executeEntityRuleQueryPlan',
        'executeEntityRules',
    ];
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        for (const token of forbidden) {
            assert.equal(source.includes(token), false, `${file.pathname} contains ${token}`);
        }
    }
});

await log('annotator panel drives the session without DOM target recovery', async () => {
    const {createAnnotatorPanel} = await import('../../dist/annotator/panel.js');
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const calls = [];
    let state = {
        status: 'ready',
        profileName: 'orders',
        projection,
        draft: {
            profileName: 'orders',
            page: {kind: 'form', urlPattern: '/orders'},
            match: {version: 2, rules: [{ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'form'}}]},
            annotation: {version: 2, bindings: []},
        },
    };
    const session = {
        getState: () => globalThis.structuredClone(state),
        subscribe: () => () => undefined,
        setDraft: (draft) => {state = {...state, draft, profileName: draft.profileName}; calls.push(['setDraft', draft.profileName]);},
        open: async (name) => {calls.push(['open', name]);},
        recognize: async () => {calls.push(['recognize']);},
        visualize: async () => {calls.push(['visualize']);},
        apply: async () => {calls.push(['apply']);},
        check: async () => {calls.push(['check']);},
        save: async () => {calls.push(['save']);},
        startPicking: () => {calls.push(['pick']);},
        stopPicking: () => undefined,
        dispose: () => undefined,
    };
    const panel = createAnnotatorPanel({document: dom.window.document, session});
    dom.window.document.body.appendChild(panel);

    const click = async (label) => {
        const button = [...panel.getElementsByTagName('button')].find((item) => item.textContent === label);
        assert.ok(button, label);
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await click('Open');
    await click('Pick');
    await click('Recognize');
    await click('Visualize');
    await click('Check');
    await click('Save');

    assert.deepEqual(calls.map((item) => item[0]), [
        'open', 'pick', 'recognize', 'visualize', 'setDraft', 'check', 'setDraft', 'save',
    ]);
    assert.equal(panel.textContent.includes('epoch-1'), true);
    assert.deepEqual(state.draft.page, {kind: 'form', urlPattern: '/orders'});
});

await log('floating UI exposes the versioned annotator source module', async () => {
    const source = fs.readFileSync(new URL('../content/floating_ui.ts', import.meta.url), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
    const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources || []);
    assert.equal(source.includes("../annotator/index.js"), true);
    assert.equal(source.includes("'Rules'"), true);
    assert.equal(resources.includes('annotator/*.js'), true);
});

await log('annotator live geometry refresh coalesces viewport events through visualize only', async () => {
    const {createAnnotatorLiveGeometryRefresh} = await import('../../dist/annotator/live_geometry.js');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.test',
        pretendToBeVisual: true,
    });
    let active = true;
    let refreshes = 0;
    const visualViewport = new dom.window.EventTarget();
    const live = createAnnotatorLiveGeometryRefresh({
        eventTargets: [dom.window, visualViewport],
        isActive: () => active,
        refresh: async () => {refreshes += 1;},
    });

    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    visualViewport.dispatchEvent(new dom.window.Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(refreshes, 1);

    active = false;
    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(refreshes, 1);

    live.dispose();
    active = true;
    visualViewport.dispatchEvent(new dom.window.Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(refreshes, 1);
});

await log('annotator panel reacts to session state and applies canonical target annotations', async () => {
    const {createAnnotatorPanel} = await import('../../dist/annotator/panel.js');
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const listeners = new Set();
    const calls = [];
    let state = {status: 'idle', profileName: ''};
    const nextProjection = {
        ...projection,
        selection: {
            status: 'resolved',
            nodeId: 'node:submit',
            anchor: {pageEpoch: 'epoch-1', captureRevision: 3, nodeId: 'node:submit'},
        },
        targets: [
            {
                id: 'structural-root:form:orders',
                kind: 'structural-root',
                domain: 'form',
                componentId: 'form:orders',
                nodeIds: ['node:form'],
                geometry: [],
                label: 'Order form',
            },
            {
                id: 'action:submit',
                kind: 'action',
                domain: 'form',
                componentId: 'form:orders',
                memberId: 'action:submit',
                nodeIds: ['node:submit'],
                geometry: [],
                label: 'Submit',
            },
        ],
    };
    const publish = () => listeners.forEach((listener) => listener(globalThis.structuredClone(state)));
    const session = {
        getState: () => globalThis.structuredClone(state),
        subscribe: (listener) => {listeners.add(listener); return () => listeners.delete(listener);},
        setDraft: (draft) => {state = {...state, draft, profileName: draft.profileName}; publish();},
        open: async (name) => {
            calls.push(['open', name]);
            state = {
                status: 'ready',
                profileName: name,
                projection: nextProjection,
                draft: {
                    profileName: name,
                    page: {kind: 'form', urlPattern: '/orders'},
                    match: {version: 2, rules: []},
                    annotation: {version: 2, bindings: []},
                },
            };
            publish();
        },
        apply: async (input) => {calls.push(['apply', input.targetId, input.semantic.kind]);},
        recognize: async () => undefined,
        visualize: async () => undefined,
        check: async () => undefined,
        save: async () => undefined,
        startPicking: () => undefined,
        stopPicking: () => undefined,
        dispose: () => undefined,
    };
    const panel = createAnnotatorPanel({document: dom.window.document, session});
    dom.window.document.body.appendChild(panel);

    const profileInput = panel.querySelector('[data-annotator-profile]');
    assert.ok(profileInput);
    profileInput.value = 'orders';
    const open = [...panel.getElementsByTagName('button')].find((item) => item.textContent === 'Open');
    assert.ok(open);
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const target = panel.querySelector('[data-annotator-target]');
    assert.ok(target);
    assert.equal(target.options.length >= 2, true);
    target.value = 'action:submit';
    target.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
    const semantic = panel.querySelector('[data-annotator-semantic-kind]');
    assert.ok(semantic);
    semantic.value = 'action';
    semantic.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
    const value = panel.querySelector('[data-annotator-semantic-value]');
    assert.ok(value);
    value.value = 'submit';
    value.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
    const apply = [...panel.getElementsByTagName('button')].find((item) => item.textContent === 'Apply annotation');
    assert.ok(apply);
    apply.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, [
        ['open', 'orders'],
        ['apply', 'action:submit', 'action'],
    ]);
    assert.equal(panel.textContent.includes('epoch-1'), true);
    assert.equal(panel.querySelector('textarea')?.value.includes('"urlPattern": "/orders"'), true);
});

await log('annotator client and session apply canonical targets without extension-side matching', async () => {
    const sent = [];
    const appliedDraft = {
        profileName: 'orders',
        page: {kind: 'form', urlPattern: '/orders'},
        match: {
            version: 2,
            rules: [{ruleId: 'action-submit', source: 'node', expect: 'unique', match: {idEquals: 'Submit'}}],
        },
        annotation: {version: 2, bindings: [{ruleId: 'action-submit', actionIntent: 'submit'}]},
    };
    const client = createAnnotatorClient(async (type, payload) => {
        sent.push({type, payload});
        return {
            v: 1,
            id: `reply-${sent.length}`,
            type: `${type}.result`,
            payload: {
                draft: appliedDraft,
                projection,
                validation: {ok: true, domain: 'form', diagnostics: [], bindingIds: ['orders:action-submit'], suggestionIds: []},
            },
        };
    });
    const rendered = [];
    const session = createAnnotatorSession({
        client,
        overlay: {
            render: (value) => rendered.push(value.identity.captureRevision),
            startPicking: () => undefined,
            stopPicking: () => undefined,
            dispose: () => undefined,
        },
    });
    const draft = {
        profileName: 'orders',
        page: {kind: 'form', urlPattern: '/orders'},
        match: {version: 2, rules: []},
        annotation: {version: 2, bindings: []},
    };
    await session.apply({
        draft,
        targetId: 'action:submit',
        semantic: {kind: 'action', actionIntent: 'submit'},
    });
    assert.deepEqual(sent, [{
        type: 'entity_rules.annotator.apply',
        payload: {
            draft,
            targetId: 'action:submit',
            semantic: {kind: 'action', actionIntent: 'submit'},
        },
    }]);
    assert.deepEqual(session.getState().draft, appliedDraft);
    assert.equal(session.getState().validation?.ok, true);
    assert.deepEqual(rendered, [3]);
});
