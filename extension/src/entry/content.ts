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

// 录制桥接（动态 import）
const loadRecorderBridge = (() => {
    let cached: Promise<typeof import('../content/recorder_bridge.js')> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('content/recorder_bridge.js');
            cached = import(url) as Promise<typeof import('../content/recorder_bridge.js')>;
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
    const ensureToken = () => {
        if (!tokenReady) {
            tokenReady = (async () => {
                const mod = await loadTokenBridge();
                const token = mod.ensureTabToken();
                mod.bindHello(token);
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
                if (message?.type === MSG.RECORD_START || message?.type === MSG.RECORD_STOP) {
                    const tabToken = await ensureToken();
                    const { createRecorderBridge } = await loadRecorderBridge();
                    const bridge = createRecorderBridge(tabToken);
                    const handled = await bridge.handle(message, sendResponse);
                    if (handled) return;
                }
            })().catch((error) => {
                sendResponse({ ok: false, error: String(error) });
            });
            return true;
        },
    );

    // hello 由 token_bridge 负责

    // UI 注入（浮层模块）
    let uiHandle: { scheduleRefresh: () => void } | null = null;
    void (async () => {
        const { mountFloatingUI } = await loadFloatingUI();
        const tabToken = await ensureToken();
        uiHandle = mountFloatingUI({
            tabToken,
            onAction: async (type, payload, scope) => {
                const { send } = await loadSend();
                const action = {
                    v: 1,
                    id: crypto.randomUUID(),
                    type,
                    tabToken,
                    scope: { ...(scope || {}), tabToken },
                    payload: payload || {},
                };
                const result = await send.action(action);
                return result.ok ? result.data : result;
            },
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
