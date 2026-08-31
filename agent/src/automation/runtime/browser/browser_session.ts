import path from 'node:path';
import type { BrowserContext, Page, Worker } from 'playwright';
import {getLogger} from '../../../platform/logging/logger';
import { createContextManager } from './context_manager';
import { createPageRegistry, type PageRegistry } from './page_registry';
import { startActionWsClient, type ActionWsClient, type ActionWsTap } from '../actions/ws_client';
import type { Action } from '../../../interface/actions/action_protocol';
import type { WorkspaceRegistry } from '../workspace/registry';
import type { PortAllocator } from '../service/ports';
import {
    resolveExtensionBuildStampPath,
    startExtensionDevReloader,
    type ExtensionDevReloader,
} from './extension_dev_reload';

export type BrowserSessionStatus = 'stopped' | 'starting' | 'running' | 'stopping';

export type WorkspaceBrowserSession = {
    workspaceName: string;
    userDataDir: string;
    wsPort: number | null;
    cdpPort: number | null;
    status: BrowserSessionStatus;
    pageRegistry: PageRegistry;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    emit: (action: Action) => void;
};

export type CreateWorkspaceBrowserSessionOptions = {
    workspaceName: string;
    tabNameKey: string;
    extensionPaths: string[];
    userDataRoot: string;
    workspaceRegistry: WorkspaceRegistry;
    portAllocator: PortAllocator;
    dispatchAction: (action: Action) => Promise<Action>;
    onPageBound?: (page: Page, bindingName: string) => void;
    onBindingClosed?: (bindingName: string) => void;
    onError?: (error: unknown) => void;
    onListening?: (workspaceName: string, url: string) => void;
    wsTap?: ActionWsTap;
};

type ExtensionRuntimeReady = {
    buildId: string;
    manifestVersion: string;
    workspaceName: string;
    wsPort: number;
    sessionKey: string;
    acceptsAnnotatorOpen: boolean;
    readyAt: number;
};

type ExtensionRuntimeState = {
    workerUrl: string;
    manifestName: string;
    buildId: string;
    manifestVersion: string;
    ready: ExtensionRuntimeReady | null;
};

export const buildStartPageUrl = (workspaceName: string, wsPort: number): string => {
    const params = new URLSearchParams({
        rpaWorkspaceName: workspaceName,
        rpaWsPort: String(wsPort),
    });
    return `chrome://newtab/?${params.toString()}`;
};

export const resolveInteractiveStartUrl = (workspaceName: string, wsPort: number): string => {
    const configured = process.env.RPA_START_URL?.trim();
    if (configured) {
        return configured;
    }
    return buildStartPageUrl(workspaceName, wsPort);
};

const RUNTIME_READY_KEY = 'rpa.runtime.ready';

const readExtensionRuntimeState = async (worker: Worker): Promise<ExtensionRuntimeState> =>
    await worker.evaluate(async (readyKey: string) => {
        const runtimeGlobal = globalThis as typeof globalThis & {
            chrome: {
                runtime: {getManifest: () => {name: string; version: string; version_name?: string}};
                storage: {local: {get: (key: string) => Promise<Record<string, unknown>>}};
            };
            location: {href: string};
        };
        const manifest = runtimeGlobal.chrome.runtime.getManifest();
        const stored = await runtimeGlobal.chrome.storage.local.get(readyKey);
        return {
            workerUrl: runtimeGlobal.location.href,
            manifestName: manifest.name,
            buildId: manifest.version_name ?? manifest.version,
            manifestVersion: manifest.version,
            ready: (stored[readyKey] ?? null) as ExtensionRuntimeReady | null,
        };
    }, RUNTIME_READY_KEY);

