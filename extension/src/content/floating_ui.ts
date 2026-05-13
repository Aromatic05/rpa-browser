import type { Action } from '../shared/types.js';
import { preparePanelAction, pushPanelLog, type PanelLogEntry } from './panel_actions.js';

export type FloatingUIOptions = {
    tabName: string;
    workspaceName: string;
    onAction: (
        type: string,
        payload?: Record<string, unknown>,
        address?: { workspaceName?: string; tabName?: string },
    ) => Promise<Action>;
    onEvent?: (handler: (action: Action) => void) => void;
};

export type FloatingUIHandle = {
    unmount: () => void;
    scheduleRefresh: () => void;
};

type WorkspaceItem = { workspaceName: string; activeTabName?: string; tabCount: number };
type TabItem = { tabName: string; url: string; title: string; active: boolean };

type ViewKey = 'Conn' | 'WS' | 'Tabs' | 'Rec' | 'Play' | 'Flow' | 'Log';

export const mountFloatingUI = (opts: FloatingUIOptions): FloatingUIHandle => {
    const ROOT_ID = 'rpa-floating-panel';
    if (document.getElementById(ROOT_ID)) {
        return { unmount: () => undefined, scheduleRefresh: () => undefined };
    }

    const state = {
        activeView: 'Conn' as ViewKey,
        activeWorkspaceName: opts.workspaceName || '',
        activeTabName: '',
        workspaces: [] as WorkspaceItem[],
        tabs: [] as TabItem[],
        workflowName: '',
        targetName: '',
        recordingName: '',
        lastReply: '' as string,
        logs: [] as PanelLogEntry[],
        playEvents: [] as string[],
        replaySource: 'unsaved' as string,
        savedRecordings: [] as Array<{ recordingName: string; stepCount: number }>,
        unsavedStepCount: 0,
        dslRaw: '{}',
        checkpointRaw: '{}',
        entityRulesRaw: '{}',
    };

    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.setAttribute('data-rpa-panel', 'true');
    host.setAttribute('data-rpa-snapshot-ignore', 'true');
    host.style.position = 'fixed';
    host.style.top = '16px';
    host.style.right = '16px';
    host.style.zIndex = '2147483647';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .wrap { display:flex; flex-direction:column; align-items:flex-end; gap:8px; font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
      .ball { width:44px; height:44px; border-radius:999px; border:none; background:#111827; color:#f9fafb; font-size:12px; font-weight:700; cursor:pointer; }
      .panel { width:420px; border-radius:12px; background:#fff; border:1px solid #e2e8f0; box-shadow:0 12px 28px rgba(15,23,42,.24); display:none; overflow:hidden; }
      .panel.open { display:block; }
      .tabs { display:flex; border-bottom:1px solid #e2e8f0; background:#f8fafc; }
      .tabs button { border:none; border-right:1px solid #e2e8f0; border-radius:0; background:transparent; padding:8px 10px; font-size:12px; cursor:pointer; }
      .tabs button.active { background:#dbeafe; color:#1d4ed8; font-weight:700; }
      .body { padding:10px; max-height:360px; overflow:auto; }
      .row { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:6px; align-items:center; }
      .row3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-bottom:6px; align-items:center; }
      .section { margin-bottom:10px; border:1px solid #e2e8f0; border-radius:8px; padding:8px; }
      .title { font-size:11px; color:#475569; margin-bottom:6px; font-weight:700; }
      button { padding:6px 8px; font-size:12px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; cursor:pointer; }
      button.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
      input, textarea { width:100%; box-sizing:border-box; padding:6px 8px; font-size:12px; border-radius:8px; border:1px solid #cbd5e1; }
      textarea { min-height:72px; resize:vertical; }
      .hint { font-size:11px; color:#64748b; margin-bottom:6px; }
      .list { display:flex; flex-direction:column; gap:6px; }
      .footer { border-top:1px solid #e2e8f0; padding:8px; background:#0f172a; color:#e2e8f0; }
      .footer pre { margin:0; max-height:120px; overflow:auto; white-space:pre-wrap; font-size:11px; }
      .log-list { display:flex; flex-direction:column; gap:6px; }
      .log-item { font-size:11px; border:1px solid #e2e8f0; border-radius:6px; padding:6px; }
    `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const ball = document.createElement('button');
    ball.className = 'ball';
    ball.textContent = 'RPA';
    const panel = document.createElement('div');
    panel.className = 'panel';
    const tabsBar = document.createElement('div');
    tabsBar.className = 'tabs';
    const body = document.createElement('div');
    body.className = 'body';
    const footer = document.createElement('div');
    footer.className = 'footer';
    const out = document.createElement('pre');
    footer.appendChild(out);

    panel.append(tabsBar, body, footer);
    wrap.append(ball, panel);
    shadow.append(style, wrap);
    document.documentElement.appendChild(host);

    let isOpen = false;
    ball.addEventListener('click', () => {
        isOpen = !isOpen;
        panel.classList.toggle('open', isOpen);
    });

    const setOutput = (value: unknown) => {
        state.lastReply = JSON.stringify(value, null, 2);
        out.textContent = state.lastReply;
    };

    const logAction = (kind: PanelLogEntry['kind'], action: Action) => {
        state.logs = pushPanelLog(state.logs, { at: Date.now(), kind, action });
    };

    const sendPanelAction = async (type: string, payload?: Record<string, unknown>): Promise<Action> => {
        const prepared = preparePanelAction(type, payload, state.activeWorkspaceName || null);
        if ('error' in prepared) {
            setOutput(prepared.error);
            logAction('failed', prepared.error);
            renderActiveView();
            return prepared.error;
        }
        const request: Action = {
            v: 1,
            id: crypto.randomUUID(),
            type: prepared.type,
            ...(prepared.address?.workspaceName ? { workspaceName: prepared.address.workspaceName } : {}),
            ...(prepared.payload ? { payload: prepared.payload } : {}),
        };
        logAction('request', request);
        const reply = await opts.onAction(prepared.type, prepared.payload, prepared.address);
        logAction(reply.type.endsWith('.failed') ? 'failed' : 'reply', reply);
        setOutput(reply);
        interceptAction(reply, prepared.type);
        renderActiveView();
        return reply;
    };

    const refreshWorkspaces = async () => {
        await sendPanelAction('workspace.list', {});
    };
    const refreshTabs = async () => {
        await sendPanelAction('tab.list', {});
    };
    const refreshRecordings = async () => {
        await sendPanelAction('record.list', {});
    };

    const parseJsonOrErr = (raw: string): Record<string, unknown> | null => {
        try {
            const parsed = JSON.parse(raw || '{}');
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                setOutput({ code: 'ERR_BAD_ARGS', message: 'JSON must be object' });
                return null;
            }
            return parsed as Record<string, unknown>;
        } catch {
            setOutput({ code: 'ERR_BAD_ARGS', message: 'Invalid JSON' });
            return null;
        }
    };

    const addPlayEvent = (action: Action) => {
        const keys = ['play.started', 'play.step.started', 'play.step.finished', 'play.progress', 'play.completed', 'play.failed', 'play.canceled'];
        if (!keys.includes(action.type)) {return;}
        const payload = (action.payload && typeof action.payload === 'object') ? action.payload as Record<string, unknown> : {};
        const summary = `${action.type} ${JSON.stringify(payload).slice(0, 120)}`;
        state.playEvents = [...state.playEvents, summary].slice(-20);
    };

    const interceptAction = (action: Action, requestType?: string) => {
        const payload = (action.payload && typeof action.payload === 'object') ? action.payload as Record<string, unknown> : {};
        if (Array.isArray(payload.workspaces)) {
            state.workspaces = payload.workspaces as WorkspaceItem[];
            const activeWs = typeof payload.activeWorkspaceName === 'string' ? payload.activeWorkspaceName : '';
            if (activeWs) {
                state.activeWorkspaceName = activeWs;
            } else if (!state.activeWorkspaceName && state.workspaces.length > 0) {
                state.activeWorkspaceName = state.workspaces[0].workspaceName;
            }
        }
        if (Array.isArray(payload.tabs)) {
            state.tabs = payload.tabs as TabItem[];
            const activeTab = state.tabs.find((t) => t.active);
            state.activeTabName = activeTab?.tabName || '';
        }
        if (Array.isArray(payload.recordings)) {
            state.savedRecordings = payload.recordings
                .filter((item) => item && typeof item === 'object')
                .map((item) => {
                    const row = item as Record<string, unknown>;
                    return {
                        recordingName: String(row.recordingName || ''),
                        stepCount: Number(row.stepCount || 0),
                    };
                })
                .filter((item) => Boolean(item.recordingName));
        }
        if (payload.unsaved && typeof payload.unsaved === 'object') {
            const unsaved = payload.unsaved as Record<string, unknown>;
            state.unsavedStepCount = Number(unsaved.stepCount || 0);
        }
        if (requestType === 'workspace.setActive' && !action.type.endsWith('.failed')) {
            void refreshTabs();
        }
        if (requestType === 'workflow.open' && !action.type.endsWith('.failed')) {
            void refreshWorkspaces();
            void refreshTabs();
            void refreshRecordings();
        }
        if (requestType === 'tab.setActive' && !action.type.endsWith('.failed')) {
            void refreshTabs();
        }
        if (requestType === 'workflow.saveAs' && !action.type.endsWith('.failed')) {
            void refreshWorkspaces();
            void refreshTabs();
            void refreshRecordings();
        }
        if (requestType === 'workflow.resetDefault' && !action.type.endsWith('.failed')) {
            void refreshWorkspaces();
            void refreshTabs();
            void refreshRecordings();
        }
        addPlayEvent(action);
    };

    const createButton = (label: string, onClick: () => unknown | Promise<unknown>, primary = false) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        if (primary) {btn.classList.add('primary');}
        btn.addEventListener('click', () => {
            void Promise.resolve(onClick());
        });
        return btn;
    };

    const renderConn = () => {
        const box = document.createElement('div');
        box.className = 'section';
        box.innerHTML = `
          <div class="title">Connection</div>
          <div class="hint">activeWorkspaceName: ${state.activeWorkspaceName || '-'}</div>
          <div class="hint">activeTabName: ${state.activeTabName || '-'}</div>
          <div class="hint">tabName: ${opts.tabName}</div>
          <div class="hint">url: ${location.href}</div>
          <div class="hint">title: ${document.title}</div>
        `;
        const row = document.createElement('div');
        row.className = 'row';
        row.append(
            createButton('Refresh', async () => { await refreshWorkspaces(); await refreshTabs(); }, true),
            createButton('Reset Default', async () => { await sendPanelAction('workflow.resetDefault', {}); }),
        );
        const row2 = document.createElement('div');
        row2.className = 'row';
        row2.append(
            createButton('Clear Output', () => setOutput({})),
            createButton('record.list', refreshRecordings),
        );
        box.appendChild(row2);
        box.appendChild(row);
        return box;
    };

    const renderWS = () => {
        const root = document.createElement('div');
        const wsBox = document.createElement('div');
        wsBox.className = 'section';
        wsBox.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Workspaces' }));
        const wsList = document.createElement('div');
        wsList.className = 'list';
        state.workspaces.forEach((ws) => {
            wsList.appendChild(createButton(`${ws.workspaceName} (${ws.tabCount})`, async () => {
                state.activeWorkspaceName = ws.workspaceName;
                await sendPanelAction('workspace.setActive', { workspaceName: ws.workspaceName });
            }, ws.workspaceName === state.activeWorkspaceName));
        });
        wsBox.append(wsList);
        const wsRow = document.createElement('div');
        wsRow.className = 'row';
        wsRow.append(
            createButton('Refresh WS', refreshWorkspaces),
            createButton('Create WS', async () => { await sendPanelAction('workspace.create', {}); await refreshWorkspaces(); }),
        );
        wsBox.append(wsRow);

        const wfBox = document.createElement('div');
        wfBox.className = 'section';
        wfBox.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Workflow' }));
        const workflowInput = document.createElement('input');
        workflowInput.placeholder = 'workflowName';
        workflowInput.value = state.workflowName;
        workflowInput.addEventListener('input', () => { state.workflowName = workflowInput.value; });
        wfBox.append(workflowInput);
        const wfRow1 = document.createElement('div');
        wfRow1.className = 'row';
        wfRow1.append(
            createButton('workflow.list', () => sendPanelAction('workflow.list', {})),
            createButton('workflow.create', () => sendPanelAction('workflow.create', { workflowName: state.workflowName.trim() })),
        );
        const wfRow2 = document.createElement('div');
        wfRow2.className = 'row';
        wfRow2.append(createButton('workflow.open', async () => {
            const reply = await sendPanelAction('workflow.open', { workflowName: state.workflowName.trim() });
            if (!reply.type.endsWith('.failed')) { await refreshWorkspaces(); await refreshTabs(); }
        }, true));
        wfBox.append(wfRow1, wfRow2);
        const resetRow = document.createElement('div');
        resetRow.className = 'row';
        resetRow.append(createButton('workflow.resetDefault', () => sendPanelAction('workflow.resetDefault', {})));
        wfBox.append(resetRow);

        const saveAsBox = document.createElement('div');
        saveAsBox.className = 'section';
        saveAsBox.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Save As' }));
        const targetInput = document.createElement('input');
        targetInput.placeholder = 'targetName';
        targetInput.value = state.targetName;
        targetInput.addEventListener('input', () => { state.targetName = targetInput.value; });
        saveAsBox.append(targetInput);
        const saveAsRow = document.createElement('div');
        saveAsRow.className = 'row';
        saveAsRow.append(createButton('workflow.saveAs', async () => {
            const reply = await sendPanelAction('workflow.saveAs', {
                sourceName: state.activeWorkspaceName.trim(),
                targetName: state.targetName.trim(),
            });
            if (!reply.type.endsWith('.failed')) {
                await refreshWorkspaces();
                await refreshTabs();
                await refreshRecordings();
            }
        }, true));
        saveAsBox.append(saveAsRow);
        root.append(wsBox, wfBox, saveAsBox);
        return root;
    };

    const renderTabsTab = () => {
        const root = document.createElement('div');
        const box = document.createElement('div');
        box.className = 'section';
        box.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: `Tabs @ ${state.activeWorkspaceName || '-'}` }));
        const list = document.createElement('div');
        list.className = 'list';
        state.tabs.forEach((tab) => {
            list.appendChild(createButton(`${tab.tabName} ${tab.title || tab.url || ''}`.slice(0, 60), () => sendPanelAction('tab.setActive', { tabName: tab.tabName }), tab.active));
        });
        box.append(list);
        const row1 = document.createElement('div');
        row1.className = 'row';
        row1.append(
            createButton('tab.list', refreshTabs),
            createButton('tab.create', () => { chrome.tabs.create({}); }),
        );
        const row2 = document.createElement('div');
        row2.className = 'row';
        row2.append(createButton('tab.close', () => {
            if (!state.activeTabName) {return;}
            return sendPanelAction('tab.close', { tabName: state.activeTabName });
        }));
        box.append(row1, row2);
        root.append(box);
        return root;
    };

    const renderRec = () => {
        const box = document.createElement('div');
        box.className = 'section';
        box.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Record' }));
        const row1 = document.createElement('div');
        row1.className = 'row';
        row1.append(createButton('record.start', () => sendPanelAction('record.start', {}), true), createButton('record.stop', () => sendPanelAction('record.stop', {})));
        const row2 = document.createElement('div');
        row2.className = 'row';
        row2.append(createButton('Get Unsaved', () => sendPanelAction('record.get', {})), createButton('Clear Unsaved', () => sendPanelAction('record.clear', {})));
        const row3 = document.createElement('div');
        row3.className = 'row3';
        const input = document.createElement('input');
        input.placeholder = 'recordingName';
        input.value = state.recordingName;
        input.addEventListener('input', () => { state.recordingName = input.value; });
        row3.append(
            input,
            createButton('Save Recording', () => sendPanelAction('record.save', { recordingName: state.recordingName.trim(), includeStepResolve: true }), true),
            createButton('record.list', () => sendPanelAction('record.list', {})),
        );
        const list = document.createElement('div');
        list.className = 'list';
        const unsaved = document.createElement('div');
        unsaved.className = 'hint';
        unsaved.textContent = `unsaved stepCount: ${state.unsavedStepCount}`;
        list.append(unsaved);
        state.savedRecordings.forEach((item) => {
            const line = document.createElement('div');
            line.className = 'hint';
            line.textContent = `${item.recordingName} (${item.stepCount})`;
            list.append(line);
        });
        box.append(row1, row2, row3, list);
        return box;
    };

    const renderPlay = () => {
        const root = document.createElement('div');
        const box = document.createElement('div');
        box.className = 'section';
        box.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Play' }));
        const source = document.createElement('select');
        source.innerHTML = '';
        const unsavedOption = document.createElement('option');
        unsavedOption.value = 'unsaved';
        unsavedOption.textContent = 'Unsaved current recording';
        source.appendChild(unsavedOption);
        state.savedRecordings.forEach((item) => {
            const option = document.createElement('option');
            option.value = item.recordingName;
            option.textContent = `${item.recordingName} (${item.stepCount})`;
            source.appendChild(option);
        });
        source.value = state.replaySource;
        source.addEventListener('change', () => { state.replaySource = source.value; });
        box.append(source);
        const row = document.createElement('div');
        row.className = 'row';
        row.append(
            createButton('Play', () => sendPanelAction('play.start', state.replaySource === 'unsaved' ? {} : { recordingName: state.replaySource }), true),
            createButton('Stop', () => sendPanelAction('play.stop', {})),
        );
        box.append(row);
        const events = document.createElement('div');
        events.className = 'list';
        state.playEvents.slice().reverse().forEach((item) => {
            const line = document.createElement('div');
            line.className = 'hint';
            line.textContent = item;
            events.appendChild(line);
        });
        box.append(events);
        root.append(box);
        return root;
    };

    const renderFlow = () => {
        const root = document.createElement('div');
        const renderSub = (title: string, raw: string, setRaw: (v: string) => void, actions: Array<{ label: string; type: string }>) => {
            const box = document.createElement('div');
            box.className = 'section';
            box.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: title }));
            const ta = document.createElement('textarea');
            ta.value = raw;
            ta.addEventListener('input', () => { setRaw(ta.value); });
            box.append(ta);
            const rows = document.createElement('div');
            rows.className = 'row';
            actions.forEach((it) => {
                rows.appendChild(createButton(it.label, () => {
                    if (it.type.endsWith('.save') || it.type.endsWith('.delete') || it.type.endsWith('.test') || it.type.endsWith('.run') || it.type.endsWith('.get')) {
                        const parsed = parseJsonOrErr(ta.value);
                        if (!parsed) {return;}
                        return sendPanelAction(it.type, parsed);
                    }
                    return sendPanelAction(it.type, {});
                }));
            });
            box.append(rows);
            return box;
        };
        root.append(
            renderSub('DSL', state.dslRaw, (v) => { state.dslRaw = v; }, [
                { label: 'dsl.get', type: 'dsl.get' },
                { label: 'dsl.save', type: 'dsl.save' },
                { label: 'dsl.test', type: 'dsl.test' },
                { label: 'dsl.run', type: 'dsl.run' },
            ]),
            renderSub('Checkpoint', state.checkpointRaw, (v) => { state.checkpointRaw = v; }, [
                { label: 'checkpoint.list', type: 'checkpoint.list' },
                { label: 'checkpoint.get', type: 'checkpoint.get' },
                { label: 'checkpoint.save', type: 'checkpoint.save' },
                { label: 'checkpoint.delete', type: 'checkpoint.delete' },
            ]),
            renderSub('Entity Rules', state.entityRulesRaw, (v) => { state.entityRulesRaw = v; }, [
                { label: 'entity_rules.list', type: 'entity_rules.list' },
                { label: 'entity_rules.get', type: 'entity_rules.get' },
                { label: 'entity_rules.save', type: 'entity_rules.save' },
                { label: 'entity_rules.delete', type: 'entity_rules.delete' },
            ]),
        );
        return root;
    };

    const renderLog = () => {
        const root = document.createElement('div');
        const box = document.createElement('div');
        box.className = 'section';
        box.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Recent Actions (50)' }));
        const row = document.createElement('div');
        row.className = 'row';
        row.append(
            createButton('Clear Log', () => { state.logs = []; renderActiveView(); }),
            createButton('Copy Last', async () => {
                const last = state.logs[state.logs.length - 1];
                if (!last) {return;}
                await navigator.clipboard.writeText(JSON.stringify(last.action));
            }),
        );
        box.append(row);
        const list = document.createElement('div');
        list.className = 'log-list';
        state.logs.slice().reverse().forEach((item) => {
            const el = document.createElement('div');
            el.className = 'log-item';
            const p = (item.action.payload && typeof item.action.payload === 'object') ? JSON.stringify(item.action.payload).slice(0, 100) : '';
            el.textContent = `[${item.kind}] ${item.action.type} ws=${item.action.workspaceName || '-'} replyTo=${item.action.replyTo || '-'} payload=${p}`;
            list.appendChild(el);
        });
        box.append(list);
        root.append(box);
        return root;
    };

    const renderActiveView = () => {
        body.innerHTML = '';
        if (state.activeView === 'Conn') {body.appendChild(renderConn());}
        if (state.activeView === 'WS') {body.appendChild(renderWS());}
        if (state.activeView === 'Tabs') {body.appendChild(renderTabsTab());}
        if (state.activeView === 'Rec') {body.appendChild(renderRec());}
        if (state.activeView === 'Play') {body.appendChild(renderPlay());}
        if (state.activeView === 'Flow') {body.appendChild(renderFlow());}
        if (state.activeView === 'Log') {body.appendChild(renderLog());}
    };

    const views: ViewKey[] = ['Conn', 'WS', 'Tabs', 'Rec', 'Play', 'Flow', 'Log'];
    views.forEach((name) => {
        const btn = document.createElement('button');
        btn.textContent = name;
        btn.addEventListener('click', () => {
            state.activeView = name;
            Array.from(tabsBar.children).forEach((c) => c.classList.remove('active'));
            btn.classList.add('active');
            renderActiveView();
        });
        if (name === state.activeView) {btn.classList.add('active');}
        tabsBar.appendChild(btn);
    });

    opts.onEvent?.((action) => {
        logAction('event', action);
        setOutput(action);
        interceptAction(action);
        renderActiveView();
    });

    void refreshWorkspaces();
    void refreshTabs();
    void refreshRecordings();
    renderActiveView();

    let refreshPending = false;
    const scheduleRefresh = () => {
        if (refreshPending) {return;}
        refreshPending = true;
        queueMicrotask(() => {
            refreshPending = false;
            void refreshWorkspaces();
            void refreshTabs();
        });
    };

    return { unmount: () => host.remove(), scheduleRefresh };
};
