import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountFloatingUI} from '../floating_ui.js';
import {sanitizeForDisplay} from '../agent_session_ui.js';
import type {Action} from '../../shared/types.js';

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const snapshot = (sessionId: string, state: string): Record<string, unknown> => ({
    sessionId,
    state,
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: state === 'running' ? null : Date.now(),
    request: {
        prompt: `prompt-${sessionId}`,
        provider: 'anthropic',
        model: 'claude-sonnet',
        executionMode: 'program',
    },
    result: state === 'running'
        ? null
        : {
              text: `final-text-${sessionId}`,
              executionMode: 'program',
              programs: [
                  {source: 'main', status: state === 'paused' ? 'paused' : 'completed'},
              ],
          },
    error: state === 'failed' ? {code: 'ERR_RUN_FAILED', message: `boom-${sessionId}`} : null,
});

const result = (type: string, payload: Record<string, unknown>): Action => ({
    v: 1,
    id: `${type}-result`,
    type: `${type}.result`,
    payload,
});

const click = (el: Element | null): void => {
    assert.ok(el, 'expected element to exist');
    (el as HTMLButtonElement).click();
};

const setValue = (el: Element | null, value: string, eventType: 'input' | 'change' = 'input'): void => {
    assert.ok(el, 'expected input to exist');
    const input = el as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new window.Event(eventType, {bubbles: true}));
};

