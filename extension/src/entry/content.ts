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

    // tabToken：页面级缓存
    const TAB_TOKEN_KEY = '__rpa_tab_token';
    let tabToken = sessionStorage.getItem(TAB_TOKEN_KEY);
    if (!tabToken) {
        tabToken = crypto.randomUUID();
        sessionStorage.setItem(TAB_TOKEN_KEY, tabToken);
    }
    (window as any).__TAB_TOKEN__ = tabToken;

    // hello：用于 SW 侧建立 tabToken/workspace 绑定
    const sendHello = () => {
        void (async () => {
            const { send } = await loadSend();
            await send.hello({ tabToken, url: location.href });
        })();
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
                    sendResponse({ ok: true, tabToken, url: location.href });
                    return;
                }
                if (message?.type === MSG.RECORD_START || message?.type === MSG.RECORD_STOP) {
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

    // 页面导航监听：pushState/replaceState + popstate/hashchange
    const patchHistory = () => {
        const wrap = (method: typeof history.pushState) =>
            function (...args: Parameters<typeof history.pushState>) {
                const result = method.apply(history, args as unknown as [any, any, any]);
                sendHello();
                return result;
            };
        history.pushState = wrap(history.pushState);
        history.replaceState = wrap(history.replaceState);
    };

    patchHistory();
    window.addEventListener('popstate', sendHello);
    window.addEventListener('hashchange', sendHello);
    sendHello();

    // UI 注入（浮层模块）
    let uiHandle: { scheduleRefresh: () => void } | null = null;
    void (async () => {
        const { mountFloatingUI } = await loadFloatingUI();
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
