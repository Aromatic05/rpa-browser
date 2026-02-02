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
            } catch {
                // ignore navigation failures
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
            } catch {
                // ignore navigation failures
            }
        }
        return makeOk({ workspaceId, tabId, tabToken: createdTabToken });
    },
    'tab.close': async (ctx, action) => {
        const payload = (action.payload || {}) as TabClosePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceId);
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        await ctx.pageRegistry.closeTab(workspaceId, payload.tabId);
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
        return makeOk({ workspaceId, tabId: payload.tabId });
    },
};
