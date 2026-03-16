/**
 * workspace action：提供 workspace/tab 的管理命令。
 */

import type { Action, ActionScope } from './action_protocol';
import { makeErr, makeOk } from './action_protocol';
import type { ActionHandler } from './execute';
import { ERROR_CODES } from './error_codes';

type WorkspaceCreatePayload = { startUrl?: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' };
type WorkspaceSetActivePayload = { workspaceId: string };
type TabListPayload = { workspaceId?: string };
type TabCreatePayload = { workspaceId?: string; startUrl?: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' };
type TabClosePayload = { workspaceId?: string; tabId: string };
type TabSetActivePayload = { workspaceId?: string; tabId: string };
type TabOpenedPayload = { source?: string; url?: string; title?: string; at?: number };
type TabActivatedPayload = { source?: string; url?: string; at?: number };
type TabClosedPayload = { source?: string; at?: number };
type TabPingPayload = { source?: string; url?: string; title?: string; at?: number };

const logPageEvent = (event: string, payload: Record<string, unknown>) => {
    // Lifecycle logs must always be visible in terminal for debugging/state tracking.
    console.log('[page]', event, payload);
};

const resolveWorkspaceId = (
    ctx: { pageRegistry: any },
    action: { scope?: ActionScope },
    argWorkspaceId?: string,
) => {
    if (argWorkspaceId) return argWorkspaceId;
    if (action.scope?.workspaceId) return action.scope.workspaceId;
    const active = ctx.pageRegistry.getActiveWorkspace?.();
    return active?.id || null;
};

const bringWorkspaceTabToFront = async (
    ctx: { pageRegistry: any },
    scope: { workspaceId: string; tabId?: string },
) => {
    try {
        const page = await ctx.pageRegistry.resolvePage(scope);
        await page.bringToFront();
    } catch {
        // ignore tab focus failures
    }
};

export const workspaceHandlers: Record<string, ActionHandler> = {
    'workspace.list': async (ctx, _action) => {
        const list = ctx.pageRegistry.listWorkspaces();
        const active = ctx.pageRegistry.getActiveWorkspace?.();
        return makeOk({ workspaces: list, activeWorkspaceId: active?.id || null });
    },
    'workspace.create': async (ctx, action) => {
        const payload = (action.payload || {}) as WorkspaceCreatePayload;
        const created = await ctx.pageRegistry.createWorkspace();
        const createdTabToken = ctx.pageRegistry.resolveTabToken({
            workspaceId: created.workspaceId,
            tabId: created.tabId,
        });
        const startUrl = payload.startUrl;
        if (startUrl) {
            try {
                const page = await ctx.pageRegistry.resolvePage({
                    workspaceId: created.workspaceId,
                    tabId: created.tabId,
                });
                await page.goto(startUrl, {
                    waitUntil: payload.waitUntil || 'domcontentloaded',
                });
                await page.bringToFront();
            } catch (error) {
                return makeErr(
                    ERROR_CODES.ERR_ASSERTION_FAILED,
                    'workspace.create startUrl navigation failed',
                    {
                        workspaceId: created.workspaceId,
                        tabId: created.tabId,
                        startUrl,
                        message: error instanceof Error ? error.message : String(error),
                    },
                );
            }
        }
        return makeOk({ workspaceId: created.workspaceId, tabId: created.tabId, tabToken: createdTabToken });
    },
    'workspace.setActive': async (ctx, action) => {
        const payload = (action.payload || {}) as WorkspaceSetActivePayload;
        ctx.pageRegistry.setActiveWorkspace(payload.workspaceId);
        await bringWorkspaceTabToFront(ctx, { workspaceId: payload.workspaceId });
        return makeOk({ workspaceId: payload.workspaceId });
    },
    'tab.list': async (ctx, action) => {
        const payload = (action.payload || {}) as TabListPayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceId);
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        const tabs = await ctx.pageRegistry.listTabs(workspaceId);
        return makeOk({ workspaceId, tabs });
    },
    'tab.create': async (ctx, action) => {
        const payload = (action.payload || {}) as TabCreatePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceId);
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        const tabId = await ctx.pageRegistry.createTab(workspaceId);
        const createdTabToken = ctx.pageRegistry.resolveTabToken({ workspaceId, tabId });
        if (payload.startUrl) {
            try {
                const page = await ctx.pageRegistry.resolvePage({ workspaceId, tabId });
                await page.goto(payload.startUrl, { waitUntil: payload.waitUntil || 'domcontentloaded' });
                await page.bringToFront();
            } catch (error) {
                return makeErr(
                    ERROR_CODES.ERR_ASSERTION_FAILED,
                    'tab.create startUrl navigation failed',
                    {
                        workspaceId,
                        tabId,
                        tabToken: createdTabToken,
                        startUrl: payload.startUrl,
                        message: error instanceof Error ? error.message : String(error),
                    },
                );
            }
        }
        logPageEvent('tab.create', { workspaceId, tabId, tabToken: createdTabToken, startUrl: payload.startUrl });
        return makeOk({ workspaceId, tabId, tabToken: createdTabToken });
    },
    'tab.close': async (ctx, action) => {
        const payload = (action.payload || {}) as TabClosePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceId);
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        await ctx.pageRegistry.closeTab(workspaceId, payload.tabId);
        logPageEvent('tab.close', { workspaceId, tabId: payload.tabId });
        return makeOk({ workspaceId, tabId: payload.tabId });
    },
    'tab.setActive': async (ctx, action) => {
        const payload = (action.payload || {}) as TabSetActivePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceId);
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        ctx.pageRegistry.setActiveTab(workspaceId, payload.tabId);
        await bringWorkspaceTabToFront(ctx, { workspaceId, tabId: payload.tabId });
        logPageEvent('tab.setActive', { workspaceId, tabId: payload.tabId });
        return makeOk({ workspaceId, tabId: payload.tabId });
    },
    'tab.opened': async (ctx, action) => {
        const payload = (action.payload || {}) as TabOpenedPayload;
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        ctx.pageRegistry.setActiveWorkspace(scope.workspaceId);
        ctx.pageRegistry.setActiveTab(scope.workspaceId, scope.tabId);
        ctx.log('tab.opened', {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        });
        logPageEvent('tab.opened', {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        });
        return makeOk({
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        });
    },
    'tab.activated': async (ctx, action) => {
        const payload = (action.payload || {}) as TabActivatedPayload;
        const isReplayRunning = (ctx.recordingState?.replaying?.size || 0) > 0;
        const isExtensionLifecycle = typeof payload.source === 'string' && payload.source.startsWith('extension.');
        if (isReplayRunning && isExtensionLifecycle) {
            logPageEvent('tab.activated.ignored', {
                tabToken: ctx.tabToken,
                source: payload.source,
                reportedUrl: payload.url,
                reportedAt: payload.at,
                reason: 'replay_in_progress',
            });
            return makeOk({
                tabToken: ctx.tabToken,
                source: payload.source,
                reportedUrl: payload.url,
                reportedAt: payload.at,
                ignored: true,
                reason: 'replay_in_progress',
            });
        }
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        ctx.pageRegistry.setActiveWorkspace(scope.workspaceId);
        ctx.pageRegistry.setActiveTab(scope.workspaceId, scope.tabId);
        ctx.log('tab.activated', {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedAt: payload.at,
        });
        logPageEvent('tab.activated', {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedAt: payload.at,
        });
        return makeOk({
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedAt: payload.at,
        });
    },
    'tab.closed': async (ctx, action) => {
        const payload = (action.payload || {}) as TabClosedPayload;
        try {
            const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
            ctx.log('tab.closed', {
                workspaceId: scope.workspaceId,
                tabId: scope.tabId,
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
            });
            logPageEvent('tab.closed', {
                workspaceId: scope.workspaceId,
                tabId: scope.tabId,
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
            });
            return makeOk({
                workspaceId: scope.workspaceId,
                tabId: scope.tabId,
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
            });
        } catch {
            ctx.log('tab.closed', {
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
            logPageEvent('tab.closed', {
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
            return makeOk({
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
        }
    },
    'tab.ping': async (ctx, action) => {
        const payload = (action.payload || {}) as TabPingPayload;
        const touched = ctx.pageRegistry.touchTabToken?.(ctx.tabToken, payload.at);
        if (!touched) {
            logPageEvent('tab.ping', {
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
            return makeOk({
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
        }
        const output = {
            workspaceId: touched.workspaceId,
            tabId: touched.tabId,
            tabToken: ctx.tabToken,
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        };
        ctx.log('tab.ping', output);
        logPageEvent('tab.ping', output);
        return makeOk(output);
    },
};