const resolveExtensionServiceWorker = async (context: BrowserContext): Promise<Worker> => {
    const observed: Array<{url: string; name?: string; error?: string}> = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        for (const worker of context.serviceWorkers()) {
            try {
                const state = await readExtensionRuntimeState(worker);
                if (state.manifestName === 'RPA Browser' && state.workerUrl.includes('/entry/sw.js')) {return worker;}
                if (!observed.some((item) => item.url === state.workerUrl && item.name === state.manifestName)) {
                    observed.push({url: state.workerUrl, name: state.manifestName});
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!observed.some((item) => item.url === worker.url() && item.error === message)) {
                    observed.push({url: worker.url(), error: message});
                }
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`main extension service worker not found: ${JSON.stringify(observed)}`);
};

const configureExtensionSession = async (
    context: BrowserContext,
    workspaceName: string,
    wsPort: number,
): Promise<ExtensionRuntimeReady> => {
    const bootstrapPage = await context.newPage();
    await bootstrapPage.goto(`http://127.0.0.1:${String(wsPort)}/rpa-start?rpaRuntimeBootstrap=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 10_000,
    });
    let worker = await resolveExtensionServiceWorker(context);
    const state = await readExtensionRuntimeState(worker);

    await worker.evaluate(async (input: {workspaceName: string; wsPort: number}) => {
        const runtimeGlobal = globalThis as typeof globalThis & {
            __rpaSessionRuntime?: {
                configure: (config: {workspaceName: string; wsPort: number}) => Promise<void>;
            };
        };
        const sessionRuntime = runtimeGlobal.__rpaSessionRuntime;
        if (!sessionRuntime) {
            throw new Error('main extension session runtime bridge is unavailable');
        }
        await sessionRuntime.configure({workspaceName: input.workspaceName, wsPort: input.wsPort});
    }, {workspaceName, wsPort});

    const deadline = Date.now() + 12_000;
    let lastState = state;
    while (Date.now() < deadline) {
        try {
            worker = await resolveExtensionServiceWorker(context);
            lastState = await readExtensionRuntimeState(worker);
            const ready = lastState.ready;
            if (ready?.buildId === lastState.buildId
                && ready.manifestVersion === lastState.manifestVersion
                && ready.workspaceName === workspaceName
                && ready.wsPort === wsPort
                && ready.sessionKey === `${workspaceName}:${String(wsPort)}`
                && ready.acceptsAnnotatorOpen) {
                if (!bootstrapPage.isClosed()) {
                    await bootstrapPage.close();
                }
                return ready;
            }
        } catch {
            // Extension reload can briefly invalidate the previous worker target.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!bootstrapPage.isClosed()) {
        await bootstrapPage.close().catch(() => undefined);
    }
    throw new Error(`main extension runtime readiness timeout: ${JSON.stringify(lastState)}`);
};

const awaitStartPageBinding = async (input: {
    context: BrowserContext;
    pageRegistry: PageRegistry;
    workspaceRegistry: WorkspaceRegistry;
    workspaceName: string;
    tabNameKey: string;
}): Promise<string> => {
    const deadline = Date.now() + 10_000;
    let lastState: Record<string, unknown> = {};
    while (Date.now() < deadline) {
        const page = input.context.pages().find((candidate) => candidate.url().includes('/newtab.html'));
        const pageState = page
            ? await page.evaluate((key: string) => {
                const runtimeWindow = window as Window & {
                    __rpa_tab_name?: string;
                    __rpa_start_error?: string;
                };
                return {
                    tabName: sessionStorage.getItem(key) ?? runtimeWindow.__rpa_tab_name ?? '',
                    wsStatus: document.querySelector('#wsStatus')?.textContent.trim() ?? '',
                    tokenText: document.querySelector('#tabToken')?.textContent.trim() ?? '',
                    startError: runtimeWindow.__rpa_start_error ?? '',
                    readyState: document.readyState,
                };
            }, input.tabNameKey).catch(() => ({
                tabName: '',
                wsStatus: 'page-evaluate-failed',
                tokenText: '',
                startError: '',
                readyState: '',
            }))
            : {tabName: '', wsStatus: 'page-missing', tokenText: '', startError: '', readyState: ''};
        const tabName = pageState.tabName;
        const workspace = input.workspaceRegistry.getWorkspace(input.workspaceName);
        const hasRuntimeTab = Boolean(tabName && workspace?.tabs.hasTab(tabName));
        let boundPage: Page | null = null;
        if (page && tabName) {
            await input.pageRegistry.bindPage(page, tabName);
            boundPage = await input.pageRegistry.awaitPageBinding(tabName, {timeoutMs: 250})
                .catch(() => null);
        }
        lastState = {
            pageUrl: page?.url() ?? null,
            tabName,
            wsStatus: pageState.wsStatus,
            tokenText: pageState.tokenText,
            startError: pageState.startError,
            readyState: pageState.readyState,
            hasRuntimeTab,
            bound: boundPage === page,
        };
        if (page && tabName && hasRuntimeTab && boundPage === page) {
            return tabName;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`start page binding timeout: ${JSON.stringify(lastState)}`);
};

const browserMode = () => (process.env.RPA_BROWSER_MODE || 'extension').trim().toLowerCase();
const extensionAutoReloadEnabled = () =>
    ['1', 'true', 'yes', 'on'].includes((process.env.RPA_EXTENSION_AUTO_RELOAD || '').trim().toLowerCase());

export const createWorkspaceBrowserSession = (options: CreateWorkspaceBrowserSessionOptions): WorkspaceBrowserSession => {
    const actionLog = getLogger('action');
    const userDataDir = path.join(options.userDataRoot, 'workspaces', options.workspaceName);
    const configuredCdpEndpoint = process.env.RPA_CDP_ENDPOINT?.trim() || '';
    const managedCdpProcess = browserMode() === 'cdp' && !configuredCdpEndpoint;
    const chromePath = process.env.RPA_CHROME_PATH?.trim() || process.env.RPA_CDP_CHROME_PATH?.trim() || undefined;

    let wsPort: number | null = null;
    let cdpPort: number | null = null;
    let status: BrowserSessionStatus = 'stopped';
    let wsClient: ActionWsClient | null = null;
    let startPromise: Promise<void> | null = null;
    let stopPromise: Promise<void> | null = null;
    let sessionRef: WorkspaceBrowserSession | null = null;
    let extensionDevReloader: ExtensionDevReloader | null = null;

    const createSessionContextManager = (assignedCdpPort: number | null, startUrl: string) => createContextManager({
        extensionPaths: options.extensionPaths,
        userDataDir,
        startUrl,
        cdpPort: assignedCdpPort ?? undefined,
        cdpEndpoint: configuredCdpEndpoint || undefined,
        chromePath,
        onPage: (page) => {
            void pageRegistry.bindPage(page);
        },
    });

    let contextManager = createSessionContextManager(null, 'chrome://newtab/');

    const pageRegistry = createPageRegistry({
        tabNameKey: options.tabNameKey,
        getContext: async () => {
            if (sessionRef?.status === 'stopping') {
                throw new Error(`workspace browser session is stopping: ${options.workspaceName}`);
            }
            if (sessionRef?.status === 'stopped') {
                await sessionRef.start();
            }
            return await contextManager.getContext();
        },
        onPageBound: options.onPageBound,
        onBindingClosed: options.onBindingClosed,
    });

    const releasePorts = () => {
        options.portAllocator.release(options.workspaceName, 'action-ws');
        if (managedCdpProcess) {
            options.portAllocator.release(options.workspaceName, 'browser-cdp');
        }
        wsPort = null;
        cdpPort = null;
    };

    const session: WorkspaceBrowserSession = {
        workspaceName: options.workspaceName,
        userDataDir,
        get wsPort() {
            return wsPort;
        },
        get cdpPort() {
            return cdpPort;
        },
        get status() {
            return status;
        },
        pageRegistry,
        start: async () => {
            if (status === 'running') {return;}
            if (status === 'stopping') {
                throw new Error(`workspace browser session is stopping: ${options.workspaceName}`);
            }
            if (startPromise) {await startPromise; return;}
            startPromise = (async () => {
                status = 'starting';
                wsPort = await options.portAllocator.allocate(options.workspaceName, 'action-ws');
                if (managedCdpProcess) {
                    cdpPort = await options.portAllocator.allocate(options.workspaceName, 'browser-cdp');
                }

                contextManager = createSessionContextManager(
                    cdpPort,
                    resolveInteractiveStartUrl(options.workspaceName, wsPort),
                );
                wsClient = startActionWsClient({
                    port: wsPort,
                    host: '127.0.0.1',
                    workspaceRegistry: options.workspaceRegistry,
                    dispatchAction: options.dispatchAction,
                    onError: options.onError ?? (() => undefined),
                    onListening: (url) => options.onListening?.(options.workspaceName, url),
                    wsTap: options.wsTap,
                });

                await wsClient.waitForListening(5000);
                actionLog.info('[RPA:agent]', 'browser startup stage', {
                    workspaceName: options.workspaceName,
                    stage: 'context.start',
                });
                const context = await contextManager.getContext();
                actionLog.info('[RPA:agent]', 'browser startup stage', {
                    workspaceName: options.workspaceName,
                    stage: 'context.ready',
                    pages: context.pages().map((page) => page.url()),
                });
                const extensionRuntime = await configureExtensionSession(
                    context,
                    options.workspaceName,
                    wsPort,
                );
                actionLog.info('[RPA:agent]', 'browser startup stage', {
                    workspaceName: options.workspaceName,
                    stage: 'extension.configured',
                    activeSessionKey: extensionRuntime.sessionKey,
                    buildId: extensionRuntime.buildId,
                    manifestVersion: extensionRuntime.manifestVersion,
                });
                await wsClient.waitForClient(10_000);
                const startTabName = await awaitStartPageBinding({
                    context,
                    pageRegistry,
                    workspaceRegistry: options.workspaceRegistry,
                    workspaceName: options.workspaceName,
                    tabNameKey: options.tabNameKey,
                });
                actionLog.info('[RPA:agent]', 'browser startup stage', {
                    workspaceName: options.workspaceName,
                    stage: 'extension.connected',
                    startTabName,
                });
                if (extensionAutoReloadEnabled()) {
                    extensionDevReloader = startExtensionDevReloader({
                        stampPath: resolveExtensionBuildStampPath(options.extensionPaths),
                        extensionPaths: options.extensionPaths,
                        workspaceName: options.workspaceName,
                        getContext: async () => await contextManager.getContext(),
                        configureMainExtension: async (reloadContext) => {
                            if (wsPort === null) {throw new Error('workspace action websocket port is unavailable');}
                            await configureExtensionSession(reloadContext, options.workspaceName, wsPort);
                        },
                        startUrl: () => {
                            if (wsPort === null) {return 'chrome://newtab/';}
                            return resolveInteractiveStartUrl(options.workspaceName, wsPort);
                        },
                        onError: options.onError,
                    });
                }
                status = 'running';
            })();
            try {
                await startPromise;
            } catch (error) {
                status = 'stopped';
                await extensionDevReloader?.close().catch(() => undefined);
                extensionDevReloader = null;
                await wsClient?.close().catch(() => undefined);
                wsClient = null;
                await contextManager.close().catch(() => undefined);
                releasePorts();
                throw error;
            } finally {
                startPromise = null;
            }
        },
        stop: async () => {
            if (stopPromise) {await stopPromise; return;}
            stopPromise = (async () => {
                if (startPromise) {
                    await startPromise.catch(() => undefined);
                }
                if (status === 'stopped' && !wsClient && wsPort === null && cdpPort === null) {return;}
                status = 'stopping';
                let closeError: unknown;
                try {
                    await extensionDevReloader?.close();
                } catch (error) {
                    closeError = error;
                }
                extensionDevReloader = null;
                try {
                    await wsClient?.close();
                } catch (error) {
                    closeError = error;
                }
                wsClient = null;
                try {
                    await contextManager.close();
                } catch (error) {
                    closeError = closeError || error;
                } finally {
                    releasePorts();
                    status = 'stopped';
                }
                if (closeError) {throw closeError;}
            })();
            try {
                await stopPromise;
            } finally {
                stopPromise = null;
            }
        },
        emit: (action) => {
            wsClient?.broadcastAction(action);
        },
    };
    sessionRef = session;

    return session;
};
