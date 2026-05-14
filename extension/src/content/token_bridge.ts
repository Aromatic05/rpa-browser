/**
 * token_bridge：tabName 管理 + hello 绑定。
 *
 * 设计说明：
 * - tabName 保存在 sessionStorage，并同步挂到 window 便于调试。
 * - hello 在导航变更时发送，确保 SW 侧及时更新映射。
 */

import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';

declare global {
    interface Window {
        __rpa_tab_name?: string;
    }
}

const TAB_NAME_KEY = '__rpa_tab_name';
const TAB_NAME_CONFIRMED_KEY = '__rpa_tab_name_confirmed';
const TAB_NAME_WIN_NAME_PREFIX = '__RPA_TAB_NAME__:';

const readTokenFromWindowName = (): string | null => {
    try {
        // Popup/new-tab created via window.open can inherit opener's window.name.
        // Treat such inherited value as untrusted to avoid cross-tab token bleed.
        if (window.opener && !window.opener.closed) {return null;}
        const raw = window.name;
        if (!raw.startsWith(TAB_NAME_WIN_NAME_PREFIX)) {return null;}
        const token = raw.slice(TAB_NAME_WIN_NAME_PREFIX.length).trim();
        return token || null;
    } catch {
        return null;
    }
};

const writeTokenToWindowName = (tabName: string) => {
    try {
        window.name = `${TAB_NAME_WIN_NAME_PREFIX}${tabName}`;
    } catch {
        // ignore window.name write failures
    }
};

export const ensureTabName = (): string => {
    const fromWindow = readTokenFromWindowName();
    if (fromWindow) {
        sessionStorage.setItem(TAB_NAME_KEY, fromWindow);
        window.__rpa_tab_name = fromWindow;
        return fromWindow;
    }
    const fromSession = sessionStorage.getItem(TAB_NAME_KEY);
    if (fromSession) {
        window.__rpa_tab_name = fromSession;
        return fromSession;
    }
    return '';
};

export const ensureTabNameAsync = async (): Promise<{ tabName: string; workspaceName: string }> => {
    let tabName = ensureTabName();
    const preferredTabName = readTokenFromWindowName() || '';
    const runtimeReply = await new Promise<{ ok: boolean; tabName?: string; workspaceName?: string }>((resolve) => {
        chrome.runtime.sendMessage(
            {
                type: MSG.ENSURE_BOUND_TOKEN,
                source: 'extension.content',
                // Only trust agent-injected window.name; opener/sessionStorage can leak across window.open.
                tabName: preferredTabName,
                url: location.href,
                title: document.title,
                at: Date.now(),
            },
            (response: unknown) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false });
                    return;
                }
                resolve((response ?? { ok: false }) as { ok: boolean; tabName?: string; workspaceName?: string });
            },
        );
    });
    if (!runtimeReply.ok || !runtimeReply.tabName) {
        throw new Error('bound tab token unavailable');
    }
    tabName = runtimeReply.tabName;
    const workspaceName = runtimeReply.workspaceName ?? '';
    sessionStorage.setItem(TAB_NAME_KEY, tabName);
    sessionStorage.setItem(TAB_NAME_CONFIRMED_KEY, '1');
    writeTokenToWindowName(tabName);
    window.__rpa_tab_name = tabName;
    return { tabName, workspaceName };
};

export const bindHello = (_tabName: string, onHello?: () => void): () => void => {
    const sendHello = () => {
        void send.hello({ url: location.href, tabName: readTokenFromWindowName() || '' });
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
