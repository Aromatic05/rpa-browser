import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountFloatingUI} from '../floating_ui.js';
import type {Action} from '../../shared/types.js';

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const result = (type: string, payload: Record<string, unknown>): Action => ({
    v: 1,
    id: `${type}-result`,
    type: `${type}.result`,
    payload,
});

test('page actions and playback feedback stay scoped to their respective workspaces', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://example.test/orders'});
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        Node: globalThis.Node,
        location: globalThis.location,
        chrome: globalThis.chrome,
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        Node: dom.window.Node,
        location: dom.window.location,
        chrome: {
            runtime: {
                getManifest: () => ({version: '0.1.0', version_name: 'test'}),
            },
        },
    });
    const calls: Array<{type: string; address?: {workspaceName?: string; tabName?: string}}> = [];
    let emit: (action: Action) => void = () => undefined;
    const handle = mountFloatingUI({
        tabName: 'page-tab',
        workspaceName: 'page-workspace',
        onEvent: (handler) => {emit = handler;},
        onAction: async (type, _payload, address) => {
            calls.push({type, address});
            if (type === 'workspace.list') {
                return result(type, {
                    workspaces: [
                        {workspaceName: 'page-workspace', tabCount: 1},
                        {workspaceName: 'debug-workspace', tabCount: 0},
                    ],
                    activeWorkspaceName: 'debug-workspace',
                });
            }
            if (type === 'tab.list') {return result(type, {tabs: []});}
            if (type === 'record.list') {return result(type, {recordings: []});}
            if (type === 'entity_rules.list') {return result(type, {profiles: [], rules: []});}
            return result(type, {});
        },
        onEnterAnnotation: () => undefined,
        onEntityRulePreview: async () => true,
        onCheckpointEntityRulePreview: async () => true,
    });
    try {
        await flush();
        handle.scheduleRefresh();
        await flush();
        const shadow = document.getElementById('rpa-floating-panel')?.shadowRoot;
        assert.ok(shadow);
        (shadow.querySelector('.rules-launch') as HTMLButtonElement).click();
        await flush();

        const ruleCall = calls.findLast((call) => call.type === 'entity_rules.list');
        assert.deepEqual(ruleCall?.address, {workspaceName: 'page-workspace'});
        const debugTabCall = calls.findLast((call) => call.type === 'tab.list');
        assert.deepEqual(debugTabCall?.address, {workspaceName: 'debug-workspace'});

        const playTab = [...shadow.querySelectorAll<HTMLButtonElement>('.tabs button')].find((button) => button.textContent === 'Play');
        assert.ok(playTab);
        playTab.click();
        const failedStep = {
            index: 1, total: 3, stepName: 'browser.click', ok: false,
            error: {code: 'ERR_AMBIGUOUS', details: {resolution: 'recorded-target-fallback'}},
        };
        emit({v: 1, id: 'foreign', type: 'play.step.finished', workspaceName: 'page-workspace', payload: {...failedStep, replayId: 'foreign-run'}});
        assert.equal(shadow.querySelector('[data-playback-status]'), null);
        emit({v: 1, id: 'step', type: 'play.step.finished', workspaceName: 'debug-workspace', payload: {...failedStep, replayId: 'local-run'}});
        emit({v: 1, id: 'failure', type: 'play.failed', workspaceName: 'debug-workspace', payload: {replayId: 'local-run'}});
        const playback = shadow.querySelector('[data-playback-status="failed"]');
        assert.match(playback?.textContent ?? '', /Step 2 browser\.click \(ERR_AMBIGUOUS\)/);
        assert.match(playback?.textContent ?? '', /backup clues match more than one element/);

        handle.onPageChanged();
        handle.setPageWorkspace('rebound-workspace');
        await flush();
        (shadow.querySelector('.rules-launch') as HTMLButtonElement).click();
        await flush();
        const reboundRuleCall = calls.findLast((call) => call.type === 'entity_rules.list');
        assert.deepEqual(reboundRuleCall?.address, {workspaceName: 'rebound-workspace'});
    } finally {
        handle.unmount();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});
