/**
 * workspace action（legacy）：提供 workspace/tab 的管理命令。
 *
 * 说明：
 * - runSteps 只关心 workspaceId 的路由，但 workspace 命令仍由旧协议触发
 * - 保留此文件用于 extension 的 workspace/tab UI 控制
 */

import type { ActionHandler } from '../execute';
import { errorResult } from '../results';
import { ERROR_CODES } from '../error_codes';
import type {
    TabCloseCommand,
    TabCreateCommand,
    TabListCommand,
    TabSetActiveCommand,
    WorkspaceCreateCommand,
    WorkspaceSetActiveCommand,
} from '../commands';

const resolveWorkspaceId = (
    ctx: { pageRegistry: any },
    command: { scope?: { workspaceId?: string } },
    argWorkspaceId?: string,
) => {
    if (argWorkspaceId) return argWorkspaceId;
    if (command.scope?.workspaceId) return command.scope.workspaceId;
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
    'workspace.list': async (ctx, _command) => {
        const list = ctx.pageRegistry.listWorkspaces();
        const active = ctx.pageRegistry.getActiveWorkspace?.();
        return {
            ok: true,
            tabToken: ctx.tabToken,
            data: { workspaces: list, activeWorkspaceId: active?.id || null },
        };
    },
    'workspace.create': async (ctx, _command) => {
        const command = _command as WorkspaceCreateCommand;
        const created = await ctx.pageRegistry.createWorkspace();
        const createdTabToken = ctx.pageRegistry.resolveTabToken({
            workspaceId: created.workspaceId,
            tabId: created.tabId,
        });
        const startUrl = command.args?.startUrl;
        if (startUrl) {
            try {
                const page = await ctx.pageRegistry.resolvePage({
                    workspaceId: created.workspaceId,
                    tabId: created.tabId,
                });
                await page.goto(startUrl, {
                    waitUntil: command.args?.waitUntil || 'domcontentloaded',
                });
                await page.bringToFront();
            } catch {
                // ignore navigation failures
            }
        }
        return {
            ok: true,
            tabToken: ctx.tabToken,
            data: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: createdTabToken },
        };
    },
    'workspace.setActive': async (ctx, command) => {
        const args = (command as WorkspaceSetActiveCommand).args;
        ctx.pageRegistry.setActiveWorkspace(args.workspaceId);
        await bringWorkspaceTabToFront(ctx, { workspaceId: args.workspaceId });
        return { ok: true, tabToken: ctx.tabToken, data: { workspaceId: args.workspaceId } };
    },
    'tab.list': async (ctx, command) => {
        const args = (command as TabListCommand).args;
        const workspaceId = resolveWorkspaceId(ctx, command as any, args.workspaceId);
        if (!workspaceId) {
            return errorResult(ctx.tabToken, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        const tabs = await ctx.pageRegistry.listTabs(workspaceId);
        return { ok: true, tabToken: ctx.tabToken, data: { workspaceId, tabs } };
    },
    'tab.create': async (ctx, command) => {
        const args = (command as TabCreateCommand).args;
        const workspaceId = resolveWorkspaceId(ctx, command as any, args.workspaceId);
        if (!workspaceId) {
            return errorResult(ctx.tabToken, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        const tabId = await ctx.pageRegistry.createTab(workspaceId);
        const createdTabToken = ctx.pageRegistry.resolveTabToken({ workspaceId, tabId });
        if (args.startUrl) {
            try {
                const page = await ctx.pageRegistry.resolvePage({ workspaceId, tabId });
                await page.goto(args.startUrl, { waitUntil: args.waitUntil || 'domcontentloaded' });
                await page.bringToFront();
            } catch {
                // ignore navigation failures
            }
        }
        return { ok: true, tabToken: ctx.tabToken, data: { workspaceId, tabId, tabToken: createdTabToken } };
    },
    'tab.close': async (ctx, command) => {
        const args = (command as TabCloseCommand).args;
        const workspaceId = resolveWorkspaceId(ctx, command as any, args.workspaceId);
        if (!workspaceId) {
            return errorResult(ctx.tabToken, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        await ctx.pageRegistry.closeTab(workspaceId, args.tabId);
        return { ok: true, tabToken: ctx.tabToken, data: { workspaceId, tabId: args.tabId } };
    },
    'tab.setActive': async (ctx, command) => {
        const args = (command as TabSetActiveCommand).args;
        const workspaceId = resolveWorkspaceId(ctx, command as any, args.workspaceId);
        if (!workspaceId) {
            return errorResult(ctx.tabToken, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        ctx.pageRegistry.setActiveTab(workspaceId, args.tabId);
        await bringWorkspaceTabToFront(ctx, { workspaceId, tabId: args.tabId });
        return { ok: true, tabToken: ctx.tabToken, data: { workspaceId, tabId: args.tabId } };
    },
};
