/**
 * Content script 入口：注入悬浮 UI + tabName，并与 SW 通信。
 *
 * 注意：
 * - 内容脚本是“非 module”脚本，禁止静态 import。
 * - 需要延迟加载录制模块（动态 import）以避免报错。
 * - 运行在页面上下文，不能直接访问 tabs API。
 * - 仅处理 UI 与消息，不做持久化。
 */

interface Window {
    __rpaTokenInjected?: boolean;
    __rpaInitialNavigateSent?: boolean;
}

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

type FloatingUIExports = {
    mountFloatingUI: (opts: {
        tabName: string;
        workspaceName: string;
        onAction: (type: string, payload?: unknown, scope?: Record<string, unknown>) => Promise<unknown>;
        onEvent?: (handler: (action: ActionShape) => void) => void;
    }) => { scheduleRefresh: () => void };
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
const UUIDorUnsafe = (): string => {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
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

(() => {
    // 幂等保护：避免重复注入 UI 与监听器
    if (window.top !== window) {return;}
    if (window.__rpaTokenInjected) {return;}
    window.__rpaTokenInjected = true;

    // tabName + hello 绑定（异步初始化，所有使用点需 await）
    let tokenReady: Promise<{ tabName: string; workspaceName: string }> | null = null;
    const sendReport = async (tabName?: string, workspaceName?: string) => {
        const resolved = tabName ? { tabName, workspaceName: workspaceName ?? '' } : await ensureToken();
        const { send } = await loadSend();
        await send.action({
            v: 1,
            id: UUIDorUnsafe(),
            type: 'tab.report',
            payload: {
                tabName: resolved.tabName,
                source: 'extension.content',
                url: location.href,
                title: document.title,
                at: Date.now(),
            },
        });
    };
    const ensureToken = () => {
        tokenReady ??= (async () => {
                const mod = await loadTokenBridge();
                const result = await mod.ensureTabNameAsync();
                mod.bindHello(result.tabName, () => {
                    void sendReport(result.tabName, result.workspaceName);
                    void sendInitialNavigateEvent(result.tabName, result.workspaceName);
                });
                return result;
            })();
        return tokenReady!;
    };

    const sendInitialNavigateEvent = async (tabName?: string, workspaceName?: string) => {
        if (window.__rpaInitialNavigateSent) {return;}
        if (!isOrdinaryPageUrl(location.href)) {return;}
        const resolved = tabName ? { tabName, workspaceName: workspaceName ?? '' } : await ensureToken();
        const { send } = await loadSend();
        const reply = await send.action({
            v: 1,
            id: UUIDorUnsafe(),
            type: 'record.event',
            workspaceName: resolved.workspaceName,
            payload: {
                tabName: resolved.tabName,
                ts: Date.now(),
                type: 'navigate',
                url: location.href,
                source: 'direct',
            },
        });
        if (!String((reply as { type?: unknown })?.type || '').endsWith('.failed')) {
            window.__rpaInitialNavigateSent = true;
        }
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
                    if (!tabName) {
                        sendResponse({ ok: false, error: 'missing tabName' });
                        return;
                    }
                    sessionStorage.setItem('__rpa_tab_name', tabName);
                    window.name = `__RPA_TAB_NAME__:${tabName}`;
                    (window as any).__rpa_tab_name = tabName;
                    sendResponse({ ok: true, tabName, url: location.href });
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
    let uiHandle: { scheduleRefresh: () => void } | null = null;
    let consumeActionEvent: ((action: ActionShape) => void) | null = null;
    void (async () => {
        const { mountFloatingUI } = await loadFloatingUI();
        const { MSG } = await loadProtocol();
        const { tabName, workspaceName } = await ensureToken();
        void sendReport(tabName);
        void sendInitialNavigateEvent(tabName, workspaceName);
        startHeartbeat();
        uiHandle = mountFloatingUI({
            tabName,
            workspaceName,
            onAction: async (type, payload, scope) => {
                const { send } = await loadSend();
                const typedScope = (scope ?? {}) as ActionScopeInput;
                const hasExplicitScope = Boolean(typedScope.workspaceName ?? typedScope.tabName);
                const scopedTabName = typedScope.tabName ?? tabName;
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
                if (!hasExplicitScope && action.payload && typeof action.payload === 'object') {
                    (action.payload as Record<string, unknown>).tabName = scopedTabName;
                }
                return await send.action(action);
            },
            onEvent: (handler) => {
                consumeActionEvent = handler;
            },
        });
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
