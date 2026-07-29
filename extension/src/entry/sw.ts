/**
 * Service Worker 入口：只负责注册监听与依赖装配。
 *
 * 约束：
 * - 不写业务逻辑，业务下沉到 background/*。
 */

import { createLogger, createBufferedLogForwarder, setLogForwarder, type LogEntry } from '../shared/logger.js';
import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';
import { createWsClient, type WsClient } from '../actions/ws_client.js';
import { createCmdRouter } from '../background/cmd_router.js';
import { createActionBus } from '../background/action_bus.js';
import { readSessionConfig, SESSION_CONFIG_KEYS } from '../background/session_config.js';
import {createSessionRuntimeInitializer} from '../background/session_runtime_initializer.js';
import type {RouterStateSnapshot} from '../background/state.js';

const log = createLogger('sw');
const REFRESH_DEBOUNCE_MS = 120;
const DEV_ROUTER_STATE_KEY = 'rpa.dev.router-state';

type DevRuntimeBridge = {
    buildId: string;
    prepareReload: () => Promise<{
        buildId: string;
        tabCount: number;
        snapshot: RouterStateSnapshot;
    }>;
};

type SessionRuntimeBridge = {
    configure: (config: {workspaceName: string; wsPort: number}) => Promise<void>;
};

type DevWorkerGlobal = typeof globalThis & {
    __rpaDevRuntime?: DevRuntimeBridge;
    __rpaSessionRuntime?: SessionRuntimeBridge;
};

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight = false;
let refreshQueued = false;
let activeSessionKey = '';
let activeWorkspaceName = '';
let activeWsClient: WsClient | null = null;

const dispatchRefresh = () => {
    if (refreshInFlight) {
        refreshQueued = true;
        return;
    }
    refreshInFlight = true;
    chrome.tabs
        .query({ active: true, currentWindow: true })
        .then((tabs) => {
            const active = tabs.at(0);
            if (!active || typeof active.id !== 'number') {return;}
            void send.toTabTransport(active.id, MSG.REFRESH);
        })
        .catch((error: unknown) => {
            log.debug('refresh.dispatch.failed', String(error));
        })
        .finally(() => {
            refreshInFlight = false;
            if (!refreshQueued) {return;}
            refreshQueued = false;
            dispatchRefresh();
        });
};

const scheduleRefresh = () => {
    if (refreshTimer) {return;}
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        dispatchRefresh();
    }, REFRESH_DEBOUNCE_MS);
};

const actionBus = createActionBus();
let initialized = false;

