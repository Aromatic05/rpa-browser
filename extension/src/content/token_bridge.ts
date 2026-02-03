/**
 * token_bridge：tabToken 管理 + hello 绑定。
 *
 * 设计说明：
 * - tabToken 保存在 sessionStorage，并同步挂到 window 便于调试。
 * - hello 在导航变更时发送，确保 SW 侧及时更新映射。
 */

import { send } from '../shared/send.js';

const TAB_TOKEN_KEY = '__rpa_tab_token';

export const ensureTabToken = () => {
    let tabToken = sessionStorage.getItem(TAB_TOKEN_KEY);
    if (!tabToken) {
        tabToken = crypto.randomUUID();
        sessionStorage.setItem(TAB_TOKEN_KEY, tabToken);
    }
    (window as any).__TAB_TOKEN__ = tabToken;
    return tabToken;
};

export const bindHello = (tabToken: string) => {
    const sendHello = () => {
        void send.hello({ tabToken, url: location.href });
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
