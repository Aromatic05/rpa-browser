import type { Page } from 'playwright';
import type { Action } from '../../actions/action_protocol';
import { ActionError, ERROR_CODES } from '../../actions/results';
import { createTraceTools, type BrowserAutomationTools } from '../../runner/trace';
import type { RunnerPluginHost } from '../../runner/hotreload/plugin_host';
import type { CreateTraceToolsFn } from '../../runner/plugin_entry';
import type { TraceContext, TraceHooks, TraceSink } from '../../runner/trace/types';
import type { RuntimeWorkspace } from '../workspace/workspace';
import type { PageRegistry } from '../browser/page_registry';

export type ExecutionBinding = {
    workspaceName: string;
    tabName: string;
    page: Page;
    traceTools: BrowserAutomationTools;
    traceCtx: TraceContext;
};

export type ExecutionBindings = {
    bindPage: (input: { workspaceName: string; tabName: string; page: Page }) => ExecutionBinding;
    awaitExecutableTab: (input: {
        workspace: RuntimeWorkspace;
        pageRegistry: PageRegistry;
        tabName: string;
        timeoutMs: number;
    }) => Promise<ExecutionBinding>;
    createExecutableTab: (input: {
        workspace: RuntimeWorkspace;
        pageRegistry: PageRegistry;
        tabName: string;
        startUrl?: string;
    }) => Promise<ExecutionBinding>;
    resolveBinding: (workspaceName: string, tabName?: string) => Promise<ExecutionBinding>;
    getBinding: (workspaceName: string, tabName: string) => ExecutionBinding | null;
};

type ExecutionBindingsOptions = {
    pageRegistry: PageRegistry;
    traceHooks?: TraceHooks;
    traceSinks?: TraceSink[];
    pluginHost?: RunnerPluginHost;
    dispatchAction?: (action: Action) => Promise<Action>;
};

const isBindableUrl = (url: string): boolean => {
    if (!url) {return false;}
    return /^(https?:|file:|about:blank)/.test(url);
};

