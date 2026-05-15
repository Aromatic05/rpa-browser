import path from 'node:path';
import type { Page } from 'playwright';
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

export const createWorkspaceBrowserSession = (options: CreateWorkspaceBrowserSessionOptions): WorkspaceBrowserSession => {
    const userDataDir = path.join(options.userDataRoot, 'workspaces', options.workspaceName);
    let wsPort: number | null = null;
    let status: BrowserSessionStatus = 'stopped';
    let wsClient: ActionWsClient | null = null;

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
            if (status === 'starting') {return;}
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
            await contextManager.getContext();
            status = 'running';
        },
        stop: async () => {
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
