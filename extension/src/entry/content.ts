/**
 * Content script 入口：注入悬浮 UI + tabName，并与 SW 通信。
 *
 * 注意：
 * - 内容脚本是“非 module”脚本，禁止静态 import。
 * - 需要延迟加载录制模块（动态 import）以避免报错。
 * - 运行在页面上下文，不能直接访问 tabs API。
 * - 仅处理 UI 与消息，不做持久化。
 */

type ActionScopeInput = {
    workspaceName?: string;
    tabName?: string;
};

type ActionShape = {
    v: 1;
    id: string;
    type: string;
    workspaceName?: string;
    payload?: unknown;
};

type EntityRuleSelection = {
    profileName: string;
    businessTag: string;
    entityKind: 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv';
};

type FloatingUIExports = {
    mountFloatingUI: (opts: {
        tabName: string;
        workspaceName: string;
        onAction: (type: string, payload?: unknown, scope?: Record<string, unknown>) => Promise<unknown>;
        onEvent?: (handler: (action: ActionShape) => void) => void;
        onEnterAnnotation?: (profileName?: string) => void;
        onEntityRulePreview?: (selection: EntityRuleSelection | null) => Promise<boolean>;
        onCheckpointEntityRulePreview?: (selection: EntityRuleSelection | null) => Promise<boolean>;
    }) => {
        scheduleRefresh: () => void;
        onPageChanged: () => void;
        setPageWorkspace: (workspaceName: string) => void;
        setAnnotatorDebugState: (detail: string) => void;
    };
};

type AnnotatorHandle = {
    unmount: () => void;
    show: () => void;
    hide: () => void;
    setState: (state: unknown) => void;
    getState: () => unknown;
    open: (result: unknown) => void;
    exit: () => void;
    setInteractionMode: (mode: 'edit' | 'inspect' | 'passthrough') => void;
};

type AnnotatorSessionController = {
    openEditor: (profileName?: string) => Promise<boolean>;
    previewRule: (selection: EntityRuleSelection | null) => Promise<boolean>;
    previewCheckpoint: (selection: EntityRuleSelection | null) => Promise<boolean>;
    close: (owner?: 'editor' | 'rule-preview' | 'checkpoint-preview') => void;
};

type AnnotatorSessionControllerExports = {
    createAnnotatorSessionController: (options: {
        ensureHandle: () => Promise<AnnotatorHandle | null>;
        open: (payload: Record<string, unknown>) => Promise<ActionShape>;
        pageUrl: () => string;
        onEditorActiveChange?: (active: boolean) => void;
        onError?: (owner: string, error: unknown) => void;
    }) => AnnotatorSessionController;
};

type AnnotatorExports = {
    startAnnotator: (
        handlers: {
            onExit: () => void;
            onUndo: () => void;
            onRedo: () => void;
            onCheck: () => void;
            onSave: () => void;
            dispatch?: (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
            onDebugState?: (detail: string) => void;
        },
        doc?: Document,
    ) => AnnotatorHandle;
};

type TokenBridgeExports = {
    ensureTabName: () => string;
    ensureTabNameAsync: () => Promise<{ tabName: string; workspaceName: string }>;
    bindHello: (tabName: string, onHello?: () => void) => () => void;
};

type ProtocolExports = {
    MSG: Record<string, string>;
};

type SendExports = {
    send: {
        action: (action: ActionShape) => Promise<unknown>;
    };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
const isOrdinaryPageUrl = (url: string): boolean =>
    url.startsWith('http://') || url.startsWith('https://');
const isRuntimeBootstrapPage = (): boolean => {
    try {
        return new URL(location.href).searchParams.get('rpaRuntimeBootstrap') === '1';
    } catch {
        return false;
    }
};
const UUIDorUnsafe = (): string => {
    if (typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    const now = Date.now().toString(16).padStart(12, '0');
    return `${rand()}-${rand().slice(0, 4)}-4${rand().slice(0, 3)}-a${rand().slice(0, 3)}-${now}${rand().slice(0, 4)}`.slice(0, 36);
};

// 协议与发送模块（动态 import，避免内容脚本模块化限制）
const loadProtocol = (() => {
    let cached: Promise<ProtocolExports> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('shared/protocol.js');
            cached = import(url) as Promise<ProtocolExports>;
        }
        return cached;
    };
})();

const loadSend = (() => {
    let cached: Promise<SendExports> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('shared/send.js');
            cached = import(url) as Promise<SendExports>;
        }
        return cached;
    };
})();

