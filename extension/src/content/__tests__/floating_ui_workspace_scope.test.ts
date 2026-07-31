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

test('page rule and checkpoint actions stay scoped to the content page workspace', async () => {
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
    const handle = mountFloatingUI({
        tabName: 'page-tab',
        workspaceName: 'page-workspace',
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
