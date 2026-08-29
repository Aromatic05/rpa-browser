import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountFloatingUI} from '../floating_ui.js';
import type {Action} from '../../shared/types.js';

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const result = (type: string, payload: Record<string, unknown>): Action => ({
    v: 1,
    id: `${type}-result`,
    type: `${type}.result`,
    payload,
});

const failed = (type: string, code: string, message: string): Action => ({
    v: 1,
    id: `${type}-failed`,
    type: `${type}.failed`,
    payload: {code, message},
});

const click = (el: Element | null): void => {
    assert.ok(el, 'expected element to exist');
    (el as HTMLButtonElement).click();
};

const openAgentTab = (shadow: ShadowRoot | null): void => {
    assert.ok(shadow);
    const tab = Array.from(shadow.querySelectorAll('.tabs button')).find((b) => b.textContent?.trim() === 'Agent');
    click(tab ?? null);
};

const clickSessionButton = (shadow: ShadowRoot | null, sessionId: string, label: string): void => {
    assert.ok(shadow);
    const btn = Array.from(shadow.querySelectorAll(`.body [data-session-id="${sessionId}"] button`))
        .find((b) => b.textContent?.trim() === label);
    click(btn ?? null);
};

const clickSessionHead = (shadow: ShadowRoot | null, sessionId: string): void => {
    assert.ok(shadow);
    const head = shadow.querySelector(`.body [data-session-id="${sessionId}"] .selectable`);
    click(head ?? null);
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

const pausedSession = (sessionId = 'session-a'): Record<string, unknown> => ({
    sessionId,
    state: 'paused',
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
    request: {prompt: 'run a program', provider: 'faux', model: 'faux-model', executionMode: 'program'},
    result: null,
    error: null,
    reportAvailable: false,
    resumable: true,
});

const completedSession = (sessionId = 'session-a'): Record<string, unknown> => ({
    sessionId,
    state: 'completed',
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
    request: {prompt: 'run a program', provider: 'faux', model: 'faux-model', executionMode: 'program'},
    result: {text: 'program complete', executionMode: 'program', programs: []},
    error: null,
    reportAvailable: false,
    resumable: false,
});

const cancelledSession = (sessionId: string, code: string, message: string): Record<string, unknown> => ({
    sessionId,
    state: 'cancelled',
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
    request: {prompt: 'run a program', provider: 'faux', model: 'faux-model'},
    result: null,
    error: {code, message},
    reportAvailable: false,
    resumable: false,
});

const pendingInteraction = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'it-1',
    runId: 'run-1',
    sessionId: 'session-a',
    kind: 'irreversible-effect-approval',
    status: 'pending',
    createdAt: 1000,
    deadlineAt: 1000 + 900000,
    revision: 0,
    prompt: 'Approve irreversible effect for step send-order',
    evidence: {summary: 'Send order to downstream API', riskLevel: 'high', toolName: 'http.send'},
    decision: null,
    ...overrides,
});

const approvedInteraction = (): Record<string, unknown> => ({
    ...pendingInteraction(),
    status: 'approved',
    revision: 1,
    decision: {kind: 'approve', approvedBy: 'extension-operator', approvedAt: 2000},
});

const deniedInteraction = (reason: string): Record<string, unknown> => ({
    ...pendingInteraction(),
    status: 'denied',
    revision: 1,
    decision: {kind: 'deny', deniedBy: 'extension-operator', deniedAt: 2000, reason},
});

type BaseMock = {
    onAction: (type: string, payload?: Record<string, unknown>, address?: {workspaceName?: string}) => Promise<Action>;
};

const mountPanel = async (mock: BaseMock) => {
    const handle = mountFloatingUI({
        tabName: 'page-tab',
        workspaceName: 'ws-1',
        onAction: mock.onAction,
        onEnterAnnotation: () => undefined,
        onEntityRulePreview: async () => true,
        onCheckpointEntityRulePreview: async () => true,
    });
    await flush();
    const shadow = document.getElementById('rpa-floating-panel')?.shadowRoot;
    assert.ok(shadow);
    return {handle, shadow};
};