test('agent session UI emits workspace-scoped actions and renders state transitions', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://example.test/'});
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
    const calls: Array<{type: string; payload?: Record<string, unknown>; address?: {workspaceName?: string}}> = [];
    const handle = mountFloatingUI({
        tabName: 'page-tab',
        workspaceName: 'ws-1',
        onAction: async (type, payload, address) => {
            calls.push({type, payload, address});
            if (type === 'agent.sessions.start') {
                return result(type, snapshot('session-1', 'running'));
            }
            if (type === 'agent.sessions.list') {
                return result(type, {
                    sessions: [
                        snapshot('session-2', 'running'),
                        snapshot('session-3', 'paused'),
                        snapshot('session-4', 'completed'),
                        snapshot('session-5', 'failed'),
                        snapshot('session-6', 'cancelled'),
                    ],
                });
            }
            if (type === 'agent.sessions.cancel') {
                return result(type, snapshot('session-2', 'cancelled'));
            }
            if (type === 'agent.sessions.status') {
                return result(type, snapshot('session-2', 'completed'));
            }
            if (type === 'workspace.list') {
                return result(type, {workspaces: [{workspaceName: 'ws-1', tabCount: 1}], activeWorkspaceName: 'ws-1'});
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
        const shadow = document.getElementById('rpa-floating-panel')?.shadowRoot;
        assert.ok(shadow);

        const agentTab = Array.from(shadow.querySelectorAll('.tabs button')).find((b) => b.textContent === 'Agent');
        click(agentTab);
        await flush();

        setValue(shadow.querySelector('.body textarea'), 'summarize orders');
        setValue(shadow.querySelector('.body input[placeholder="provider"]'), 'anthropic');
        setValue(shadow.querySelector('.body input[placeholder="model"]'), 'claude-sonnet');
        const mode = shadow.querySelector('.body select') as HTMLSelectElement;
        assert.ok(mode);
        setValue(mode, 'program', 'change');

        const startBtn = Array.from(shadow.querySelectorAll('.body button')).find((b) => b.textContent === 'Start');
        click(startBtn);
        await flush();

        const startCall = calls.findLast((call) => call.type === 'agent.sessions.start');
        assert.ok(startCall, 'agent.sessions.start must be emitted');
        assert.deepEqual(startCall.address, {workspaceName: 'ws-1'});
        assert.deepEqual(startCall.payload, {
            prompt: 'summarize orders',
            provider: 'anthropic',
            model: 'claude-sonnet',
            executionMode: 'program',
        });

        let runningItem = shadow.querySelector('.body [data-session-id="session-1"]');
        assert.ok(runningItem, 'running session must be rendered');
        assert.equal((runningItem as HTMLElement).dataset.sessionState, 'running');

        const refreshBtn = Array.from(shadow.querySelectorAll('.body button')).find((b) => b.textContent === 'Refresh');
        click(refreshBtn);
        await flush();

        const listCall = calls.findLast((call) => call.type === 'agent.sessions.list');
        assert.ok(listCall, 'agent.sessions.list must be emitted');
        assert.deepEqual(listCall.address, {workspaceName: 'ws-1'});

        for (const [sessionId, state] of [
            ['session-2', 'running'],
            ['session-3', 'paused'],
            ['session-4', 'completed'],
            ['session-5', 'failed'],
            ['session-6', 'cancelled'],
        ] as const) {
            const item = shadow.querySelector(`.body [data-session-id="${sessionId}"]`);
            assert.ok(item, `${sessionId} must be rendered`);
            assert.equal((item as HTMLElement).dataset.sessionState, state);
        }

        const pausedItem = shadow.querySelector('.body [data-session-id="session-3"]');
        assert.match((pausedItem as HTMLElement).textContent ?? '', /Paused/);
        const completedItem = shadow.querySelector('.body [data-session-id="session-4"]');
        assert.match((completedItem as HTMLElement).textContent ?? '', /final-text-session-4/);
        const failedItem = shadow.querySelector('.body [data-session-id="session-5"]');
        assert.match((failedItem as HTMLElement).textContent ?? '', /boom-session-5/);
        const cancelledItem = shadow.querySelector('.body [data-session-id="session-6"]');
        assert.match((cancelledItem as HTMLElement).textContent ?? '', /cancelled/);

        const statusBtn = Array.from(shadow.querySelectorAll('.body [data-session-id="session-2"] button'))
            .find((b) => b.textContent === 'Status');
        click(statusBtn);
        await flush();
        const statusCall = calls.findLast((call) => call.type === 'agent.sessions.status');
        assert.ok(statusCall, 'agent.sessions.status must be emitted');
        assert.deepEqual(statusCall.address, {workspaceName: 'ws-1'});
        assert.deepEqual(statusCall.payload, {sessionId: 'session-2'});
        const statusItem = shadow.querySelector('.body [data-session-id="session-2"]');
        assert.equal((statusItem as HTMLElement).dataset.sessionState, 'completed');

        click(refreshBtn);
        await flush();

        const cancelBtn = Array.from(shadow.querySelectorAll('.body [data-session-id="session-2"] button'))
            .find((b) => b.textContent === 'Cancel');
        click(cancelBtn);
        await flush();
        const cancelCall = calls.findLast((call) => call.type === 'agent.sessions.cancel');
        assert.ok(cancelCall, 'agent.sessions.cancel must be emitted');
        assert.deepEqual(cancelCall.address, {workspaceName: 'ws-1'});
        assert.deepEqual(cancelCall.payload, {sessionId: 'session-2'});
    } finally {
        handle.unmount();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('sanitizeForDisplay masks API keys recursively', () => {
    const sanitized = sanitizeForDisplay({
        provider: 'anthropic',
        payload: {
            apiKey: 'sk-abc',
            nested: {API_KEY: 'x', authorization: 'Bearer y', safe: 1},
            list: [{secret: 's'}, {ok: true}],
        },
    }) as Record<string, unknown>;
    const payload = sanitized.payload as Record<string, unknown>;
    assert.equal(payload.apiKey, '***');
    const nested = payload.nested as Record<string, unknown>;
    assert.equal(nested.API_KEY, '***');
    assert.equal(nested.authorization, '***');
    assert.equal(nested.safe, 1);
    const list = payload.list as Array<Record<string, unknown>>;
    assert.equal(list[0].secret, '***');
    assert.equal(list[1].ok, true);
    assert.equal(sanitized.provider, 'anthropic');
});