/**
 * token_bridge：tabToken 管理 + hello 绑定。
 *
 * 设计说明：
 * - tabToken 保存在 sessionStorage，并同步挂到 window 便于调试。
 * - hello 在导航变更时发送，确保 SW 侧及时更新映射。
 */

import { send } from '../shared/send.js';
import type { Action } from '../shared/types.js';

const TAB_TOKEN_KEY = '__rpa_tab_token';
const TAB_TOKEN_WIN_NAME_PREFIX = '__RPA_TAB_TOKEN__:';

const readTokenFromWindowName = () => {
    try {
        const raw = window.name || '';
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

export const ensureTabToken = () => {
    const tabToken = sessionStorage.getItem(TAB_TOKEN_KEY) || readTokenFromWindowName() || '';
    if (!tabToken) {return '';}
    sessionStorage.setItem(TAB_TOKEN_KEY, tabToken);
    writeTokenToWindowName(tabToken);
    (window as any).__TAB_TOKEN__ = tabToken;
    return tabToken;
};

export const ensureTabTokenAsync = async () => {
    let tabToken = ensureTabToken();
    if (!tabToken) {
        const response = await send.action({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.init',
            payload: {
                source: 'extension.content',
                url: location.href,
                at: Date.now(),
            },
            scope: {},
        } satisfies Action);
        const payload = (response.payload || {}) as { tabToken?: string };
        if (response.type === 'tab.init.result' && payload.tabToken) {
            tabToken = payload.tabToken;
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
