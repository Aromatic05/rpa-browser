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

const click = (el: Element | null): void => {
    assert.ok(el, 'expected element to exist');
    (el as HTMLButtonElement).click();
};

const clickBodyButton = (shadow: ShadowRoot | null, label: string): void => {
    assert.ok(shadow);
    const btn = Array.from(shadow.querySelectorAll('.body button'))
        .find((b) => b.textContent?.trim().startsWith(label));
    click(btn ?? null);
};

const clickSessionButton = (shadow: ShadowRoot | null, sessionId: string, label: string): void => {
    assert.ok(shadow);
    const btn = Array.from(shadow.querySelectorAll(`.body [data-session-id="${sessionId}"] button`))
        .find((b) => b.textContent?.trim() === label);
    click(btn ?? null);
};

const openAgentTab = (shadow: ShadowRoot | null): void => {
    assert.ok(shadow);
    const tab = Array.from(shadow.querySelectorAll('.tabs button')).find((b) => b.textContent?.trim() === 'Agent');
    click(tab ?? null);
};

type Setup = {
    dom: JSDOM;
    previous: Record<string, unknown>;
};

const setupDom = (): Setup => {
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
    return {dom, previous};
};

type BaseMock = {
    onAction: (type: string, payload?: Record<string, unknown>, address?: {workspaceName?: string}) => Promise<Action>;
};

const completedSnapshot = (reportAvailable = false): Record<string, unknown> => ({
    sessionId: 'session-r',
    state: 'completed',
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: Date.now(),
    request: {
        prompt: 'run a program',
        provider: 'faux',
        model: 'faux-model',
        executionMode: 'program',
    },
    result: {text: 'program complete', executionMode: 'program', programs: []},
    error: null,
    reportAvailable,
    resumable: false,
});

const cancelledSnapshot = (): Record<string, unknown> => ({
    sessionId: 'session-r',
    state: 'cancelled',
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: Date.now(),
    request: {prompt: 'long', provider: 'faux', model: 'faux-model'},
    result: null,
    error: null,
    reportAvailable: false,
    resumable: false,
});

const runningSnapshot = (): Record<string, unknown> => ({
    sessionId: 'session-r',
    state: 'running',
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: null,
    request: {prompt: 'long', provider: 'faux', model: 'faux-model'},
    result: null,
    error: null,
    reportAvailable: false,
    resumable: false,
});

const reportPayload = (): Record<string, unknown> => ({
    run: {provider: 'faux', model: 'faux-model', executionMode: 'program'},
    terminal: {status: 'completed', output: 'orders summarized'},
    toolMetrics: {turns: 2, toolCalls: 1, effectCalls: 0, failedToolCalls: 0, repair: {rewindCalls: 0, rollbackCalls: 0, patchCalls: 0, recomputeCalls: 0, refreshCalls: 0}},
    effects: {availability: 'not-exposed', worldEffectCalls: 0, failedWorldChangingEffects: [], compensationEffects: []},
    programs: [{index: 0, status: 'completed', source: 'main.dsl'}],
    savedArtifacts: [],
    toolCalls: [],
    schema: 'rpa.agent.run-report',
    schemaVersion: 1,
});

