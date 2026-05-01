import type { Page } from 'playwright';
import { createTraceTools, type BrowserAutomationTools } from '../runner/trace';
import type { RunnerPluginHost } from '../runner/hotreload/plugin_host';
import type { CreateTraceToolsFn } from '../runner/plugin_entry';
import type { TraceContext, TraceHooks, TraceSink } from '../runner/trace/types';
import type { WorkspaceRegistry } from './workspace_registry';

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
    workspaceRegistry: WorkspaceRegistry;
    traceHooks?: TraceHooks;
    traceSinks?: TraceSink[];
    pluginHost?: RunnerPluginHost;
};

export const createRuntimeRegistry = (options: RuntimeRegistryOptions): RuntimeRegistry => {
    const bindings = new Map<string, PageBinding>();
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
        page.on('close', () => {
            bindings.delete(key);
        });
        return binding;
    };

    const bindPage = (input: { workspaceName: string; tabName: string; page: Page }): PageBinding => {
        const workspace = options.workspaceRegistry.getWorkspace(input.workspaceName);
        if (!workspace) {throw new Error(`workspace not found: ${input.workspaceName}`);}
        const tab = workspace.tabRegistry.getTab(input.tabName);
        if (!tab) {throw new Error(`tab not found: ${input.tabName}`);}
        tab.page = input.page;
        const existing = bindings.get(keyOf(input.workspaceName, input.tabName));
        if (existing?.page === input.page) {
            return existing;
        }
        return createBinding(input.workspaceName, input.tabName, input.page);
    };

    const resolveBinding = async (workspaceName: string, tabName?: string): Promise<PageBinding> => {
        const workspace = options.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace) {throw new Error(`workspace not found: ${workspaceName}`);}
        const tab = workspace.tabRegistry.resolveTab(tabName);
        if (!tab.page) {throw new Error(`page not bound: ${workspaceName}/${tab.name}`);}
        const key = keyOf(workspaceName, tab.name);
        const existing = bindings.get(key);
        if (existing && existing.page === tab.page) {
            return existing;
        }
        return createBinding(workspaceName, tab.name, tab.page);
    };

    return {
        bindPage,
        resolveBinding,
        getBinding: (workspaceName, tabName) => bindings.get(keyOf(workspaceName, tabName)) || null,
    };
};
