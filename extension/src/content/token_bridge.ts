/**
 * token_bridge：tabToken 管理 + hello 绑定。
 *
 * 设计说明：
 * - tabToken 保存在 sessionStorage，并同步挂到 window 便于调试。
 * - hello 在导航变更时发送，确保 SW 侧及时更新映射。
 */

import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';

declare global {
    interface Window {
        __TAB_TOKEN__?: string;
    }
}

const TAB_TOKEN_KEY = '__rpa_tab_token';
const TAB_TOKEN_WIN_NAME_PREFIX = '__RPA_TAB_TOKEN__:';

const readTokenFromWindowName = (): string | null => {
    try {
        const raw = window.name;
        if (!raw.startsWith(TAB_TOKEN_WIN_NAME_PREFIX)) {return null;}
        const token = raw.slice(TAB_TOKEN_WIN_NAME_PREFIX.length).trim();
        return token || null;
    } catch {
        return null;
    }
};

const writeTokenToWindowName = (tabToken: string) => {
    try {
        window.name = `${TAB_TOKEN_WIN_NAME_PREFIX}${tabToken}`;
    } catch {
        // ignore window.name write failures
    }
};

export const ensureTabToken = (): string => {
    const tabToken = sessionStorage.getItem(TAB_TOKEN_KEY) ?? readTokenFromWindowName() ?? '';
    if (!tabToken) {return '';}
    sessionStorage.setItem(TAB_TOKEN_KEY, tabToken);
    writeTokenToWindowName(tabToken);
    window.__TAB_TOKEN__ = tabToken;
    return tabToken;
};

export const ensureTabTokenAsync = async (): Promise<string> => {
    let tabToken = ensureTabToken();
    let bound = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const runtimeReply = await new Promise<{ ok: boolean; tabToken?: string; pending?: boolean }>((resolve) => {
            chrome.runtime.sendMessage(
                {
                    type: MSG.ENSURE_BOUND_TOKEN,
                    source: 'extension.content',
                    tabToken,
                    url: location.href,
                    title: document.title,
                    at: Date.now(),
                },
                (response: unknown) => {
                    if (chrome.runtime.lastError) {
                        resolve({ ok: false });
                        return;
                    }
                    resolve((response ?? { ok: false }) as { ok: boolean; tabToken?: string });
                },
            );
        });
        if (!runtimeReply.ok || !runtimeReply.tabToken) {break;}
        tabToken = runtimeReply.tabToken;
        sessionStorage.setItem(TAB_TOKEN_KEY, tabToken);
        writeTokenToWindowName(tabToken);
        window.__TAB_TOKEN__ = tabToken;
        if (!runtimeReply.pending) {
            bound = true;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
    }
    if (!tabToken || !bound) {
        throw new Error('bound tab token unavailable');
    }
    return tabToken;
};

export const bindHello = (tabToken: string, onHello?: () => void): () => void => {
    const sendHello = () => {
        void send.hello({ tabToken, url: location.href });
        onHello?.();
    };

    // 监听历史与哈希变化，保证页面切换后也能通知 SW
    const originalPush = history.pushState.bind(history);
    const originalReplace = history.replaceState.bind(history);
    const wrap = (method: typeof originalPush) =>
        (...args: Parameters<typeof history.pushState>) => {
            method(...args);
            sendHello();
            return undefined;
        };
    history.pushState = wrap(originalPush) as History['pushState'];
    history.replaceState = wrap(originalReplace) as History['replaceState'];

    window.addEventListener('popstate', sendHello);
    window.addEventListener('hashchange', sendHello);
    sendHello();

    return () => {
        history.pushState = originalPush;
        history.replaceState = originalReplace;
        window.removeEventListener('popstate', sendHello);
        window.removeEventListener('hashchange', sendHello);
    };
};
