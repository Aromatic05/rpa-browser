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
const TAB_NAME_WIN_NAME_PREFIX = '__RPA_TAB_NAME__:';

const readTokenFromWindowName = (): string | null => {
    try {
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
    const tabName = sessionStorage.getItem(TAB_NAME_KEY) ?? readTokenFromWindowName() ?? '';
    if (!tabName) {return '';}
    sessionStorage.setItem(TAB_NAME_KEY, tabName);
    writeTokenToWindowName(tabName);
    window.__rpa_tab_name = tabName;
    return tabName;
};

export const ensureTabNameAsync = async (): Promise<string> => {
    let tabName = ensureTabName();
    for (let i = 0; i < 3; i += 1) {
        const runtimeReply = await new Promise<{ ok: boolean; tabName?: string }>((resolve) => {
            chrome.runtime.sendMessage(
                {
                    type: MSG.ENSURE_BOUND_TOKEN,
                    source: 'extension.content',
                    tabName,
                    url: location.href,
                    title: document.title,
                    at: Date.now(),
                },
                (response: unknown) => {
                    if (chrome.runtime.lastError) {
                        resolve({ ok: false });
                        return;
                    }
                    resolve((response ?? { ok: false }) as { ok: boolean; tabName?: string });
                },
            );
        });
        if (runtimeReply.ok && runtimeReply.tabName) {
            tabName = runtimeReply.tabName;
            sessionStorage.setItem(TAB_NAME_KEY, tabName);
            writeTokenToWindowName(tabName);
            window.__rpa_tab_name = tabName;
            break;
        }
        if (i < 2) {
            await new Promise<void>((resolve) => setTimeout(resolve, 120));
        }
    }
    if (!tabName) {
        throw new Error('bound tab token unavailable');
    }
    return tabName;
};

export const bindHello = (tabName: string, onHello?: () => void): () => void => {
    const sendHello = () => {
        void send.hello({ tabName, url: location.href });
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
