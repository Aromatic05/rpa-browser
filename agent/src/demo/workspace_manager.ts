import crypto from 'crypto';
import type { Page } from 'playwright';
import type { PageRegistry } from '../runtime/page_registry';
import { createRecordingState, cleanupRecording, ensureRecorder } from '../record/recording';
import { executeCommand, type ActionContext } from '../runner/execute';
import type { Command, PageGotoCommand } from '../runner/commands';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';

export type WorkspacePublicInfo = {
    workspaceId: string;
    url: string;
    title: string;
    createdAt: number;
};

type WorkspaceState = {
    workspaceId: string;
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

const randomId = () => crypto.randomBytes(12).toString('hex');

const buildActionContext = async (
    deps: WorkspaceManagerDeps,
    tabToken: string,
): Promise<ActionContext> => {
    const page = await deps.pageRegistry.getPage(tabToken);
    const ctx: ActionContext = {
        page,
        tabToken,
        pageRegistry: deps.pageRegistry,
        log: deps.log,
        recordingState: deps.recordingState,
        replayOptions: deps.replayOptions,
        navDedupeWindowMs: deps.navDedupeWindowMs,
        execute: undefined,
    };
    ctx.execute = (cmd: Command) => executeCommand(ctx, cmd);
    return ctx;
};

export const createWorkspaceManager = (deps: WorkspaceManagerDeps) => {
    let active: WorkspaceState | null = null;

    const ensureActiveWorkspace = async (): Promise<WorkspaceState> => {
        if (active) {
            return active;
        }
        const workspaceId = randomId();
        const tabToken = randomId();
        await deps.pageRegistry.getPage(tabToken);
        active = { workspaceId, tabToken, createdAt: Date.now() };
        return active;
    };

    const getActiveWorkspacePublicInfo = async (): Promise<WorkspacePublicInfo | null> => {
        if (!active) return null;
        const page = await deps.pageRegistry.getPage(active.tabToken);
        return {
            workspaceId: active.workspaceId,
            url: page.url(),
            title: await page.title(),
            createdAt: active.createdAt,
        };
    };

    const gotoInWorkspace = async (url: string) => {
        const workspace = await ensureActiveWorkspace();
        const ctx = await buildActionContext(deps, workspace.tabToken);
        const command: PageGotoCommand = {
            cmd: 'page.goto',
            tabToken: workspace.tabToken,
            args: { url, waitUntil: 'domcontentloaded' },
        };
        return executeCommand(ctx, command);
    };

    return { ensureActiveWorkspace, getActiveWorkspacePublicInfo, gotoInWorkspace };
};

export const createWorkspaceRecordingState = () => createRecordingState();

export const hookWorkspaceRegistry = (deps: {
    pageRegistry: PageRegistry;
    recordingState: RecordingState;
    navDedupeWindowMs: number;
}) => {
    const { pageRegistry, recordingState, navDedupeWindowMs } = deps;
    return {
        onPageBound: (page: Page, token: string) => {
            if (recordingState.recordingEnabled.has(token)) {
                void ensureRecorder(recordingState, page, token, navDedupeWindowMs);
            }
        },
        onTokenClosed: (token: string) => cleanupRecording(recordingState, token),
    };
};
