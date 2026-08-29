import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountFloatingUI} from '../floating_ui.js';
import {
    buildAgentSessionView,
    normalizeAgentSession,
    normalizeAgentSessionReport,
    sanitizeForDisplay,
} from '../agent_session_ui.js';
import type {Action} from '../../shared/types.js';

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const setupDom = () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://example.test/'});
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        Node: globalThis.Node,
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        Node: dom.window.Node,
    });
    return {dom, previous};
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

test('agent session UI renders a completed session report without raw tool args', async () => {
    const {dom, previous} = setupDom();
    try {
        const reportCalls: string[] = [];
        const reportPayload = {
            schema: 'rpa.agent.run-report',
            schemaVersion: 1,
            run: {provider: 'anthropic', model: 'claude-sonnet', executionMode: 'program'},
            terminal: {status: 'completed', output: 'orders summarized'},
            toolMetrics: {
                turns: 4,
                toolCalls: 5,
                readCalls: 2,
                controlCalls: 1,
                effectCalls: 2,
                failedToolCalls: 0,
                postErrorEffectCalls: 0,
                repair: {rewindCalls: 0, rollbackCalls: 0, patchCalls: 0, recomputeCalls: 0, refreshCalls: 1},
            },
            world: {revisionsObserved: []},
            toolCalls: [
                {
                    toolCallId: 'tc-1',
                    toolName: 'browser.click',
                    classification: 'effect',
                    isError: false,
                    startedAt: 1,
                    durationMs: 2,
                    args: {apiKey: 'sk-super-secret', selector: '#orders'},
                    redactedPaths: ['apiKey'],
                    worldBefore: null,
                    worldAfter: null,
                },
            ],
            effects: {
                availability: 'program-journal',
                worldEffectCalls: 2,
                failedWorldChangingEffects: [],
                compensationEffects: [],
                records: [],
            },
            programs: [
                {index: 0, status: 'completed', source: 'main', output: 'orders summarized', inputKeys: [], effectsExposed: true, effectCount: 2},
            ],
            savedArtifacts: [{kind: 'program', name: 'orders.program.json', artifactRevision: 'rev-1'}],
        };
        const report = normalizeAgentSessionReport(reportPayload);
        assert.ok(report);
        const session = normalizeAgentSession({
            sessionId: 'session-report',
            state: 'completed',
            createdAt: 1,
            startedAt: 1,
            endedAt: 2,
            request: {prompt: 'p', provider: 'anthropic', model: 'claude-sonnet', executionMode: 'program'},
            result: {text: 'done', executionMode: 'program', programs: []},
            error: null,
            reportAvailable: true,
            resumable: false,
        });
        assert.ok(session);

        const root = buildAgentSessionView({
            sessions: [session],
            inputs: {prompt: '', provider: '', model: '', executionMode: ''},
            onInputsChange: () => undefined,
            handlers: {
                start: () => undefined,
                list: () => undefined,
                status: () => undefined,
                cancel: () => undefined,
                clear: () => undefined,
                report: (sessionId) => { reportCalls.push(sessionId); },
            },
            report: {sessionId: 'session-report', status: 'loaded', report},
        });

        const text = root.textContent ?? '';
        assert.match(text, /terminal: completed/);
        assert.match(text, /orders summarized/);
        assert.match(text, /run: anthropic · claude-sonnet · program/);
        assert.match(text, /governance: unavailable/);
        assert.match(text, /tool metrics: turns: 4 · toolCalls: 5 · effectCalls: 2 · failedToolCalls: 0/);
        assert.match(text, /rewind: 0 · rollback: 0 · patch: 0 · recompute: 0 · refresh: 1/);
        assert.match(text, /effects: world effect calls: 2/);
        assert.match(text, /program 0: completed — main · effects: 2/);
        assert.match(text, /artifact: orders\.program\.json \(rev-1\)/);
        assert.match(text, /tool calls recorded: 1 \(arguments not shown\)/);
        assert.ok(!text.includes('sk-super-secret'), 'raw tool args must not be rendered');
        assert.ok(!text.includes('browser.click'), 'tool call names must not be rendered');
        assert.ok(!text.includes('tc-1'), 'tool call ids must not be rendered');

        const item = root.querySelector('[data-session-id="session-report"]') as HTMLElement;
        assert.ok(item);
        assert.equal(item.dataset.reportAvailable, 'true');

        const refreshBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Refresh Report');
        click(refreshBtn);
        assert.deepEqual(reportCalls, ['session-report']);
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('agent session UI marks a paused session as not resumable after restart', () => {
    const {dom, previous} = setupDom();
    try {
        const session = normalizeAgentSession({
            sessionId: 'session-paused',
            state: 'paused',
            createdAt: 1,
            startedAt: 1,
            endedAt: 2,
            request: {prompt: 'p', provider: 'p', model: 'm'},
            result: null,
            error: null,
            reportAvailable: false,
            resumable: false,
        });
        assert.ok(session);
        const root = buildAgentSessionView({
            sessions: [session],
            inputs: {prompt: '', provider: '', model: '', executionMode: ''},
            onInputsChange: () => undefined,
            handlers: {
                start: () => undefined,
                list: () => undefined,
                status: () => undefined,
                cancel: () => undefined,
                clear: () => undefined,
            },
        });
        const item = root.querySelector('[data-session-id="session-paused"]') as HTMLElement;
        assert.ok(item);
        assert.equal(item.dataset.sessionState, 'paused');
        assert.equal(item.dataset.resumable, 'false');
        assert.match(item.textContent ?? '', /Paused — resume\/approve is not available \(resumable: false\)/);
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('agent session UI shows an explicit message when a report is missing', () => {
    const {dom, previous} = setupDom();
    try {
        const session = normalizeAgentSession({
            sessionId: 'session-noreport',
            state: 'completed',
            createdAt: 1,
            startedAt: 1,
            endedAt: 2,
            request: {prompt: 'p', provider: 'p', model: 'm'},
            result: null,
            error: null,
            reportAvailable: false,
            resumable: false,
        });
        assert.ok(session);
        const root = buildAgentSessionView({
            sessions: [session],
            inputs: {prompt: '', provider: '', model: '', executionMode: ''},
            onInputsChange: () => undefined,
            handlers: {
                start: () => undefined,
                list: () => undefined,
                status: () => undefined,
                cancel: () => undefined,
                clear: () => undefined,
                report: () => undefined,
            },
            report: {sessionId: 'session-noreport', status: 'missing'},
        });
        const text = root.textContent ?? '';
        assert.match(text, /Report — session-noreport/);
        assert.match(text, /Report unavailable for this session/);
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('agent session UI emits agent.sessions.prune only after confirmation', () => {
    const {dom, previous} = setupDom();
    try {
        const pruneCalls: number[] = [];
        const handlers = {
            start: () => undefined,
            list: () => undefined,
            status: () => undefined,
            cancel: () => undefined,
            clear: () => undefined,
            prune: (maxCount: number) => { pruneCalls.push(maxCount); },
        };
        dom.window.confirm = () => true;
        const root = buildAgentSessionView({
            sessions: [],
            inputs: {prompt: '', provider: '', model: '', executionMode: ''},
            onInputsChange: () => undefined,
            handlers,
            pruneMaxCount: 5,
        });
        const pruneBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Prune');
        click(pruneBtn);
        assert.deepEqual(pruneCalls, [5]);

        dom.window.confirm = () => false;
        click(pruneBtn);
        assert.deepEqual(pruneCalls, [5], 'prune must not fire when confirmation is declined');
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});