const initializeRuntime = async () => {
    const sessionConfig = await readSessionConfig();
    if (!sessionConfig) {
        log.warning('session config missing; websocket connection skipped');
        return;
    }
    const sessionKey = `${sessionConfig.workspaceName}:${String(sessionConfig.wsPort)}`;
    if (initialized) {
        if (activeSessionKey === sessionKey) {return;}
        if (activeWorkspaceName !== sessionConfig.workspaceName || !activeWsClient) {
            log.warning('session workspace changed; reloading extension runtime', {
                previous: activeSessionKey,
                next: sessionKey,
            });
            chrome.runtime.reload();
            return;
        }
        log.warning('session websocket port changed; reconnecting', {
            previous: activeSessionKey,
            next: sessionKey,
        });
        await activeWsClient.reconnect(sessionConfig.wsPort);
        activeSessionKey = sessionKey;
        scheduleRefresh();
        return;
    }

    let router: ReturnType<typeof createCmdRouter> | null = null;
    const wsClient = createWsClient({
        wsPort: sessionConfig.wsPort,
        onAction: (action) => {
            if (!router) {
                log.warning('inbound action received before router initialization', { type: action.type });
                return;
            }
            router.handleInboundAction(action);
            actionBus.publish(action);
        },
        logger: log,
    });

    router = createCmdRouter({
        wsClient,
        sessionWorkspaceName: sessionConfig.workspaceName,
        onRefresh: scheduleRefresh,
        logger: log,
    });

    const storedDevState = await chrome.storage.local.get(DEV_ROUTER_STATE_KEY);
    const routerSnapshot = storedDevState[DEV_ROUTER_STATE_KEY] as RouterStateSnapshot | undefined;
    if (routerSnapshot && Array.isArray(routerSnapshot.tabs) && Array.isArray(routerSnapshot.bindings)) {
        router.restoreState(routerSnapshot);
        await chrome.storage.local.remove(DEV_ROUTER_STATE_KEY);
        log.info('dev.reload.state-restored', {
            tabCount: routerSnapshot.tabs.length,
            bindingCount: routerSnapshot.bindings.length,
        });
    }

    const buildId = chrome.runtime.getManifest().version_name ?? chrome.runtime.getManifest().version;
    (globalThis as DevWorkerGlobal).__rpaDevRuntime = {
        buildId,
        prepareReload: async () => {
            const snapshot = router.snapshotState();
            await chrome.storage.local.set({[DEV_ROUTER_STATE_KEY]: snapshot});
            return {buildId, tabCount: snapshot.tabs.length, snapshot};
        },
    };

    const unsubscribeActionBus = actionBus.subscribe(
        ['**'],
        async (action) => {
            const targetTabName = router.resolveActionTargetTabName(action);
            if (targetTabName === null) {return;}
            await send.toTabTransport(targetTabName, MSG.ACTION_EVENT, { action }, { timeoutMs: 1500 });
        },
    );

    try {
        await wsClient.connect();
    } catch (error) {
        unsubscribeActionBus();
        throw error;
    }

    initialized = true;
    activeSessionKey = sessionKey;
    activeWorkspaceName = sessionConfig.workspaceName;
    activeWsClient = wsClient;

    const logForwarder = createBufferedLogForwarder(
        (entries: LogEntry[]) => {
            wsClient.sendFireAndForget({
                v: 1,
                id: crypto.randomUUID(),
                type: 'log.ext',
                payload: { entries },
                at: Date.now(),
            });
        },
        { maxBatchSize: 24, flushIntervalMs: 2000 },
    );
    setLogForwarder(logForwarder.forwarder);

    void router.bootstrapState();

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
        router.handleMessage(message, sender, sendResponse),
    );

    chrome.tabs.onActivated.addListener((info) => { router.onActivated(info); });
    chrome.tabs.onRemoved.addListener((tabName) => { router.onRemoved(tabName); });
    chrome.tabs.onUpdated.addListener((tabName, changeInfo, tab) => { router.onUpdated(tabName, changeInfo, tab); });
    chrome.tabs.onCreated.addListener((tab) => { router.onCreated(tab); });
    chrome.tabs.onAttached.addListener((tabName, info) => { router.onAttached(tabName, info); });
    chrome.windows.onFocusChanged.addListener((windowId) => { router.onFocusChanged(windowId); });
    chrome.windows.onRemoved.addListener((windowId) => { router.onWindowRemoved(windowId); });

    chrome.runtime.onStartup.addListener(() => { router.onStartup(); });
    chrome.runtime.onInstalled.addListener(() => { router.onInstalled(); });
};

const runtimeInitializer = createSessionRuntimeInitializer(initializeRuntime);
const initRuntime = async (): Promise<void> => {
    await runtimeInitializer.request();
};
const reportInitializationFailure = (error: unknown): void => {
    log.warning('session runtime initialization failed', {
        message: error instanceof Error ? error.message : String(error),
    });
};

(globalThis as DevWorkerGlobal).__rpaSessionRuntime = {
    configure: async (config) => {
        await chrome.storage.local.set({
            rpaWorkspaceName: config.workspaceName,
            rpaWsPort: config.wsPort,
        });
        await initRuntime();
    },
};

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {return;}
    if (!Object.keys(changes).some((key) => SESSION_CONFIG_KEYS.has(key))) {return;}
    void initRuntime().catch((error: unknown) => {reportInitializationFailure(error);});
});

void initRuntime().catch(reportInitializationFailure);