test('floating UI agent view loads the durable report through agent.sessions.report', async () => {
    const {dom, previous} = setupDom();
    try {
        const sent: Array<{type: string; payload?: Record<string, unknown>; address?: {workspaceName?: string}}> = [];
        const mock: BaseMock = {
            onAction: async (type, payload, address) => {
                sent.push({type, payload, address});
                if (type === 'agent.sessions.list') {
                    return result(type, {sessions: [completedSnapshot(true)]});
                }
                if (type === 'agent.sessions.report') {
                    return result(type, {sessionId: payload?.sessionId, report: reportPayload()});
                }
                if (type === 'workspace.list') {
                    return result(type, {workspaces: [{workspaceName: 'ws-1', tabCount: 1}], activeWorkspaceName: 'ws-1'});
                }
                if (type === 'tab.list') {return result(type, {tabs: []});}
                if (type === 'record.list') {return result(type, {recordings: []});}
                if (type === 'entity_rules.list') {return result(type, {profiles: [], rules: []});}
                return result(type, {});
            },
        };
        const handle = mountFloatingUI({
            tabName: 'page-tab',
            workspaceName: 'ws-1',
            onAction: mock.onAction,
            onEnterAnnotation: () => undefined,
            onEntityRulePreview: async () => true,
            onCheckpointEntityRulePreview: async () => true,
        });
        try {
            await flush();
            const shadow = document.getElementById('rpa-floating-panel')?.shadowRoot;
            assert.ok(shadow);
            openAgentTab(shadow);
            await flush();
            clickSessionButton(shadow, 'session-r', 'Report');
            await flush();

            const reportCall = sent.findLast((call) => call.type === 'agent.sessions.report');
            assert.ok(reportCall, 'agent.sessions.report must be emitted');
            assert.deepEqual(reportCall.payload, {sessionId: 'session-r'});
            assert.deepEqual(reportCall.address, {workspaceName: 'ws-1'});

            const body = (shadow as ShadowRoot).querySelector('.body');
            const text = (body as HTMLElement)?.textContent ?? '';
            assert.match(text, /Report — session-r/);
            assert.match(text, /terminal: completed/);
            assert.match(text, /orders summarized/);
            assert.match(text, /run: faux · faux-model · program/);
            assert.match(text, /program 0: completed — main\.dsl/);
            assert.ok(!text.includes('sk-'), 'raw secrets must never be rendered');
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('floating UI agent view marks a report as unavailable when the service cannot load it', async () => {
    const {dom, previous} = setupDom();
    try {
        const mock: BaseMock = {
            onAction: async (type, payload) => {
                if (type === 'agent.sessions.list') {
                    return result(type, {sessions: [completedSnapshot(true)]});
                }
                if (type === 'agent.sessions.report') {
                    return result(type, {sessionId: payload?.sessionId, report: null});
                }
                if (type === 'workspace.list') {
                    return result(type, {workspaces: [{workspaceName: 'ws-1', tabCount: 1}], activeWorkspaceName: 'ws-1'});
                }
                if (type === 'tab.list') {return result(type, {tabs: []});}
                if (type === 'record.list') {return result(type, {recordings: []});}
                if (type === 'entity_rules.list') {return result(type, {profiles: [], rules: []});}
                return result(type, {});
            },
        };
        const handle = mountFloatingUI({
            tabName: 'page-tab',
            workspaceName: 'ws-1',
            onAction: mock.onAction,
            onEnterAnnotation: () => undefined,
            onEntityRulePreview: async () => true,
            onCheckpointEntityRulePreview: async () => true,
        });
        try {
            await flush();
            const shadow = document.getElementById('rpa-floating-panel')?.shadowRoot;
            assert.ok(shadow);
            openAgentTab(shadow);
            await flush();
            clickSessionButton(shadow, 'session-r', 'Report');
            await flush();
            const text = (shadow as ShadowRoot).querySelector('.body')?.textContent ?? '';
            assert.match(text, /Report unavailable for this session/);
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('floating UI agent list refresh is latched while a request is in flight', async () => {
    const {dom, previous} = setupDom();
    try {
        const pending: Array<(action: Action) => void> = [];
        let listCalls = 0;
        const mock: BaseMock = {
            onAction: async (type) => {
                if (type === 'agent.sessions.list') {
                    listCalls += 1;
                    return await new Promise<Action>((resolve) => { pending.push(resolve); });
                }
                if (type === 'agent.sessions.start') {
                    return result(type, {});
                }
                if (type === 'workspace.list') {
                    return result(type, {workspaces: [{workspaceName: 'ws-1', tabCount: 1}], activeWorkspaceName: 'ws-1'});
                }
                if (type === 'tab.list') {return result(type, {tabs: []});}
                if (type === 'record.list') {return result(type, {recordings: []});}
                if (type === 'entity_rules.list') {return result(type, {profiles: [], rules: []});}
                return result(type, {});
            },
        };
        const handle = mountFloatingUI({
            tabName: 'page-tab',
            workspaceName: 'ws-1',
            onAction: mock.onAction,
            onEnterAnnotation: () => undefined,
            onEntityRulePreview: async () => true,
            onCheckpointEntityRulePreview: async () => true,
        });
        try {
            await flush();
            const shadow = document.getElementById('rpa-floating-panel')?.shadowRoot;
            assert.ok(shadow);
            openAgentTab(shadow);
            await flush();
            const beforeRefresh = listCalls;
            clickBodyButton(shadow, 'Refresh');
            clickBodyButton(shadow, 'Refresh');
            clickBodyButton(shadow, 'Refresh');
            await flush();
            assert.equal(listCalls, beforeRefresh + 1, 'repeated refreshes must not duplicate an in-flight list');
            pending[0]?.(result('agent.sessions.list', {sessions: []}));
            await flush();
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('floating UI agent list never reverts a settled session back to running', async () => {
    const {dom, previous} = setupDom();
    try {
        let step = 0;
        const mock: BaseMock = {
            onAction: async (type) => {
                if (type === 'agent.sessions.list') {
                    step += 1;
                    const sessions = step === 1
                        ? [cancelledSnapshot(), {sessionId: 'other', state: 'completed', createdAt: 1, startedAt: 1, endedAt: 2, request: {prompt: 'p', provider: 'p', model: 'm'}, result: null, error: null, reportAvailable: false, resumable: false}]
                        : [runningSnapshot()];
                    return result(type, {sessions});
                }
                if (type === 'workspace.list') {
                    return result(type, {workspaces: [{workspaceName: 'ws-1', tabCount: 1}], activeWorkspaceName: 'ws-1'});
                }
                if (type === 'tab.list') {return result(type, {tabs: []});}
                if (type === 'record.list') {return result(type, {recordings: []});}
                if (type === 'entity_rules.list') {return result(type, {profiles: [], rules: []});}
                return result(type, {});
            },
        };
        const handle = mountFloatingUI({
            tabName: 'page-tab',
            workspaceName: 'ws-1',
            onAction: mock.onAction,
            onEnterAnnotation: () => undefined,
            onEntityRulePreview: async () => true,
            onCheckpointEntityRulePreview: async () => true,
        });
        try {
            await flush();
            const shadow = document.getElementById('rpa-floating-panel')?.shadowRoot;
            assert.ok(shadow);
            openAgentTab(shadow);
            await flush();
            let item = (shadow as ShadowRoot).querySelector('.body [data-session-id="session-r"]') as HTMLElement;
            assert.equal(item.dataset.sessionState, 'cancelled');

            clickBodyButton(shadow, 'Refresh');
            await flush();
            item = (shadow as ShadowRoot).querySelector('.body [data-session-id="session-r"]') as HTMLElement;
            assert.equal(item.dataset.sessionState, 'cancelled', 'a stale running list must not overwrite a settled state');
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('floating UI agent start is single-flight while a start request is pending', async () => {
    const {dom, previous} = setupDom();
    try {
        const pending: Array<(action: Action) => void> = [];
        let startCalls = 0;
        const mock: BaseMock = {
            onAction: async (type, payload) => {
                if (type === 'agent.sessions.start') {
                    startCalls += 1;
                    return await new Promise<Action>((resolve) => { pending.push(resolve); });
                }
                if (type === 'workspace.list') {
                    return result(type, {workspaces: [{workspaceName: 'ws-1', tabCount: 1}], activeWorkspaceName: 'ws-1'});
                }
                if (type === 'tab.list') {return result(type, {tabs: []});}
                if (type === 'record.list') {return result(type, {recordings: []});}
                if (type === 'entity_rules.list') {return result(type, {profiles: [], rules: []});}
                void payload;
                return result(type, {});
            },
        };
        const handle = mountFloatingUI({
            tabName: 'page-tab',
            workspaceName: 'ws-1',
            onAction: mock.onAction,
            onEnterAnnotation: () => undefined,
            onEntityRulePreview: async () => true,
            onCheckpointEntityRulePreview: async () => true,
        });
        try {
            await flush();
            const shadow = document.getElementById('rpa-floating-panel')?.shadowRoot;
            assert.ok(shadow);
            openAgentTab(shadow);
            await flush();
            clickBodyButton(shadow, 'Start');
            clickBodyButton(shadow, 'Start');
            await flush();
            assert.equal(startCalls, 1, 'a pending start must be single-flight');
            pending[0]?.(result('agent.sessions.start', {sessionId: 'session-new', state: 'running', createdAt: 1, startedAt: 1, endedAt: null, request: {prompt: 'p', provider: 'faux', model: 'm'}, result: null, error: null, reportAvailable: false, resumable: false}));
            await flush();
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('floating UI agent remount never duplicates the panel and unmount cleans up', async () => {
    const {dom, previous} = setupDom();
    try {
        const noopMock: BaseMock = {
            onAction: async (type) => {
                if (type === 'workspace.list') {
                    return result(type, {workspaces: [{workspaceName: 'ws-1', tabCount: 1}], activeWorkspaceName: 'ws-1'});
                }
                if (type === 'tab.list') {return result(type, {tabs: []});}
                if (type === 'record.list') {return result(type, {recordings: []});}
                if (type === 'entity_rules.list') {return result(type, {profiles: [], rules: []});}
                return result(type, {});
            },
        };
        const opts = {
            tabName: 'page-tab',
            workspaceName: 'ws-1',
            onAction: noopMock.onAction,
            onEnterAnnotation: () => undefined,
            onEntityRulePreview: async () => true,
            onCheckpointEntityRulePreview: async () => true,
        };
        const first = mountFloatingUI(opts);
        await flush();
        const duplicate = mountFloatingUI(opts);
        try {
            assert.equal(document.querySelectorAll('#rpa-floating-panel').length, 1, 'remount must not add a second panel');
            duplicate.unmount();
            assert.equal(document.querySelectorAll('#rpa-floating-panel').length, 1, 'no-op unmount must leave the live panel intact');
            first.unmount();
            assert.equal(document.querySelectorAll('#rpa-floating-panel').length, 0, 'unmount removes the panel');
            const rebound = mountFloatingUI(opts);
            await flush();
            assert.equal(document.querySelectorAll('#rpa-floating-panel').length, 1, 'mount after unmount works again');
            rebound.unmount();
            await flush();
        } finally {
            first.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});