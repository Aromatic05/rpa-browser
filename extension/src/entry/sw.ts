/**
 * Service Worker 入口：只负责注册监听与依赖装配。
 *
 * 约束：
 * - 不写业务逻辑，业务下沉到 background/*。
 */

import { createLogger } from '../shared/logger.js';
import { createWsClient } from '../background/ws_client.js';
import { createCmdRouter } from '../background/cmd_router.js';

const log = createLogger('sw');

const wsClient = createWsClient({
    onEvent: (payload) => router.handleEvent(payload),
    logger: log,
});

const router = createCmdRouter({
    wsClient,
    onRefresh: () => {
        chrome.runtime.sendMessage({ type: 'RPA_REFRESH' });
        chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
            const active = tabs[0];
            if (!active?.id) return;
            chrome.tabs.sendMessage(active.id, { type: 'RPA_REFRESH' }, () => {
                if (chrome.runtime.lastError) {
                    // ignore if tab has no content script
                }
            });
        });
    },
    onEvent: (payload) => router.handleEvent(payload),
    logger: log,
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    router.handleMessage(message as any, sender, sendResponse),
);

chrome.tabs.onActivated.addListener((info) => router.onActivated(info));
chrome.tabs.onRemoved.addListener((tabId) => router.onRemoved(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => router.onUpdated(tabId, changeInfo));

chrome.runtime.onStartup?.addListener(() => router.onStartup());
chrome.runtime.onInstalled?.addListener(() => router.onInstalled());
