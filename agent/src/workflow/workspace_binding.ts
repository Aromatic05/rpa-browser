import type { PageRegistry } from '../runtime/page_registry';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import type { WorkflowWorkspaceBinding } from './types';

export type ResolveWorkflowWorkspaceDeps = {
    pageRegistry: PageRegistry;
    restoreWorkspace: (workspaceId: string) => Promise<{ workspaceId: string; tabId: string; tabToken: string }>;
};

export type ResolveWorkflowWorkspaceInput = {
    scene: string;
    binding?: WorkflowWorkspaceBinding;
};

type ResolvedWorkspace = {
    workspaceId: string;
    tabId: string;
    tabToken: string;
};

const toWorkspaceId = (scene: string): string => `workflow:${scene}`;

const ensureEntryUrl = async (
    deps: ResolveWorkflowWorkspaceDeps,
    resolved: ResolvedWorkspace,
    entryUrl?: string,
): Promise<void> => {
    if (!entryUrl) {return;}
    const page = await deps.pageRegistry.resolvePage({
        workspaceId: resolved.workspaceId,
        tabId: resolved.tabId,
    });
    if (page.url() !== entryUrl) {
        await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    }
};

const createWorkspace = async (deps: ResolveWorkflowWorkspaceDeps, scene: string): Promise<ResolvedWorkspace> => {
    const desiredWorkspaceId = toWorkspaceId(scene);
    const created = await deps.pageRegistry.createWorkspace();
    if (created.workspaceId !== desiredWorkspaceId) {
        deps.pageRegistry.createWorkspaceShell(desiredWorkspaceId);
    }
    return {
        workspaceId: created.workspaceId,
        tabId: created.tabId,
        tabToken: deps.pageRegistry.resolveTabToken({ workspaceId: created.workspaceId, tabId: created.tabId }),
    };
};

const restoreWorkspace = async (deps: ResolveWorkflowWorkspaceDeps, scene: string): Promise<ResolvedWorkspace> => {
    const workspaceId = toWorkspaceId(scene);
    const restored = await deps.restoreWorkspace(workspaceId);
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
            return created;
        }
        if (strategy === 'restoreOnly') {
            const restored = await restoreWorkspace(deps, input.scene);
            await ensureEntryUrl(deps, restored, input.binding?.workspace.entryUrl);
            return restored;
        }
        try {
            const restored = await restoreWorkspace(deps, input.scene);
            await ensureEntryUrl(deps, restored, input.binding?.workspace.entryUrl);
            return restored;
        } catch {
            const created = await createWorkspace(deps, input.scene);
            await ensureEntryUrl(deps, created, input.binding?.workspace.entryUrl);
            return created;
        }
    } catch (error) {
        throw new DslRuntimeError(
            `workflow workspace resolve failed: scene=${input.scene} strategy=${strategy} error=${error instanceof Error ? error.message : String(error)}`,
            'ERR_WORKFLOW_WORKSPACE_RESOLVE_FAILED',
        );
    }
};
