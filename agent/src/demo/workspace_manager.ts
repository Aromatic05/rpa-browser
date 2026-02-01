import crypto from 'crypto';
import type { Page } from 'playwright';
import type { PageRegistry } from '../runtime/page_registry';
import { createRecordingState, cleanupRecording, ensureRecorder } from '../record/recording';
import { runSteps } from '../runner/run_steps';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';
import type { StepUnion } from '../runner/steps/types';

export type WorkspacePublicInfo = {
    workspaceId: string;
    url: string;
    title: string;
    createdAt: number;
};

type WorkspaceState = {
    workspaceId: string;
    tabId: string;
    tabToken: string;
    createdAt: number;
};

export type WorkspaceManagerDeps = {
    pageRegistry: PageRegistry;
    log: (...args: unknown[]) => void;
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
};

const buildStep = (name: StepUnion['name'], args: StepUnion['args']): StepUnion => ({
    id: crypto.randomUUID(),
    name,
    args,
});

export const createWorkspaceManager = (deps: WorkspaceManagerDeps) => {
    let active: WorkspaceState | null = null;

    const ensureActiveWorkspace = async (): Promise<WorkspaceState> => {
        if (active) {
            return active;
        }
        const created = await deps.pageRegistry.createWorkspace();
        const tabToken = deps.pageRegistry.resolveTabToken({
            workspaceId: created.workspaceId,
            tabId: created.tabId,
        });
        active = {
            workspaceId: created.workspaceId,
            tabId: created.tabId,
            tabToken,
            createdAt: Date.now(),
        };
        return active;
    };

    const getActiveWorkspacePublicInfo = async (): Promise<WorkspacePublicInfo | null> => {
        if (!active) return null;
        const page = await deps.pageRegistry.resolvePage({
            workspaceId: active.workspaceId,
            tabId: active.tabId,
        });
        return {
            workspaceId: active.workspaceId,
            url: page.url(),
            title: await page.title(),
            createdAt: active.createdAt,
        };
    };

    const gotoInWorkspace = async (url: string) => {
        const workspace = await ensureActiveWorkspace();
        const step = buildStep('browser.goto', { url });
        return runSteps({
            workspaceId: workspace.workspaceId,
            steps: [step],
            options: { stopOnError: true },
        });
    };

    return { ensureActiveWorkspace, getActiveWorkspacePublicInfo, gotoInWorkspace };
};

export const createWorkspaceRecordingState = () => createRecordingState();

export const hookWorkspaceRegistry = (deps: {
    pageRegistry: PageRegistry;
    recordingState: RecordingState;
    navDedupeWindowMs: number;
}) => {
    const { recordingState, navDedupeWindowMs } = deps;
    return {
        onPageBound: (page: Page, token: string) => {
            if (recordingState.recordingEnabled.has(token)) {
                void ensureRecorder(recordingState, page, token, navDedupeWindowMs);
            }
        },
        onTokenClosed: (token: string) => cleanupRecording(recordingState, token),
    };
};
