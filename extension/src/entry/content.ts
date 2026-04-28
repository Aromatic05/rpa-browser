/**
 * Content script 入口：注入悬浮 UI + tabToken，并与 SW 通信。
 *
 * 注意：
 * - 内容脚本是“非 module”脚本，禁止静态 import。
 * - 需要延迟加载录制模块（动态 import）以避免报错。
 * - 运行在页面上下文，不能直接访问 tabs API。
 * - 仅处理 UI 与消息，不做持久化。
 */

interface Window {
    __rpaTokenInjected?: boolean;
}

type ActionScopeInput = {
    workspaceId?: string;
    tabId?: string;
    tabToken?: string;
};

type ActionShape = {
    v: 1;
    id: string;
    type: string;
    tabToken?: string;
    scope?: Record<string, unknown>;
    payload?: unknown;
};

type FloatingUIExports = {
    mountFloatingUI: (opts: {
        tabToken: string;
        onAction: (type: string, payload?: unknown, scope?: Record<string, unknown>) => Promise<unknown>;
        onEvent?: (handler: (action: ActionShape) => void) => void;
    }) => { scheduleRefresh: () => void };
};

type TokenBridgeExports = {
    ensureTabToken: () => string;
    ensureTabTokenAsync: () => Promise<string>;
    bindHello: (tabToken: string, onHello?: () => void) => () => void;
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

    // tabToken + hello 绑定（异步初始化，所有使用点需 await）
    let tokenReady: Promise<string> | null = null;
    const sendReport = async (tabToken?: string) => {
        const token = tabToken ?? (await ensureToken());
        const { send } = await loadSend();
        await send.action({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.report',
            tabToken: token,
            scope: { tabToken: token },
            payload: {
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
                const token = await mod.ensureTabTokenAsync();
                mod.bindHello(token, () => {
                    void sendReport(token);
                });
                return token;
            })();
        return tokenReady;
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
                    const tabToken = mod.ensureTabToken();
                    sendResponse({ ok: true, tabToken, url: location.href });
                    return;
                }
                if (message.type === MSG.SET_TOKEN) {
                    const token = typeof message.tabToken === 'string' ? message.tabToken : '';
                    if (!token) {
                        sendResponse({ ok: false, error: 'missing tabToken' });
                        return;
                    }
                    sessionStorage.setItem('__rpa_tab_token', token);
                    window.name = `__RPA_TAB_TOKEN__:${token}`;
                    (window as any).__TAB_TOKEN__ = token;
                    sendResponse({ ok: true, tabToken: token, url: location.href });
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
        const tabToken = await ensureToken();
        const { send } = await loadSend();
        await send.action({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.ping',
            tabToken,
            scope: { tabToken },
            payload: {
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
        const tabToken = await ensureToken();
        void sendReport(tabToken);
        startHeartbeat();
        uiHandle = mountFloatingUI({
            tabToken,
            onAction: async (type, payload, scope) => {
                const { send } = await loadSend();
                const typedScope = (scope ?? {}) as ActionScopeInput;
                const hasExplicitScope = Boolean(typedScope.workspaceId ?? typedScope.tabId);
                const scopedTabToken = typedScope.tabToken ?? tabToken;
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
                const normalizedScope = hasExplicitScope
                    ? {
                          ...(typedScope.workspaceId ? { workspaceId: typedScope.workspaceId } : {}),
                          ...(typedScope.tabId ? { tabId: typedScope.tabId } : {}),
                      }
                    : { ...typedScope, tabToken: scopedTabToken };
                const action = {
                    v: 1 as const,
                    id: crypto.randomUUID(),
                    type,
                    tabToken: hasExplicitScope ? undefined : scopedTabToken,
                    scope: normalizedScope,
                    payload: normalizedPayload,
                };
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
