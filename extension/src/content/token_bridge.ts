/**
 * token_bridge：tabToken 管理 + hello 绑定。
 *
 * 设计说明：
 * - tabToken 保存在 sessionStorage，并同步挂到 window 便于调试。
 * - hello 在导航变更时发送，确保 SW 侧及时更新映射。
 */

import { send } from '../shared/send.js';

const TAB_TOKEN_KEY = '__rpa_tab_token';
const TAB_TOKEN_WIN_NAME_PREFIX = '__RPA_TAB_TOKEN__:';

const readTokenFromWindowName = () => {
    try {
        const raw = window.name || '';
        if (!raw.startsWith(TAB_TOKEN_WIN_NAME_PREFIX)) return null;
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

export const ensureTabToken = () => {
    const tabToken = sessionStorage.getItem(TAB_TOKEN_KEY) || readTokenFromWindowName() || '';
    if (!tabToken) return '';
    sessionStorage.setItem(TAB_TOKEN_KEY, tabToken);
    writeTokenToWindowName(tabToken);
    (window as any).__TAB_TOKEN__ = tabToken;
    return tabToken;
};

export const ensureTabTokenAsync = async () => {
    let tabToken = ensureTabToken();
    if (!tabToken) {
        const response = await send.action<{
            ok: boolean;
            data?: { tabToken?: string };
            error?: { message?: string };
        }>({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.token.init',
            payload: {
                source: 'extension.content',
                url: location.href,
                at: Date.now(),
            },
            scope: {},
        });
        if (response.ok && response.data?.ok && response.data?.data?.tabToken) {
            tabToken = String(response.data.data.tabToken);
        }
        if (!tabToken) {
            throw new Error('tab token init failed');
        }
    }
    sessionStorage.setItem(TAB_TOKEN_KEY, tabToken);
    writeTokenToWindowName(tabToken);
    (window as any).__TAB_TOKEN__ = tabToken;
    return tabToken;
};

export const bindHello = (tabToken: string, onHello?: () => void) => {
    const sendHello = () => {
        void send.hello({ tabToken, url: location.href });
        onHello?.();
    };

    // 监听历史与哈希变化，保证页面切换后也能通知 SW
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const wrap = (method: typeof history.pushState) =>
        function (...args: Parameters<typeof history.pushState>) {
            const result = method.apply(history, args as unknown as [any, any, any]);
            sendHello();
            return result;
        };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);

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
