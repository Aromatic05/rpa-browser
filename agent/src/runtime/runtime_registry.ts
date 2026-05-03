import type { Page } from 'playwright';
import { createTraceTools, type BrowserAutomationTools } from '../runner/trace';
import type { RunnerPluginHost } from '../runner/hotreload/plugin_host';
import type { CreateTraceToolsFn } from '../runner/plugin_entry';
import type { TraceContext, TraceHooks, TraceSink } from '../runner/trace/types';

export type PageBinding = {
    workspaceName: string;
    tabName: string;
    page: Page;
    traceTools: BrowserAutomationTools;
    traceCtx: TraceContext;
};

export type RuntimeRegistry = {
    bindPage: (input: { workspaceName: string; tabName: string; page: Page }) => PageBinding;
    resolveBinding: (workspaceName: string, tabName?: string) => Promise<PageBinding>;
    getBinding: (workspaceName: string, tabName: string) => PageBinding | null;
};

type RuntimeRegistryOptions = {
    traceHooks?: TraceHooks;
    traceSinks?: TraceSink[];
    pluginHost?: RunnerPluginHost;
};

export const createRuntimeRegistry = (options: RuntimeRegistryOptions): RuntimeRegistry => {
    const bindings = new Map<string, PageBinding>();
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
                    workspaceName: binding.workspaceName,
                    sinks: options.traceSinks,
                    hooks: options.traceHooks,
                    tags: { workspaceName: binding.workspaceName, tabName: binding.tabName } as any,
                });
                binding.traceTools = tools;
                binding.traceCtx = ctx;
            }
        });
    }

    const createBinding = (workspaceName: string, tabName: string, page: Page): PageBinding => {
        const { tools, ctx } = resolveCreateTraceTools()({
            page,
            context: page.context(),
            workspaceName: workspaceName,
            sinks: options.traceSinks,
            hooks: options.traceHooks,
            tags: { workspaceName, tabName } as any,
        });
        const binding: PageBinding = { workspaceName, tabName, page, traceTools: tools, traceCtx: ctx };
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
                activeTabs.delete(workspaceName);
            } else if (activeTabs.get(workspaceName) === tabName) {
                const nextTab = tabsForWorkspace ? tabsForWorkspace.values().next().value : undefined;
                if (nextTab) {
                    activeTabs.set(workspaceName, nextTab);
                } else {
                    activeTabs.delete(workspaceName);
                }
            }
        });
        return binding;
    };

    const bindPage = (input: { workspaceName: string; tabName: string; page: Page }): PageBinding => {
        const existing = bindings.get(keyOf(input.workspaceName, input.tabName));
        if (existing?.page === input.page) {
            activeTabs.set(input.workspaceName, input.tabName);
            return existing;
        }
        return createBinding(input.workspaceName, input.tabName, input.page);
    };

    const resolveBinding = async (workspaceName: string, tabName?: string): Promise<PageBinding> => {
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
        const tabs = workspaceTabs.get(workspaceName);
        const fallbackTab = tabs?.values().next().value as string | undefined;
        if (!fallbackTab) {throw new Error(`page not bound: ${workspaceName}`);}
        const bound = bindings.get(keyOf(workspaceName, fallbackTab));
        if (!bound) {throw new Error(`page not bound: ${workspaceName}/${fallbackTab}`);}
        activeTabs.set(workspaceName, fallbackTab);
        return bound;
    };

    return {
        bindPage,
        resolveBinding,
        getBinding: (workspaceName, tabName) => bindings.get(keyOf(workspaceName, tabName)) || null,
    };
};
