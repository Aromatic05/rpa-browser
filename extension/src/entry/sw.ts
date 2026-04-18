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
import { createActionBus } from '../background/action_bus.js';

const log = createLogger('sw');
const REFRESH_DEBOUNCE_MS = 120;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight = false;
let refreshQueued = false;

const dispatchRefresh = () => {
    if (refreshInFlight) {
        refreshQueued = true;
        return;
    }
    refreshInFlight = true;
    chrome.tabs
        .query({ active: true, currentWindow: true })
        .then((tabs) => {
            const active = tabs[0];
            if (!active?.id) return;
            void send.toTab(active.id, MSG.REFRESH);
        })
        .catch((error) => {
            log.debug('refresh.dispatch.failed', String(error));
        })
        .finally(() => {
            refreshInFlight = false;
            if (!refreshQueued) return;
            refreshQueued = false;
            dispatchRefresh();
        });
};

const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        dispatchRefresh();
    }, REFRESH_DEBOUNCE_MS);
};

const actionBus = createActionBus();

const wsClient = createWsClient({
    onAction: (action) => {
        router.handleInboundAction(action);
        actionBus.publish(action);
    },
    logger: log,
});

const router = createCmdRouter({
    wsClient,
    onRefresh: scheduleRefresh,
    logger: log,
});

actionBus.subscribe(
    [
        'play.*',
        'play.step.*',
        'record.event',
        'workspace.list',
        'workspace.changed',
        'workspace.sync',
        'tab.bound',
    ],
    async (action) => {
        const targetTabId = router.resolveActionTargetTabId(action);
        if (targetTabId == null) return;
        await send.toTab(targetTabId, MSG.ACTION_EVENT, { action }, { timeoutMs: 1500 });
    },
);

void router.bootstrapState();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    router.handleMessage(message as any, sender, sendResponse),
);

chrome.tabs.onActivated.addListener((info) => router.onActivated(info));
chrome.tabs.onRemoved.addListener((tabId) => router.onRemoved(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => router.onUpdated(tabId, changeInfo, tab));
chrome.tabs.onCreated.addListener((tab) => router.onCreated(tab));
chrome.tabs.onAttached.addListener((tabId, info) => router.onAttached(tabId, info));
chrome.windows.onFocusChanged.addListener((windowId) => router.onFocusChanged(windowId));
chrome.windows.onRemoved.addListener((windowId) => router.onWindowRemoved(windowId));

chrome.runtime.onStartup?.addListener(() => router.onStartup());
chrome.runtime.onInstalled?.addListener(() => router.onInstalled());