export const createExecutionBindings = (options: ExecutionBindingsOptions): ExecutionBindings => {
    const bindings = new Map<string, ExecutionBinding>();
    const workspaceTabs = new Map<string, Set<string>>();
    const activeTabs = new Map<string, string>();
    const keyOf = (workspaceName: string, tabName: string) => `${workspaceName}::${tabName}`;
    const resolveCreateTraceTools = (): CreateTraceToolsFn => options.pluginHost?.getTraceToolsFactory() || createTraceTools;

    if (options.pluginHost) {
        options.pluginHost.onReload((plugin) => {
            for (const binding of bindings.values()) {
                const { tools, ctx } = plugin.createTraceTools({
                    page: binding.page,
                    context: binding.page.context(),
                    pageRegistry: options.pageRegistry,
                    workspaceName: binding.workspaceName,
                    dispatchAction: options.dispatchAction,
                    sinks: options.traceSinks,
                    hooks: options.traceHooks,
                    tags: { workspaceName: binding.workspaceName, tabName: binding.tabName } as any,
                });
                binding.traceTools = tools;
                binding.traceCtx = ctx;
            }
        });
    }

    const createBinding = (workspaceName: string, tabName: string, page: Page): ExecutionBinding => {
        const { tools, ctx } = resolveCreateTraceTools()({
            page,
            context: page.context(),
            pageRegistry: options.pageRegistry,
            workspaceName: workspaceName,
            dispatchAction: options.dispatchAction,
            sinks: options.traceSinks,
            hooks: options.traceHooks,
            tags: { workspaceName, tabName } as any,
        });
        const binding: ExecutionBinding = { workspaceName, tabName, page, traceTools: tools, traceCtx: ctx };
        const key = keyOf(workspaceName, tabName);
        bindings.set(key, binding);
        const tabs = workspaceTabs.get(workspaceName) || new Set<string>();
        tabs.add(tabName);
        workspaceTabs.set(workspaceName, tabs);
        activeTabs.set(workspaceName, tabName);
        page.on('close', () => {
            bindings.delete(key);
            const tabsForWorkspace = workspaceTabs.get(workspaceName);
            tabsForWorkspace?.delete(tabName);
            if (tabsForWorkspace && tabsForWorkspace.size === 0) {
                workspaceTabs.delete(workspaceName);
            }
            if (activeTabs.get(workspaceName) === tabName) {
                activeTabs.delete(workspaceName);
            }
        });
        return binding;
    };

    const bindPage = (input: { workspaceName: string; tabName: string; page: Page }): ExecutionBinding => {
        const existing = bindings.get(keyOf(input.workspaceName, input.tabName));
        if (existing?.page === input.page) {
            activeTabs.set(input.workspaceName, input.tabName);
            return existing;
        }
        return createBinding(input.workspaceName, input.tabName, input.page);
    };

    const buildTimeoutError = async (input: {
        workspace: RuntimeWorkspace;
        pageRegistry: PageRegistry;
        tabName: string;
        timeoutMs: number;
    }) => {
        const runtimeTab = input.workspace.tabs.getTab(input.tabName);
        const debug = await input.pageRegistry.debugPageBindings(input.tabName);
        return new ActionError(
            ERROR_CODES.ERR_PAGE_BINDING_TIMEOUT,
            `page binding timeout: ${input.workspace.name}/${input.tabName}`,
            {
                workspaceName: input.workspace.name,
                tabName: input.tabName,
                tabExists: Boolean(runtimeTab),
                tabUrl: runtimeTab?.url || '',
                tabTitle: runtimeTab?.title || '',
                hasRuntimeTabPage: Boolean(runtimeTab?.page && !runtimeTab.page.isClosed()),
                hasExecutionBinding: Boolean(bindings.get(keyOf(input.workspace.name, input.tabName))),
                isBindableUrl: isBindableUrl(runtimeTab?.url || ''),
                knownTabs: input.workspace.tabs.listTabs().map((tab) => ({
                    tabName: tab.name,
                    url: tab.url,
                    title: tab.title,
                    hasPage: Boolean(tab.page && !tab.page.isClosed()),
                })),
                knownBindings: debug.knownBindings,
                knownPagesSummary: debug.knownPagesSummary,
                timeoutMs: input.timeoutMs,
            },
        );
    };

    const awaitExecutableTab: ExecutionBindings['awaitExecutableTab'] = async (input) => {
        try {
            const page = await input.pageRegistry.awaitPageBinding(input.tabName, { timeoutMs: input.timeoutMs });
            if (input.workspace.tabs.hasTab(input.tabName)) {
                input.workspace.tabs.bindPage(input.tabName, page);
                input.workspace.tabs.updateTab(input.tabName, { url: page.url() });
            }
            return bindPage({ workspaceName: input.workspace.name, tabName: input.tabName, page });
        } catch {
            throw await buildTimeoutError(input);
        }
    };

    const createExecutableTab: ExecutionBindings['createExecutableTab'] = async (input) => {
        const page = await input.pageRegistry.createPageBinding(input.tabName, { startUrl: input.startUrl });
        if (!input.workspace.tabs.hasTab(input.tabName)) {
            input.workspace.tabs.createTab({ tabName: input.tabName });
        }
        input.workspace.tabs.bindPage(input.tabName, page);
        input.workspace.tabs.updateTab(input.tabName, { url: page.url() });
        return bindPage({ workspaceName: input.workspace.name, tabName: input.tabName, page });
    };

    const resolveBinding = async (workspaceName: string, tabName?: string): Promise<ExecutionBinding> => {
        if (tabName) {
            const bound = bindings.get(keyOf(workspaceName, tabName));
            if (!bound) {throw new Error(`page not bound: ${workspaceName}/${tabName}`);}
            activeTabs.set(workspaceName, tabName);
            return bound;
        }
        const activeTab = activeTabs.get(workspaceName);
        if (activeTab) {
            const bound = bindings.get(keyOf(workspaceName, activeTab));
            if (bound) {return bound;}
        }
        throw new Error(`no active binding: ${workspaceName}`);
    };

    return {
        bindPage,
        awaitExecutableTab,
        createExecutableTab,
        resolveBinding,
        getBinding: (workspaceName, tabName) => bindings.get(keyOf(workspaceName, tabName)) || null,
    };
};
