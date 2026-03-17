/**
 * Service Worker 入口：只负责注册监听与依赖装配。
 *
 * 约束：
 * - 不写业务逻辑，业务下沉到 background/*。
 */

import { createLogger } from '../shared/logger.js';
import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';
import { createWsClient } from '../background/ws_client.js';
import { createCmdRouter } from '../background/cmd_router.js';

const log = createLogger('sw');

const wsClient = createWsClient({
    onAction: (action) => router.handleInboundAction(action),
    logger: log,
});

const router = createCmdRouter({
    wsClient,
    onRefresh: () => {
        chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
            const active = tabs[0];
            if (!active?.id) return;
            void send.toTab(active.id, MSG.REFRESH);
        });
    },
    logger: log,
});

void router.bootstrapState();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    router.handleMessage(message as any, sender, sendResponse),
);

chrome.tabs.onActivated.addListener((info) => router.onActivated(info));
chrome.tabs.onRemoved.addListener((tabId) => router.onRemoved(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => router.onUpdated(tabId, changeInfo, tab));
chrome.tabs.onAttached.addListener((tabId, info) => router.onAttached(tabId, info));
chrome.windows.onFocusChanged.addListener((windowId) => router.onFocusChanged(windowId));
chrome.windows.onRemoved.addListener((windowId) => router.onWindowRemoved(windowId));

chrome.runtime.onStartup?.addListener(() => router.onStartup());
chrome.runtime.onInstalled?.addListener(() => router.onInstalled());
