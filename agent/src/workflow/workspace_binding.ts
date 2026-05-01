import type { PageRegistry } from '../runtime/page_registry';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import type { WorkflowWorkspaceBinding } from './types';

export type ResolveWorkflowWorkspaceDeps = {
    pageRegistry: PageRegistry;
    restoreWorkspace: (workspaceName: string) => Promise<{ workspaceName: string; tabName: string }>;
};

export type ResolveWorkflowWorkspaceInput = {
    scene: string;
    binding?: WorkflowWorkspaceBinding;
};

type ResolvedWorkspace = {
    workspaceName: string;
    tabName: string;
};

const toWorkspaceName = (scene: string): string => `workflow:${scene}`;

const ensureEntryUrl = async (
    deps: ResolveWorkflowWorkspaceDeps,
    resolved: ResolvedWorkspace,
    entryUrl?: string,
): Promise<void> => {
    if (!entryUrl) {return;}
    const page = await deps.pageRegistry.getPage(resolved.tabName);
    if (page.url() !== entryUrl) {
        await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    }
};

const ensureExpectedTabs = async (
    deps: ResolveWorkflowWorkspaceDeps,
    resolved: ResolvedWorkspace,
    expectedTabs?: WorkflowWorkspaceBinding['workspace']['expectedTabs'],
): Promise<void> => {
    if (!expectedTabs || expectedTabs.length === 0) {return;}
    const page = await deps.pageRegistry.getPage(resolved.tabName);
    const currentUrl = page.url();
    const activeExpectation = expectedTabs.find((item) => item.ref === 'main') || expectedTabs[0];
    if (activeExpectation.exactUrl && currentUrl !== activeExpectation.exactUrl) {
        throw new DslRuntimeError(
            `workflow expectedTabs exactUrl mismatch: expected=${activeExpectation.exactUrl} actual=${currentUrl}`,
            'ERR_WORKFLOW_WORKSPACE_RESOLVE_FAILED',
        );
    }
    if (activeExpectation.urlIncludes && !currentUrl.includes(activeExpectation.urlIncludes)) {
        throw new DslRuntimeError(
            `workflow expectedTabs urlIncludes mismatch: expected*= ${activeExpectation.urlIncludes} actual=${currentUrl}`,
            'ERR_WORKFLOW_WORKSPACE_RESOLVE_FAILED',
        );
    }
};

const createWorkspace = async (deps: ResolveWorkflowWorkspaceDeps, scene: string): Promise<ResolvedWorkspace> => {
    const workspaceName = toWorkspaceName(scene);
    const tabName = `workflow-${scene}-${Date.now()}`;
    await deps.pageRegistry.getPage(tabName);
    return {
        workspaceName,
        tabName,
    };
};

const restoreWorkspace = async (deps: ResolveWorkflowWorkspaceDeps, scene: string): Promise<ResolvedWorkspace> => {
    const workspaceName = toWorkspaceName(scene);
    const restored = await deps.restoreWorkspace(workspaceName);
    return restored;
};

export const resolveWorkflowWorkspace = async (
    deps: ResolveWorkflowWorkspaceDeps,
    input: ResolveWorkflowWorkspaceInput,
): Promise<ResolvedWorkspace> => {
    const strategy = input.binding?.workspace.strategy || 'restoreOrCreate';
    try {
        if (strategy === 'createOnly') {
            const created = await createWorkspace(deps, input.scene);
            await ensureEntryUrl(deps, created, input.binding?.workspace.entryUrl);
            await ensureExpectedTabs(deps, created, input.binding?.workspace.expectedTabs);
            return created;
        }
        if (strategy === 'restoreOnly') {
            const restored = await restoreWorkspace(deps, input.scene);
            await ensureEntryUrl(deps, restored, input.binding?.workspace.entryUrl);
            await ensureExpectedTabs(deps, restored, input.binding?.workspace.expectedTabs);
            return restored;
        }
        try {
            const restored = await restoreWorkspace(deps, input.scene);
            await ensureEntryUrl(deps, restored, input.binding?.workspace.entryUrl);
            await ensureExpectedTabs(deps, restored, input.binding?.workspace.expectedTabs);
            return restored;
        } catch {
            const created = await createWorkspace(deps, input.scene);
            await ensureEntryUrl(deps, created, input.binding?.workspace.entryUrl);
            await ensureExpectedTabs(deps, created, input.binding?.workspace.expectedTabs);
            return created;
        }
    } catch (error) {
        throw new DslRuntimeError(
            `workflow workspace resolve failed: scene=${input.scene} strategy=${strategy} error=${error instanceof Error ? error.message : String(error)}`,
            'ERR_WORKFLOW_WORKSPACE_RESOLVE_FAILED',
        );
    }
};
