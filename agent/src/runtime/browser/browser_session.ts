import path from 'node:path';
import type { BrowserContext, Page, Worker } from 'playwright';
import { createContextManager } from './context_manager';
import { createPageRegistry, type PageRegistry } from './page_registry';
import { startActionWsClient, type ActionWsClient, type ActionWsTap } from '../../actions/ws_client';
import type { Action } from '../../actions/action_protocol';
import type { WorkspaceRegistry } from '../workspace/registry';
import type { PortAllocator } from '../service/ports';

export type BrowserSessionStatus = 'stopped' | 'starting' | 'running' | 'stopping';

export type WorkspaceBrowserSession = {
    workspaceName: string;
    userDataDir: string;
    wsPort: number | null;
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

const buildStartUrl = (workspaceName: string, wsPort: number): string => {
    const params = new URLSearchParams({
        rpaWorkspaceName: workspaceName,
        rpaWsPort: String(wsPort),
    });
    return `chrome://newtab/?${params.toString()}`;
};

const configureExtensionSession = async (context: BrowserContext, workspaceName: string, wsPort: number) => {
    const worker = await resolveExtensionServiceWorker(context);
    await worker.evaluate(
        async (config: { workspaceName: string; wsPort: number }) => {
            const chromeApi = (globalThis as any).chrome;
            await chromeApi.storage.local.set({
                rpaWorkspaceName: config.workspaceName,
                rpaWsPort: config.wsPort,
            });
        },
        { workspaceName, wsPort },
    );
};

const resolveExtensionServiceWorker = async (context: BrowserContext): Promise<Worker> => {
    const pick = () => context.serviceWorkers().find((worker) => worker.url().includes('/entry/sw.js')) || null;
    const existing = pick();
    if (existing) {return existing;}
    const worker = await context.waitForEvent('serviceworker', { timeout: 5000 });
    if (worker.url().includes('/entry/sw.js')) {return worker;}
    const matched = pick();
    if (matched) {return matched;}
    throw new Error('extension service worker not found');
};

export const createWorkspaceBrowserSession = (options: CreateWorkspaceBrowserSessionOptions): WorkspaceBrowserSession => {
    const userDataDir = path.join(options.userDataRoot, 'workspaces', options.workspaceName);
    let wsPort: number | null = null;
    let status: BrowserSessionStatus = 'stopped';
    let wsClient: ActionWsClient | null = null;
    let startPromise: Promise<void> | null = null;

    let contextManager = createContextManager({
        extensionPaths: options.extensionPaths,
        userDataDir,
        startUrl: 'chrome://newtab/',
        onPage: (page) => {
            void pageRegistry.bindPage(page);
        },
    });

    const pageRegistry = createPageRegistry({
        tabNameKey: options.tabNameKey,
        getContext: () => contextManager.getContext(),
        onPageBound: options.onPageBound,
        onBindingClosed: options.onBindingClosed,
    });

    const session: WorkspaceBrowserSession = {
        workspaceName: options.workspaceName,
        userDataDir,
        get wsPort() {
            return wsPort;
        },
        get status() {
            return status;
        },
        pageRegistry,
        start: async () => {
            if (status === 'running') {return;}
            if (startPromise) {return await startPromise;}
            startPromise = (async () => {
                status = 'starting';
                wsPort = await options.portAllocator.allocate(options.workspaceName, 'action-ws');
                const configuredContextManager = createContextManager({
                    extensionPaths: options.extensionPaths,
                    userDataDir,
                    startUrl: buildStartUrl(options.workspaceName, wsPort),
                    onPage: (page) => {
                        void pageRegistry.bindPage(page);
                    },
                });
                contextManager = configuredContextManager;
                wsClient = startActionWsClient({
                    port: wsPort,
                    host: '127.0.0.1',
                    workspaceRegistry: options.workspaceRegistry,
                    dispatchAction: options.dispatchAction,
                    onError: options.onError ?? (() => undefined),
                    onListening: (url) => options.onListening?.(options.workspaceName, url),
                    wsTap: options.wsTap,
                });
                const context = await contextManager.getContext();
                await configureExtensionSession(context, options.workspaceName, wsPort);
                await wsClient.waitForClient(5000);
                status = 'running';
            })();
            try {
                await startPromise;
            } catch (error) {
                status = 'stopped';
                await wsClient?.close().catch(() => undefined);
                wsClient = null;
                await contextManager.close().catch(() => undefined);
                options.portAllocator.release(options.workspaceName, 'action-ws');
                wsPort = null;
                throw error;
            } finally {
                startPromise = null;
            }
        },
        stop: async () => {
            if (startPromise) {
                await startPromise.catch(() => undefined);
            }
            if (status === 'stopped') {return;}
            status = 'stopping';
            await wsClient?.close();
            wsClient = null;
            await contextManager.close();
            options.portAllocator.release(options.workspaceName, 'action-ws');
            wsPort = null;
            status = 'stopped';
        },
        emit: (action) => {
            wsClient?.broadcastAction(action);
        },
    };

    return session;
};