const loadTokenBridge = (() => {
    let cached: Promise<TokenBridgeExports> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('content/token_bridge.js');
            cached = import(url) as Promise<TokenBridgeExports>;
        }
        return cached;
    };
})();


const loadFloatingUI = (() => {
    let cached: Promise<FloatingUIExports> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('content/floating_ui.js');
            cached = import(url) as Promise<FloatingUIExports>;
        }
        return cached;
    };
})();

const loadAnnotator = (() => {
    let cached: Promise<AnnotatorExports> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('annotator/annotator.js');
            cached = import(url) as Promise<AnnotatorExports>;
        }
        return cached;
    };
})();

const loadAnnotatorSessionController = (() => {
    let cached: Promise<AnnotatorSessionControllerExports> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('content/annotator_session_controller.js');
            cached = import(url) as Promise<AnnotatorSessionControllerExports>;
        }
        return cached;
    };
})();

(() => {
    // 幂等保护：避免重复注入 UI 与监听器
    if (window.top !== window) {return;}
    if (isRuntimeBootstrapPage()) {
        chrome.runtime.sendMessage({type: 'RPA_RUNTIME_BOOTSTRAP_WAKE'}, () => {
            void chrome.runtime.lastError;
        });
        return;
    }
    if (window.__rpaTokenInjected) {return;}
    window.__rpaTokenInjected = true;

    // tabName + hello 绑定（异步初始化，所有使用点需 await）
    let tokenReady: Promise<{ tabName: string; workspaceName: string }> | null = null;
    let currentBinding: { tabName: string; workspaceName: string } | null = null;
    let lastReportedUrl = '';
    let onPageContextChanged = (): void => undefined;
    const sendReport = async (workspaceName?: string) => {
        const resolved = workspaceName ? { workspaceName } : await ensureToken();
        const { send } = await loadSend();
        await send.action({
            v: 1,
            id: UUIDorUnsafe(),
            type: 'tab.report',
            workspaceName: resolved.workspaceName,
            payload: {
                source: 'extension.content',
                url: location.href,
                title: document.title,
                at: Date.now(),
            },
        });
    };
    const sendReportIfUrlChanged = async (workspaceName?: string, force = false) => {
        const url = location.href;
        if (!force && url === lastReportedUrl) {return;}
        await sendReport(workspaceName);
        lastReportedUrl = url;
    };
    const ensureToken = () => {
        if (currentBinding) {
            return Promise.resolve(currentBinding);
        }
        tokenReady ??= (async () => {
                const mod = await loadTokenBridge();
                const result = await mod.ensureTabNameAsync();
                currentBinding = result;
                mod.bindHello(result.tabName, () => {
                    // hello is only for binding refresh; URL ownership is handled
                    // by report-on-change hooks below.
                });
                return result;
            })();
        return tokenReady;
    };
    const bindReportOnUrlChange = () => {
        const emit = () => {
            if (!isOrdinaryPageUrl(location.href)) {return;}
            if (location.href === lastReportedUrl) {return;}
            onPageContextChanged();
            void sendReportIfUrlChanged();
        };
        const bridge = document.createElement('script');
        bridge.src = chrome.runtime.getURL('content/url_change_bridge.js');
        bridge.async = false;
        bridge.setAttribute('data-rpa-snapshot-ignore', 'true');
        bridge.addEventListener('load', () => {bridge.remove();}, {once: true});
        bridge.addEventListener('error', () => {bridge.remove();}, {once: true});
        const bridgeParent = document.querySelector('head') ?? document.documentElement;
        bridgeParent.appendChild(bridge);
        window.addEventListener('rpa:url-changed', emit);
        window.addEventListener('popstate', emit);
        window.addEventListener('hashchange', emit);
        window.addEventListener('pageshow', emit);
    };

    chrome.runtime.onMessage.addListener(
        (
            message: unknown,
            _sender: chrome.runtime.MessageSender,
            sendResponse: (response?: unknown) => void,
        ) => {
            // 消息接收入口：token 查询 + 录制 start/stop
            void (async () => {
                const { MSG } = await loadProtocol();
                if (!isRecord(message)) {return;}
                if (message.type === MSG.GET_TOKEN) {
                    const mod = await loadTokenBridge();
                    const tabName = mod.ensureTabName();
                    sendResponse({ ok: true, tabName, url: location.href });
                    return;
                }
                if (message.type === MSG.SET_TOKEN) {
                    const tabName = typeof message.tabName === 'string' ? message.tabName : '';
                    const workspaceName = typeof message.workspaceName === 'string'
                        ? message.workspaceName
                        : currentBinding?.workspaceName ?? '';
                    if (!tabName) {
                        sendResponse({ ok: false, error: 'missing tabName' });
                        return;
                    }
                    sessionStorage.setItem('__rpa_tab_name', tabName);
                    sessionStorage.setItem('__rpa_tab_name_confirmed', '1');
                    window.name = `__RPA_TAB_NAME__:${tabName}`;
                    window.__rpa_tab_name = tabName;
                    const changed = currentBinding?.tabName !== tabName
                        || currentBinding.workspaceName !== workspaceName;
                    currentBinding = {tabName, workspaceName};
                    tokenReady = Promise.resolve(currentBinding);
                    uiHandle?.setPageWorkspace(workspaceName);
                    if (changed) {onPageContextChanged();}
                    sendResponse({ ok: true, tabName, workspaceName, url: location.href });
                }
            })().catch((error: unknown) => {
                sendResponse({ ok: false, error: String(error) });
            });
            return true;
        },
    );

    // hello 由 token_bridge 负责
    const PING_INTERVAL_MS = 15000;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    const sendPing = async () => {
        const { tabName, workspaceName } = await ensureToken();
        const { send } = await loadSend();
        await send.action({
            v: 1,
            id: UUIDorUnsafe(),
            type: 'tab.ping',
            workspaceName,
            payload: {
                tabName,
                source: 'extension.content',
                url: location.href,
                title: document.title,
                at: Date.now(),
            },
        });
    };
    const startHeartbeat = () => {
        if (pingTimer) {return;}
        void sendPing();
        pingTimer = setInterval(() => {
            void sendPing();
        }, PING_INTERVAL_MS);
    };

    // UI 注入（浮层模块）
    let uiHandle: {
        scheduleRefresh: () => void;
        onPageChanged: () => void;
        setPageWorkspace: (workspaceName: string) => void;
        setAnnotatorDebugState: (detail: string) => void;
    } | null = null;
    let consumeActionEvent: ((action: ActionShape) => void) | null = null;
    let annotatorHandle: AnnotatorHandle | null = null;
    void (async () => {
        const { mountFloatingUI } = await loadFloatingUI();
        const { MSG } = await loadProtocol();
        const { tabName, workspaceName } = await ensureToken();
        bindReportOnUrlChange();
        void sendReportIfUrlChanged(workspaceName, true);
        startHeartbeat();
        const dispatchAnnotator = async (type: string, payload?: Record<string, unknown>): Promise<unknown> => {
            const { send } = await loadSend();
            const binding = await ensureToken();
            const request: ActionShape = {
                v: 1,
                id: UUIDorUnsafe(),
                type,
                workspaceName: binding.workspaceName,
                payload: payload ?? {},
            };
            consumeActionEvent?.(request);
            const reply = await send.action(request) as ActionShape;
            consumeActionEvent?.(reply);
            return reply;
        };
        const setAnnotatorLauncherVisible = (visible: boolean): void => {
            const panel = document.getElementById('rpa-floating-panel');
            if (!panel) {return;}
            panel.style.display = '';
            const launchers = panel.shadowRoot?.querySelectorAll('.rules-launch, .checkpoint-launch');
            launchers?.forEach((launcher) => {
                if (launcher instanceof HTMLElement) {launcher.hidden = !visible;}
            });
        };

        let annotatorSessions: AnnotatorSessionController | null = null;

        const ensureAnnotatorHandle = async (): Promise<AnnotatorHandle | null> => {
            if (annotatorHandle) {return annotatorHandle;}
            try {
                const {startAnnotator} = await loadAnnotator();
                annotatorHandle = startAnnotator(
                    {
                        onExit: () => {
                            annotatorSessions?.close('editor');
                        },
                        onUndo: () => undefined,
                        onRedo: () => undefined,
                        onCheck: () => undefined,
                        onSave: () => undefined,
                        dispatch: (type, payload) => dispatchAnnotator(type, payload),
                        onDebugState: (detail) => uiHandle?.setAnnotatorDebugState(detail),
                    },
                    document,
                );
                return annotatorHandle;
            } catch (error) {
                console.error('[rpa] annotator mount failed:', error);
                return null;
            }
        };
        const {createAnnotatorSessionController} = await loadAnnotatorSessionController();
        const annotatorSessionController = createAnnotatorSessionController({
            ensureHandle: ensureAnnotatorHandle,
            open: async (payload) => await dispatchAnnotator(
                'entity_rules.annotator.open',
                payload,
            ) as ActionShape,
            pageUrl: () => location.href,
            onEditorActiveChange: (active) => {
                setAnnotatorLauncherVisible(!active);
            },
            onError: (owner, error) => {
                console.error(`[rpa] annotator session failed (${owner}):`, error);
            },
        });
        annotatorSessions = annotatorSessionController;

        uiHandle = mountFloatingUI({
            tabName,
            workspaceName,
            onAction: async (type, payload, scope) => {
                const { send } = await loadSend();
                const typedScope = (scope ?? {}) as ActionScopeInput;
                const normalizedPayload =
                    type === 'record.event'
                        ? {
                              ...(payload ?? {}),
                              __clientContext: {
                                  url: location.href,
                                  title: document.title,
                                  ts: Date.now(),
                              },
                          }
                        : (payload ?? {});
                const action = {
                    v: 1 as const,
                    id: UUIDorUnsafe(),
                    type,
                    workspaceName: typedScope.workspaceName,
                    payload: normalizedPayload,
                };
                return await send.action(action);
            },
            onEvent: (handler) => {
                consumeActionEvent = handler;
            },
            onEnterAnnotation: (profileName) => {
                void annotatorSessionController.openEditor(profileName);
            },
            onEntityRulePreview: async (selection) => {
                return await annotatorSessionController.previewRule(selection);
            },
            onCheckpointEntityRulePreview: async (selection) => {
                return await annotatorSessionController.previewCheckpoint(selection);
            },
        });
        onPageContextChanged = () => {
            annotatorSessionController.close();
            uiHandle?.onPageChanged();
        };
        chrome.runtime.onMessage.addListener((message: unknown) => {
            if (!isRecord(message) || message.type !== MSG.ACTION_EVENT || !('action' in message)) {return;}
            consumeActionEvent?.(message.action as ActionShape);
        });
    })();

    // 刷新消息：从 SW 触发 UI 刷新
    chrome.runtime.onMessage.addListener((message: unknown) => {
        void (async () => {
            const { MSG } = await loadProtocol();
            if (!isRecord(message) || message.type !== MSG.REFRESH) {return;}
            uiHandle?.scheduleRefresh();
        })();
    });
})();
