/**
 * Content script 入口：注入悬浮 UI + tabToken，并与 SW 通信。
 *
 * 注意：
 * - 内容脚本是“非 module”脚本，禁止静态 import。
 * - 需要延迟加载录制模块（动态 import）以避免报错。
 * - 运行在页面上下文，不能直接访问 tabs API。
 * - 仅处理 UI 与消息，不做持久化。
 */

// 协议与发送模块（动态 import，避免内容脚本模块化限制）
const loadProtocol = (() => {
    let cached: Promise<typeof import('../shared/protocol.js')> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('shared/protocol.js');
            cached = import(url) as Promise<typeof import('../shared/protocol.js')>;
        }
        return cached;
    };
})();

const loadSend = (() => {
    let cached: Promise<typeof import('../shared/send.js')> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('shared/send.js');
            cached = import(url) as Promise<typeof import('../shared/send.js')>;
        }
        return cached;
    };
})();

const loadTokenBridge = (() => {
    let cached: Promise<typeof import('../content/token_bridge.js')> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('content/token_bridge.js');
            cached = import(url) as Promise<typeof import('../content/token_bridge.js')>;
        }
        return cached;
    };
})();


const loadFloatingUI = (() => {
    let cached: Promise<typeof import('../content/floating_ui.js')> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('content/floating_ui.js');
            cached = import(url) as Promise<typeof import('../content/floating_ui.js')>;
        }
        return cached;
    };
})();

(() => {
    // 幂等保护：避免重复注入 UI 与监听器
    if (window.top !== window) return;
    if ((window as any).__rpaTokenInjected) return;
    (window as any).__rpaTokenInjected = true;

    // tabToken + hello 绑定（异步初始化，所有使用点需 await）
    let tokenReady: Promise<string> | null = null;
    const sendReport = async (tabToken?: string) => {
        const token = tabToken || (await ensureToken());
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
        if (!tokenReady) {
            tokenReady = (async () => {
                const mod = await loadTokenBridge();
                const token = await mod.ensureTabTokenAsync();
                mod.bindHello(token, () => {
                    void sendReport(token);
                });
                return token;
            })();
        }
        return tokenReady;
    };

    chrome.runtime.onMessage.addListener(
        (
            message: any,
            _sender: chrome.runtime.MessageSender,
            sendResponse: (response?: any) => void,
        ) => {
            // 消息接收入口：token 查询 + 录制 start/stop
            void (async () => {
                const { MSG } = await loadProtocol();
                if (message?.type === MSG.GET_TOKEN) {
                    const tabToken = await ensureToken();
                    sendResponse({ ok: true, tabToken, url: location.href });
                    return;
                }
            })().catch((error) => {
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
        if (pingTimer) return;
        void sendPing();
        pingTimer = setInterval(() => {
            void sendPing();
        }, PING_INTERVAL_MS);
    };

    // UI 注入（浮层模块）
    let uiHandle: { scheduleRefresh: () => void } | null = null;
    let consumeActionEvent: ((action: any) => void) | null = null;
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
                const hasExplicitScope = !!((scope as any)?.workspaceId || (scope as any)?.tabId);
                const scopedTabToken = (scope as any)?.tabToken || tabToken;
                const normalizedPayload =
                    type === 'record.event'
                        ? {
                              ...(payload || {}),
                              __clientContext: {
                                  url: location.href,
                                  title: document.title,
                                  ts: Date.now(),
                              },
                          }
                        : payload || {};
                const normalizedScope = hasExplicitScope
                    ? {
                          ...((scope as any)?.workspaceId ? { workspaceId: (scope as any).workspaceId } : {}),
                          ...((scope as any)?.tabId ? { tabId: (scope as any).tabId } : {}),
                      }
                    : { ...(scope || {}), tabToken: scopedTabToken };
                const action = {
                    v: 1,
                    id: crypto.randomUUID(),
                    type,
                    tabToken: hasExplicitScope ? undefined : scopedTabToken,
                    scope: normalizedScope,
                    payload: normalizedPayload,
                };
                return send.action(action);
            },
            onEvent: (handler) => {
                consumeActionEvent = handler;
            },
        });
        chrome.runtime.onMessage.addListener((message: any) => {
            if (message?.type !== MSG.ACTION_EVENT) return;
            if (!message?.action) return;
            consumeActionEvent?.(message.action);
        });
    })();

    // 刷新消息：从 SW 触发 UI 刷新
    chrome.runtime.onMessage.addListener((message: any) => {
        void (async () => {
            const { MSG } = await loadProtocol();
            if (message?.type !== MSG.REFRESH) return;
            uiHandle?.scheduleRefresh();
        })();
    });
})();