const baseNoop = (): BaseMock => ({
    onAction: async (type) => {
        if (type === 'workspace.list') {
            return result(type, {workspaces: [{workspaceName: 'ws-1', tabCount: 1}], activeWorkspaceName: 'ws-1'});
        }
        if (type === 'tab.list') {return result(type, {tabs: []});}
        if (type === 'record.list') {return result(type, {recordings: []});}
        if (type === 'entity_rules.list') {return result(type, {profiles: [], rules: []});}
        return result(type, {});
    },
});

test('agent HITL approve resolves a pending interaction and refreshes the session to completed', async () => {
    const {dom, previous} = setupDom();
    try {
        const sent: Array<{type: string; payload?: Record<string, unknown>; address?: {workspaceName?: string}}> = [];
        let approved = false;
        const mock: BaseMock = {
            onAction: async (type, payload, address) => {
                sent.push({type, payload, address});
                if (type === 'agent.sessions.list') {
                    return result(type, {sessions: [approved ? completedSession('session-a') : pausedSession('session-a')]});
                }
                if (type === 'agent.interactions.list') {
                    return result(type, {sessionId: payload?.sessionId, interactions: approved ? [] : [pendingInteraction()]});
                }
                if (type === 'agent.interactions.approve') {
                    approved = true;
                    return result(type, {interaction: approvedInteraction(), session: completedSession('session-a')});
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
        const {handle, shadow} = await mountPanel(mock);
        try {
            openAgentTab(shadow);
            await flush();

            const sessionItem = shadow.querySelector('.body [data-session-id="session-a"]') as HTMLElement;
            assert.equal(sessionItem.dataset.sessionState, 'paused');
            assert.match(sessionItem.textContent ?? '', /Approval Required/);
            assert.match(sessionItem.textContent ?? '', /evidence: Send order to downstream API/);
            assert.match(sessionItem.textContent ?? '', /risk: high/);
            assert.match(sessionItem.textContent ?? '', /revision: 0/);

            clickSessionButton(shadow, 'session-a', 'Approve');
            await flush();

            const approveCall = sent.findLast((call) => call.type === 'agent.interactions.approve');
            assert.ok(approveCall, 'agent.interactions.approve must be emitted');
            assert.deepEqual(approveCall.address, {workspaceName: 'ws-1'});
            assert.deepEqual(approveCall.payload, {
                sessionId: 'session-a',
                interactionId: 'it-1',
                revision: 0,
                approvedBy: 'extension-operator',
            });
            assert.equal(
                sent.filter((call) => call.type === 'agent.interactions.approve').length,
                1,
                'approve must be submitted exactly once',
            );

            const afterApprove = shadow.querySelector('.body [data-session-id="session-a"]') as HTMLElement;
            assert.equal(afterApprove.dataset.sessionState, 'completed', 'session refreshes to completed after approval');
            assert.equal(
                shadow.querySelector('.body [data-interaction-id="it-1"]'),
                null,
                'decided interaction no longer renders controls',
            );
            assert.equal(
                Array.from(afterApprove.querySelectorAll('button')).some((b) => ['Approve', 'Deny'].includes(b.textContent ?? '')),
                false,
                'no approval buttons after the interaction is resolved',
            );
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('agent HITL deny with a required reason cancels the session and shows the terminal reason', async () => {
    const {dom, previous} = setupDom();
    try {
        const sent: Array<{type: string; payload?: Record<string, unknown>}> = [];
        let denied = false;
        const reason = 'would leak customer data';
        const mock: BaseMock = {
            onAction: async (type, payload) => {
                sent.push({type, payload});
                if (type === 'agent.sessions.list') {
                    return result(type, {
                        sessions: [denied
                            ? cancelledSession('session-a', 'ERR_SESSION_INTERACTION_DENIED', `session session-a cancelled after interaction it-1 was denied: ${reason}`)
                            : pausedSession('session-a')],
                    });
                }
                if (type === 'agent.interactions.list') {
                    return result(type, {sessionId: payload?.sessionId, interactions: denied ? [] : [pendingInteraction()]});
                }
                if (type === 'agent.interactions.deny') {
                    denied = true;
                    return result(type, {
                        interaction: deniedInteraction(reason),
                        session: cancelledSession('session-a', 'ERR_SESSION_INTERACTION_DENIED', `session session-a cancelled after interaction it-1 was denied: ${reason}`),
                    });
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
        const {handle, shadow} = await mountPanel(mock);
        try {
            openAgentTab(shadow);
            await flush();

            const denyBtn = Array.from(shadow.querySelectorAll('.body [data-session-id="session-a"] button'))
                .find((b) => b.textContent === 'Deny');
            const denyInput = shadow.querySelector('.body [data-session-id="session-a"] input[placeholder="deny reason (required)"]') as HTMLInputElement;
            assert.ok(denyBtn && denyInput);
            assert.equal((denyBtn as HTMLButtonElement).disabled, true, 'Deny is disabled until a reason is provided');

            denyInput.value = reason;
            denyInput.dispatchEvent(new window.Event('input', {bubbles: true}));
            assert.equal((denyBtn as HTMLButtonElement).disabled, false, 'Deny enables once the reason is non-empty');
            click(denyBtn);
            await flush();

            const denyCall = sent.findLast((call) => call.type === 'agent.interactions.deny');
            assert.ok(denyCall, 'agent.interactions.deny must be emitted');
            assert.deepEqual(denyCall.payload, {
                sessionId: 'session-a',
                interactionId: 'it-1',
                revision: 0,
                deniedBy: 'extension-operator',
                reason,
            });
            assert.equal(
                sent.filter((call) => call.type === 'agent.interactions.deny').length,
                1,
                'deny must be submitted exactly once',
            );

            const afterDeny = shadow.querySelector('.body [data-session-id="session-a"]') as HTMLElement;
            assert.equal(afterDeny.dataset.sessionState, 'cancelled', 'session becomes cancelled after denial');
            assert.match(afterDeny.textContent ?? '', /ERR_SESSION_INTERACTION_DENIED/);
            assert.match(afterDeny.textContent ?? '', /would leak customer data/);
            assert.equal(
                Array.from(afterDeny.querySelectorAll('button')).some((b) => ['Approve', 'Deny'].includes(b.textContent ?? '')),
                false,
                'no approval buttons after denial',
            );
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('agent HITL handles a stale revision decision cleanly and re-enables controls', async () => {
    const {dom, previous} = setupDom();
    try {
        let interactionsCalls = 0;
        const mock: BaseMock = {
            onAction: async (type, payload) => {
                if (type === 'agent.sessions.list') {
                    return result(type, {sessions: [pausedSession('session-a')]});
                }
                if (type === 'agent.interactions.list') {
                    interactionsCalls += 1;
                    return result(type, {sessionId: payload?.sessionId, interactions: [pendingInteraction()]});
                }
                if (type === 'agent.interactions.approve') {
                    return failed(type, 'ERR_STALE', 'stale revision for it-1: expected 0, got 1');
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
        const {handle, shadow} = await mountPanel(mock);
        try {
            openAgentTab(shadow);
            await flush();
            const callsBeforeApprove = interactionsCalls;

            clickSessionButton(shadow, 'session-a', 'Approve');
            await flush();

            const interactionEl = shadow.querySelector('.body [data-interaction-id="it-1"]') as HTMLElement;
            assert.ok(interactionEl, 'interaction remains rendered after a stale decision');
            const errorHint = shadow.querySelector('[data-interaction-error="true"]');
            assert.ok(errorHint, 'decision failure is surfaced to the user');
            assert.match((errorHint as HTMLElement).textContent ?? '', /stale revision/);

            const approveBtn = Array.from(interactionEl.querySelectorAll('button')).find((b) => b.textContent === 'Approve');
            assert.ok(approveBtn, 'Approve is available again after the stale revision is surfaced');
            assert.equal((approveBtn as HTMLButtonElement).disabled, false);
            assert.ok(interactionsCalls > callsBeforeApprove, 'interactions are re-fetched to re-sync the revision');
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('agent HITL keeps an in-flight decision bound to its session when selection changes', async () => {
    const {dom, previous} = setupDom();
    try {
        const pendingApproves: Array<(action: Action) => void> = [];
        const sent: Array<{type: string; payload?: Record<string, unknown>}> = [];
        let sessionACompleted = false;
        const mock: BaseMock = {
            onAction: async (type, payload) => {
                sent.push({type, payload});
                if (type === 'agent.sessions.list') {
                    return result(type, {
                        sessions: [
                            sessionACompleted ? completedSession('session-a') : pausedSession('session-a'),
                            pausedSession('session-b'),
                        ],
                    });
                }
                if (type === 'agent.interactions.list') {
                    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
                    const interactions = sessionId === 'session-a'
                        ? [pendingInteraction()]
                        : [pendingInteraction({id: 'it-b', sessionId: 'session-b'})];
                    return result(type, {sessionId, interactions});
                }
                if (type === 'agent.interactions.approve') {
                    return await new Promise<Action>((resolve) => { pendingApproves.push(resolve); });
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
        const {handle, shadow} = await mountPanel(mock);
        try {
            openAgentTab(shadow);
            await flush();
            assert.ok(shadow.querySelector('.body [data-interaction-id="it-1"]'), 'session-a interactions are rendered');

            clickSessionButton(shadow, 'session-a', 'Approve');
            await flush();
            assert.equal(pendingApproves.length, 1, 'approve request is in flight');

            clickSessionHead(shadow, 'session-b');
            await flush();
            const sessionBItem = shadow.querySelector('.body [data-session-id="session-b"]') as HTMLElement;
            assert.equal(sessionBItem.dataset.selected, 'true', 'selection moved to session-b');

            sessionACompleted = true;
            pendingApproves[0]?.(result('agent.interactions.approve', {
                interaction: approvedInteraction(),
                session: completedSession('session-a'),
            }));
            await flush();

            assert.equal(
                shadow.querySelector('.body [data-interaction-id="it-1"]'),
                null,
                'session-a decision must not be rendered inside session-b view',
            );
            assert.ok(shadow.querySelector('.body [data-interaction-id="it-b"]'), 'session-b interactions remain the active view');

            const approveCalls = sent.filter((call) => call.type === 'agent.interactions.approve');
            assert.equal(approveCalls.length, 1, 'approve is submitted exactly once');
            assert.deepEqual(approveCalls[0]?.payload, {
                sessionId: 'session-a',
                interactionId: 'it-1',
                revision: 0,
                approvedBy: 'extension-operator',
            });

            const sessionAItem = shadow.querySelector('.body [data-session-id="session-a"]') as HTMLElement;
            assert.equal(sessionAItem.dataset.sessionState, 'completed', 'session-a itself still updates to completed');
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('agent HITL repeated refreshes never stack parallel interaction fetches or handlers', async () => {
    const {dom, previous} = setupDom();
    try {
        const pendingLists: Array<(action: Action) => void> = [];
        let interactionsCalls = 0;
        let approveCalls = 0;
        const mock: BaseMock = {
            onAction: async (type, payload) => {
                if (type === 'agent.sessions.list') {
                    return result(type, {sessions: [pausedSession('session-a')]});
                }
                if (type === 'agent.interactions.list') {
                    interactionsCalls += 1;
                    if (interactionsCalls === 1) {
                        return result(type, {sessionId: payload?.sessionId, interactions: [pendingInteraction()]});
                    }
                    return await new Promise<Action>((resolve) => { pendingLists.push(resolve); });
                }
                if (type === 'agent.interactions.approve') {
                    approveCalls += 1;
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
        const {handle, shadow} = await mountPanel(mock);
        try {
            openAgentTab(shadow);
            await flush();
            assert.equal(interactionsCalls, 1, 'initial auto-load fetches interactions once');
            assert.ok(shadow.querySelector('.body [data-interaction-id="it-1"]'));

            clickSessionHead(shadow, 'session-a');
            clickSessionHead(shadow, 'session-a');
            await flush();
            assert.equal(interactionsCalls, 2, 're-selecting while a fetch is in flight must not stack a second fetch');
            assert.equal(pendingLists.length, 1, 'exactly one interactions fetch is in flight');

            const refreshBtn = Array.from(shadow.querySelectorAll('.body button')).find((b) => b.textContent === 'Refresh');
            click(refreshBtn);
            await flush();
            assert.equal(interactionsCalls, 2, 'a list refresh must not spawn a duplicate parallel interaction fetch');

            pendingLists[0]?.(result('agent.interactions.list', {sessionId: 'session-a', interactions: [pendingInteraction()]}));
            await flush();
            assert.equal(
                shadow.querySelectorAll('.body [data-interaction-id="it-1"]').length,
                1,
                'the interaction renders exactly once, with a single set of controls',
            );
            const approveBtn = Array.from(shadow.querySelectorAll('.body [data-session-id="session-a"] button'))
                .find((b) => b.textContent === 'Approve');
            assert.ok(approveBtn, 'a single Approve control is rendered');
            click(approveBtn);
            await flush();
            assert.equal(approveCalls, 1, 'the single rendered handler submits exactly one decision');
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('agent HITL reopen and remount never repeat an already-decided action', async () => {
    const {dom, previous} = setupDom();
    try {
        let approved = false;
        const sent: Array<{type: string; payload?: Record<string, unknown>}> = [];
        const mock: BaseMock = {
            onAction: async (type, payload) => {
                sent.push({type, payload});
                if (type === 'agent.sessions.list') {
                    return result(type, {sessions: [approved ? completedSession('session-a') : pausedSession('session-a')]});
                }
                if (type === 'agent.interactions.list') {
                    return result(type, {sessionId: payload?.sessionId, interactions: approved ? [] : [pendingInteraction()]});
                }
                if (type === 'agent.interactions.approve') {
                    approved = true;
                    return result(type, {interaction: approvedInteraction(), session: completedSession('session-a')});
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
        const {handle, shadow} = await mountPanel(mock);
        try {
            openAgentTab(shadow);
            await flush();
            clickSessionButton(shadow, 'session-a', 'Approve');
            await flush();
            assert.equal(sent.filter((call) => call.type === 'agent.interactions.approve').length, 1);

            const logTab = Array.from(shadow.querySelectorAll('.tabs button')).find((b) => b.textContent?.trim() === 'Log');
            click(logTab);
            await flush();
            openAgentTab(shadow);
            await flush();
            assert.equal(sent.filter((call) => call.type === 'agent.interactions.approve').length, 1, 'reopen must not repeat the decision');
            const reopened = shadow.querySelector('.body [data-session-id="session-a"]') as HTMLElement;
            assert.equal(reopened.dataset.sessionState, 'completed');
            assert.equal(shadow.querySelector('.body [data-interaction-id="it-1"]'), null, 'no controls after reopen');
        } finally {
            handle.unmount();
        }

        const second = mountFloatingUI({
            tabName: 'page-tab',
            workspaceName: 'ws-1',
            onAction: mock.onAction,
            onEnterAnnotation: () => undefined,
            onEntityRulePreview: async () => true,
            onCheckpointEntityRulePreview: async () => true,
        });
        try {
            await flush();
            const shadow2 = document.getElementById('rpa-floating-panel')?.shadowRoot;
            assert.ok(shadow2);
            openAgentTab(shadow2);
            await flush();
            assert.equal(sent.filter((call) => call.type === 'agent.interactions.approve').length, 1, 'remount must not repeat the decision');
            const remounted = shadow2.querySelector('.body [data-session-id="session-a"]') as HTMLElement;
            assert.equal(remounted.dataset.sessionState, 'completed');
            assert.equal(shadow2.querySelector('.body [data-interaction-id="it-1"]'), null, 'no controls after remount');
        } finally {
            second.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('agent HITL sanitizes interaction evidence so canary secrets never reach the DOM', async () => {
    const {dom, previous} = setupDom();
    try {
        const mock: BaseMock = {
            onAction: async (type, payload) => {
                if (type === 'agent.sessions.list') {
                    return result(type, {sessions: [pausedSession('session-a')]});
                }
                if (type === 'agent.interactions.list') {
                    return result(type, {
                        sessionId: payload?.sessionId,
                        interactions: [
                            pendingInteraction({
                                evidence: {
                                    summary: 'Send order to downstream API',
                                    riskLevel: 'high',
                                    args: {apiKey: 'CANARY-ARGS', selector: '#x'},
                                    rawArgs: {password: 'CANARY-RAW'},
                                },
                                rawArgs: {apiKey: 'CANARY-TOP-RAW', secret: 'x'},
                                arguments: {payload: 'CANARY-PARAMS'},
                            }),
                        ],
                    });
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
        const {handle, shadow} = await mountPanel(mock);
        try {
            openAgentTab(shadow);
            await flush();
            const bodyText = (shadow.querySelector('.body') as HTMLElement).textContent ?? '';
            assert.match(bodyText, /evidence: Send order to downstream API/);
            assert.match(bodyText, /risk: high/);
            assert.ok(!bodyText.includes('CANARY'), 'canary secrets must never be rendered');
            assert.ok(!bodyText.includes('apiKey'), 'secret key names must never be rendered');
        } finally {
            handle.unmount();
        }
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});