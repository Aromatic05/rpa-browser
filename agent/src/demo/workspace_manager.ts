import crypto from 'crypto';
import type { PageRegistry } from '../runtime/page_registry';
import { runStepList } from '../runner/run_steps';
import type { StepUnion } from '../runner/steps/types';

export type WorkspacePublicInfo = {
    workspaceName: string;
    url: string;
    title: string;
    createdAt: number;
};

type WorkspaceState = {
    workspaceName: string;
    tabId: string;
    tabName: string;
    createdAt: number;
};

export type WorkspaceManagerDeps = {
    pageRegistry: PageRegistry;
};

export const createWorkspaceManager = (deps: WorkspaceManagerDeps) => {
    let active: WorkspaceState | null = null;

    const ensureActiveWorkspace = async (): Promise<WorkspaceState> => {
        if (active) {
            return active;
        }
        const created = await deps.pageRegistry.createWorkspace();
        const tabName = deps.pageRegistry.resolveTabName({
            workspaceName: created.workspaceName,
            tabId: created.tabId,
        });
        active = {
            workspaceName: created.workspaceName,
            tabId: created.tabId,
            tabName,
            createdAt: Date.now(),
        };
        return active;
    };

    const getActiveWorkspacePublicInfo = async (): Promise<WorkspacePublicInfo | null> => {
        if (!active) {return null;}
        const page = await deps.pageRegistry.resolvePage({
            workspaceName: active.workspaceName,
            tabId: active.tabId,
        });
        return {
            workspaceName: active.workspaceName,
            url: page.url(),
            title: await page.title(),
            createdAt: active.createdAt,
        };
    };

    const gotoInWorkspace = async (url: string) => {
        const workspace = await ensureActiveWorkspace();
        const step: StepUnion = {
            id: crypto.randomUUID(),
            name: 'browser.goto',
            args: { url },
            meta: { source: 'script', ts: Date.now() },
        };
        const { pipe, checkpoint } = await runStepList(workspace.workspaceName, [step], undefined, { stopOnError: true });
        const items = pipe.items as Array<{ stepId: string; ok: boolean; data?: unknown }>;
        const results = items.map((item) => ({ stepId: item.stepId, ok: item.ok, data: item.data }));
        return { ok: checkpoint.status !== 'failed' && results.every((item) => item.ok), results };
    };

    return { ensureActiveWorkspace, getActiveWorkspacePublicInfo, gotoInWorkspace };
};
