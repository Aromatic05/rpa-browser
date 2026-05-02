/**
 * floating_ui：只负责 UI 注入/渲染与交互绑定。
 *
 * 设计说明：
 * - 不直接发送消息，所有操作通过 onAction 回调完成。
 * - 内部维护 workspace/tab 的轻量状态，用于渲染与联动刷新。
 */

import type { Action } from '../shared/types.js';

export type FloatingUIOptions = {
    tabName: string;
    onAction: (
        type: string,
        payload?: Record<string, unknown>,
        scope?: { workspaceName?: string; tabName?: string },
    ) => Promise<Action>;
    onEvent?: (handler: (action: Action) => void) => void;
};

export type FloatingUIHandle = {
    unmount: () => void;
    scheduleRefresh: () => void;
};

export const mountFloatingUI = (opts: FloatingUIOptions): FloatingUIHandle => {
    const ROOT_ID = 'rpa-floating-panel';
    if (document.getElementById(ROOT_ID)) {
        return {
            unmount: () => undefined,
            scheduleRefresh: () => undefined,
        };
    }

    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.setAttribute('data-rpa-panel', 'true');
    host.setAttribute('data-rpa-snapshot-ignore', 'true');
    host.style.position = 'fixed';
    host.style.top = '16px';
    host.style.right = '16px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'auto';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
    :host { all: initial; }
    .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .ball {
      width: 44px; height: 44px; border-radius: 999px; border: none;
      background: #111827; color: #f9fafb; font-size: 12px; font-weight: 600;
      cursor: pointer; box-shadow: 0 10px 20px rgba(15, 23, 42, 0.3);
    }
    .panel {
      width: 260px; padding: 10px; border-radius: 12px; background: #fff;
      box-shadow: 0 12px 26px rgba(15, 23, 42, 0.2); border: 1px solid #e2e8f0;
      display: none;
    }
    .panel.open { display: block; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px; }
    .panel-section { margin-top: 8px; }
    .list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
    button {
      padding: 6px 8px; font-size: 12px; border-radius: 8px;
      border: 1px solid #cbd5f5; background: #fff; cursor: pointer;
    }
    button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
    pre {
      margin: 6px 0 0; background: #0f172a; color: #e2e8f0;
      padding: 6px; border-radius: 8px; font-size: 11px; max-height: 140px; overflow: auto;
      white-space: pre-wrap;
    }
    .meta { font-size: 11px; color: #6b7280; margin-bottom: 6px; }
  `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const ball = document.createElement('button');
    ball.className = 'ball';
    ball.textContent = 'RPA';

    const panel = document.createElement('div');
    panel.className = 'panel';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `tabName: ${opts.tabName.slice(0, 8)}…`;

    const row1 = document.createElement('div');
    row1.className = 'row';
    const startBtn = document.createElement('button');
    startBtn.className = 'primary';
    startBtn.textContent = 'Start Rec';
    const stopBtn = document.createElement('button');
    stopBtn.textContent = 'Stop Rec';
    row1.append(startBtn, stopBtn);

    const row2 = document.createElement('div');
    row2.className = 'row';
    const showBtn = document.createElement('button');
    showBtn.textContent = 'Show Rec';
    const initWorkflowBtn = document.createElement('button');
    initWorkflowBtn.textContent = 'Init Workflow';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear Rec';
    const replayBtn = document.createElement('button');
    replayBtn.className = 'primary';
    replayBtn.textContent = 'Replay';
    row2.append(showBtn, initWorkflowBtn, clearBtn);

    const row3 = document.createElement('div');
    row3.className = 'row';
    const stopReplayBtn = document.createElement('button');
    stopReplayBtn.textContent = 'Stop Replay';
    row3.append(replayBtn, stopReplayBtn);

    const row4 = document.createElement('div');
    row4.className = 'row';
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Save Artifact';
    const importBtn = document.createElement('button');
    importBtn.textContent = 'Load Artifact';
    row4.append(exportBtn, importBtn);

    const wsSection = document.createElement('div');
    wsSection.className = 'panel-section';
    const wsTitle = document.createElement('div');
    wsTitle.className = 'meta';
    wsTitle.textContent = 'Workspaces';
    const wsList = document.createElement('div');
    wsList.className = 'list';
    const wsActions = document.createElement('div');
    wsActions.className = 'row';
    const newWorkspaceBtn = document.createElement('button');
    newWorkspaceBtn.textContent = 'New Workspace';
    wsActions.append(newWorkspaceBtn);
    wsSection.append(wsTitle, wsList, wsActions);

    const tabSection = document.createElement('div');
    tabSection.className = 'panel-section';
    const tabTitle = document.createElement('div');
    tabTitle.className = 'meta';
    tabTitle.textContent = 'Tabs';
    const tabList = document.createElement('div');
    tabList.className = 'list';
    const tabActions = document.createElement('div');
    tabActions.className = 'row';
    const closeTabBtn = document.createElement('button');
    closeTabBtn.textContent = 'Close Tab';
    tabActions.append(closeTabBtn);
    tabSection.append(tabTitle, tabList, tabActions);

    const out = document.createElement('pre');
    const workflowSection = document.createElement('div');
    workflowSection.className = 'panel-section';
    const workflowTitle = document.createElement('div');
    workflowTitle.className = 'meta';
    workflowTitle.textContent = 'Workflow';
    const sceneInput = document.createElement('input');
    sceneInput.type = 'text';
    sceneInput.placeholder = 'scene';
    sceneInput.style.width = '100%';
    sceneInput.style.boxSizing = 'border-box';
    sceneInput.style.padding = '6px 8px';
    sceneInput.style.fontSize = '12px';
    sceneInput.style.borderRadius = '8px';
    sceneInput.style.border = '1px solid #cbd5f5';
    const recordingNameInput = document.createElement('input');
    recordingNameInput.type = 'text';
    recordingNameInput.placeholder = 'recording name (optional)';
    recordingNameInput.style.width = '100%';
    recordingNameInput.style.boxSizing = 'border-box';
    recordingNameInput.style.padding = '6px 8px';
    recordingNameInput.style.fontSize = '12px';
    recordingNameInput.style.borderRadius = '8px';
    recordingNameInput.style.border = '1px solid #cbd5f5';
    recordingNameInput.style.marginTop = '6px';
    workflowSection.append(workflowTitle, sceneInput, recordingNameInput);

    panel.append(meta, row1, row2, row3, row4, workflowSection, wsSection, tabSection, out);
    wrap.append(ball, panel);
    shadow.append(style, wrap);

    document.documentElement.appendChild(host);

    let isOpen = false;
    ball.addEventListener('click', () => {
        isOpen = !isOpen;
        panel.classList.toggle('open', isOpen);
    });

    const render = (payload: unknown) => {
        out.textContent = JSON.stringify(payload, null, 2);
    };

    let activeWorkspaceName: string | null = null;
    let activeTabName: string | null = null;
    let workflowInitialized = false;
    const deriveScene = (): string => {
        const explicit = sceneInput.value.trim();
        if (explicit) {return explicit;}
        const workspaceName = activeWorkspaceName || '';
        if (workspaceName.startsWith('workflow:')) {
            const scene = workspaceName.slice('workflow:'.length).trim();
            if (scene) {return scene;}
        }
        return workspaceName;
    };
    const updateInitVisibility = () => {
        const activeIsWorkflow = (activeWorkspaceName || '').startsWith('workflow:');
        const hide = workflowInitialized || activeIsWorkflow;
        initWorkflowBtn.style.display = hide ? 'none' : '';
    };

    // UI 行为统一走 onAction
    const sendPanelAction = async (
        type: string,
        payload?: Record<string, unknown>,
        scope?: { workspaceName?: string; tabName?: string },
    ): Promise<Action> => {
        const response = await opts.onAction(type, payload, scope);
        render(response);
        interceptAction(response);
        if (!response.type.endsWith('.failed') && (type === 'workflow.create' || type === 'record.save' || type === 'record.load')) {
            workflowInitialized = true;
            updateInitVisibility();
        }
        return response;
    };

    startBtn.addEventListener('click', () =>
        void sendPanelAction('record.start', {}, activeWorkspaceName ? { workspaceName: activeWorkspaceName } : undefined));
    stopBtn.addEventListener('click', () =>
        void sendPanelAction('record.stop', {}, activeWorkspaceName ? { workspaceName: activeWorkspaceName } : undefined));
    showBtn.addEventListener('click', () =>
        void sendPanelAction('record.get', {}, activeWorkspaceName ? { workspaceName: activeWorkspaceName } : undefined));
    initWorkflowBtn.addEventListener('click', () => {
        const scene = sceneInput.value.trim();
        if (!scene) {
            render({ code: 'ERR_BAD_ARGS', message: 'scene is required' });
            return;
        }
        void (async () => {
            const inited = await sendPanelAction('workflow.create', { scene });
            if (inited.type.endsWith('.failed')) {return;}
            const opened = await sendPanelAction('workflow.open', { scene });
            if (opened.type.endsWith('.failed')) {return;}
            refreshWorkspaces();
            refreshTabs();
        })();
    });
    clearBtn.addEventListener('click', () =>
        void sendPanelAction('record.clear', {}, activeWorkspaceName ? { workspaceName: activeWorkspaceName } : undefined));
    replayBtn.addEventListener('click', () =>
        void sendPanelAction('play.start', {}, activeWorkspaceName ? { workspaceName: activeWorkspaceName } : undefined));
    stopReplayBtn.addEventListener('click', () =>
        void sendPanelAction('play.stop', {}, activeWorkspaceName ? { workspaceName: activeWorkspaceName } : undefined));
    exportBtn.addEventListener('click', () => {
        void (async () => {
            const scope = activeWorkspaceName ? { workspaceName: activeWorkspaceName } : undefined;
            const scene = deriveScene();
            if (!scene) {
                render({ code: 'ERR_BAD_ARGS', message: 'scene is required (or select a workspace first)' });
                return;
            }
            const recordingName = recordingNameInput.value.trim();
            await sendPanelAction('record.save', {
                scene,
                ...(recordingName ? { recordingName } : {}),
                includeStepResolve: true,
            }, scope);
        })();
    });
    importBtn.addEventListener('click', () => {
        void (async () => {
            const scope = activeWorkspaceName ? { workspaceName: activeWorkspaceName } : undefined;
            const scene = deriveScene();
            if (!scene) {
                render({ code: 'ERR_BAD_ARGS', message: 'scene is required (or select a workspace first)' });
                return;
            }
            const recordingName = recordingNameInput.value.trim();
            await sendPanelAction('record.load', {
                scene,
                ...(recordingName ? { recordingName } : {}),
            }, scope);
        })();
    });

    const renderWorkspaces = (
        workspaces: Array<{ workspaceName: string; activeTabName?: string; tabCount: number }>,
    ) => {
        wsList.innerHTML = '';
        if (!activeWorkspaceName && workspaces.length) {
            activeWorkspaceName = workspaces[0].workspaceName;
        }
        if (activeWorkspaceName?.startsWith('workflow:')) {
            const scene = activeWorkspaceName.slice('workflow:'.length).trim();
            if (scene && !sceneInput.value.trim()) {sceneInput.value = scene;}
        }
        updateInitVisibility();
        workspaces.forEach((ws) => {
            const btn = document.createElement('button');
            btn.textContent = `${ws.workspaceName.slice(0, 6)}… (${String(ws.tabCount)})`;
            if (activeWorkspaceName === ws.workspaceName) {
                btn.classList.add('primary');
            }
            btn.addEventListener('click', () => {
                activeWorkspaceName = ws.workspaceName;
                void sendPanelAction('workspace.setActive', {}, { workspaceName: ws.workspaceName });
                refreshTabs();
            });
            wsList.appendChild(btn);
        });
    };

    const renderTabs = (tabs: Array<{ tabName: string; url: string; title: string; active: boolean }>) => {
        tabList.innerHTML = '';
        tabs.forEach((tab) => {
            const btn = document.createElement('button');
            btn.textContent = `${tab.tabName.slice(0, 6)}… ${tab.title || tab.url || ''}`;
            if (tab.active) {
                btn.classList.add('primary');
                activeTabName = tab.tabName;
            }
            btn.addEventListener('click', () => {
                activeTabName = tab.tabName;
                if (activeWorkspaceName) {
                    void sendPanelAction('tab.setActive', { tabName: tab.tabName }, { workspaceName: activeWorkspaceName });
                } else {
                    void sendPanelAction('tab.setActive', { tabName: tab.tabName });
                }
                refreshTabs();
            });
            tabList.appendChild(btn);
        });
    };

    const refreshWorkspaces = () => {
        void sendPanelAction('workspace.list', {}, undefined);
    };

    const refreshTabs = () => {
        if (activeWorkspaceName) {
            void sendPanelAction('tab.list', {}, { workspaceName: activeWorkspaceName });
        } else {
            void sendPanelAction('tab.list', {});
        }
    };

    newWorkspaceBtn.addEventListener('click', () => {
        void (async () => {
            const action = await sendPanelAction('workspace.create', {});
            const payload = (action.payload ?? {}) as { workspaceName?: string };
            if (payload.workspaceName) {activeWorkspaceName = payload.workspaceName;}
            refreshWorkspaces();
            refreshTabs();
        })();
    });

    closeTabBtn.addEventListener('click', () => {
        if (!activeTabName) {return;}
        void (async () => {
            if (activeWorkspaceName) {
                await sendPanelAction('tab.close', { tabName: activeTabName }, { workspaceName: activeWorkspaceName });
            } else {
                await sendPanelAction('tab.close', { tabName: activeTabName });
            }

            const listed = await sendPanelAction('workspace.list', {});
            const listPayload = (listed.payload ?? {}) as {
                workspaces?: Array<{ workspaceName: string }>;
            };
            const workspaces = listPayload.workspaces ?? [];

            if (!workspaces.length) {
                const created = await sendPanelAction('workspace.create', {});
                const createdPayload = (created.payload ?? {}) as { workspaceName?: string };
                activeWorkspaceName = createdPayload.workspaceName ?? null;
                refreshWorkspaces();
                refreshTabs();
                return;
            }

            activeWorkspaceName = workspaces[0].workspaceName;
            await sendPanelAction('workspace.setActive', {}, { workspaceName: activeWorkspaceName });
            refreshTabs();
        })();
    });

    const interceptAction = (action: Action) => {
        if (action.type.endsWith('.failed')) {return;}
        const payload = (action.payload ?? {}) as {
            activeWorkspaceName?: string;
            workspaces?: Array<{ workspaceName: string; activeTabName?: string; tabCount: number }>;
            tabs?: Array<{ tabName: string; url: string; title: string; active: boolean }>;
        };
        if (payload.workspaces) {
            if (payload.activeWorkspaceName) {
                activeWorkspaceName = payload.activeWorkspaceName;
            }
            renderWorkspaces(payload.workspaces);
        }
        if (payload.tabs) {
            renderTabs(payload.tabs);
        }
    };

    opts.onEvent?.((action) => {
        render(action);
        interceptAction(action);
    });

    refreshWorkspaces();
    refreshTabs();
    updateInitVisibility();

    let refreshPending = false;
    const scheduleRefresh = () => {
        if (refreshPending) {return;}
        refreshPending = true;
        queueMicrotask(() => {
            refreshPending = false;
            refreshWorkspaces();
            refreshTabs();
        });
    };

    return {
        unmount: () => {
            host.remove();
        },
        scheduleRefresh,
    };
};
