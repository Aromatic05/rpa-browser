import type { Action } from '../../src/actions/action_protocol';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import {PageSnapshotSessionStore} from '../../src/snapshot/session';
import type { ExecutionBinding } from '../../src/runtime/execution/bindings';
import type { PageRegistry } from '../../src/runtime/browser/page_registry';
import type { RuntimeWorkspace } from '../../src/runtime/workspace/workspace';
import { getRunnerConfig } from '../../src/config';

export type TestExecutionBinding = Omit<Partial<ExecutionBinding>, 'page' | 'pageRegistry' | 'traceTools' | 'traceCtx'> & {
    workspaceName?: string;
    tabName?: string;
    page?: any;
    pageRegistry?: PageRegistry;
    traceTools?: any;
    traceCtx?: any;
};

const createPageRegistryStub = (binding: ExecutionBinding): PageRegistry => ({
    createPage: async () => binding.page,
    bindPage: async () => binding.tabName,
    awaitPageBinding: async () => binding.page,
    createPageBinding: async () => binding.page,
    touchBinding: () => true,
    listStaleBindings: () => [],
    closePage: async () => undefined,
    debugPageBindings: async (bindingName) => ({
        bindingName,
        knownBindings: [binding.tabName],
        knownPagesSummary: [binding.page.url?.() || ''],
        pendingClaims: [],
    }),
    createPendingBindingClaim: () => undefined,
    claimPendingBinding: async () => false,
});

const createReply = (action: Action): Action => ({
    v: 1,
    id: `${action.id}-reply`,
    type: `${action.type}.result`,
    payload: {},
    workspaceName: action.workspaceName,
    replyTo: action.id,
    at: Date.now(),
});

export const completeRunStepsDeps = (
    partial: Omit<Partial<RunStepsDeps>, 'runtime'> & {
        runtime?: Omit<Partial<RunStepsDeps['runtime']>, 'resolveBinding' | 'awaitExecutableTab' | 'createExecutableTab'> & {
            ensureActivePage?: () => Promise<TestExecutionBinding>;
            resolveBinding?: (workspaceName: string, tabName?: string) => Promise<TestExecutionBinding>;
            awaitExecutableTab?: RunStepsDeps['runtime']['awaitExecutableTab'];
            createExecutableTab?: RunStepsDeps['runtime']['createExecutableTab'];
        };
    },
    input: TestExecutionBinding = {},
): RunStepsDeps => {
    const workspaceName = input.workspaceName || 'ws-1';
    const tabName = input.tabName || 'tab-1';
    const completePage = (value?: any) => {
        const target = value || {};
        if (typeof target.url !== 'function') {target.url = () => 'about:blank';}
        if (typeof target.bringToFront !== 'function') {target.bringToFront = async () => undefined;}
        if (typeof target.isClosed !== 'function') {target.isClosed = () => false;}
        if (typeof target.context !== 'function') {target.context = () => ({});}
        return target;
    };
    const page = completePage(input.page);
    const provisional = {
        workspaceName,
        tabName,
        page,
        traceTools: input.traceTools || {},
        traceCtx: input.traceCtx || { cache: {} },
    } as ExecutionBinding;
    const pageRegistry = input.pageRegistry || createPageRegistryStub(provisional);
    const binding: ExecutionBinding = { ...provisional, pageRegistry };
    const latestSnapshot = (binding.traceCtx.cache as any)?.latestSnapshot;
    if (latestSnapshot && !latestSnapshot.snapshotMeta) {
        latestSnapshot.snapshotMeta = {
            snapshotId: 'test-snapshot',
            pageIdentity: { workspaceName, tabName, url: page.url?.() || '' },
        };
    }

    const normalizeBinding = (value?: Partial<ExecutionBinding>): ExecutionBinding => ({
        ...binding,
        ...value,
        page: completePage(value?.page || page),
        pageRegistry: value?.pageRegistry || pageRegistry,
        traceTools: value?.traceTools || binding.traceTools,
        traceCtx: value?.traceCtx || binding.traceCtx,
    });
    const legacyEnsureActivePage = partial.runtime?.ensureActivePage;
    const sourceResolveBinding = partial.runtime?.resolveBinding
        ? partial.runtime.resolveBinding.bind(partial.runtime)
        : legacyEnsureActivePage
          ? async () => await legacyEnsureActivePage()
          : async () => binding;
    const resolveBinding = async (requestedWorkspaceName?: string, requestedTabName?: string) =>
        normalizeBinding(await sourceResolveBinding(requestedWorkspaceName || workspaceName, requestedTabName || tabName));

    const runtime = {
        ...partial.runtime,
        bindPage: partial.runtime?.bindPage || (() => binding),
        createExecutableTab: partial.runtime?.createExecutableTab || (async () => await resolveBinding(workspaceName, tabName)),
        getBinding: partial.runtime?.getBinding || (() => binding),
        resolveBinding,
        awaitExecutableTab: partial.runtime?.awaitExecutableTab || (async () => await resolveBinding(workspaceName, tabName)),
    } as RunStepsDeps['runtime'];

    const tab = {
        name: tabName,
        page,
        url: page.url?.() || '',
        title: '',
        createdAt: 0,
        updatedAt: 0,
    };
    const workspace = {
        name: workspaceName,
        browserSession: { pageRegistry },
        tabs: {
            getActiveTab: () => tab,
            getTab: (name: string) => (name === tabName ? tab : null),
            hasTab: (name: string) => name === tabName,
            listTabs: () => [tab],
            bindPage: () => tab,
            updateTab: () => tab,
        },
    } as unknown as RuntimeWorkspace;

    const defaultConfig = getRunnerConfig();
    const config = {
        ...defaultConfig,
        ...(partial.config || {}),
        waitPolicy: {
            ...defaultConfig.waitPolicy,
            ...((partial.config as any)?.waitPolicy || {}),
        },
    };

    return {
        ...partial,
        config,
        runtime,
        pageSession: partial.pageSession || new PageSnapshotSessionStore(),
        resolveWorkspace: partial.resolveWorkspace || ((name: string) => {
            if (name !== workspaceName) {
                throw new Error(`workspace not found: ${name}`);
            }
            return workspace;
        }),
        dispatchAction: partial.dispatchAction || (async (action: Action) => createReply(action)),
    } as RunStepsDeps;
};
