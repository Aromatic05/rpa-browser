import type { Page } from 'playwright';
import type { ActionHandler } from '../execute';
import type {
    PageClosePopupCommand,
    PageExpectPopupCommand,
    PageHandleNextDialogCommand,
    PageOnDialogCommand,
} from '../commands';
import { ActionError } from '../execute';
import { ERROR_CODES } from '../error_codes';

type DialogState = {
    mode: 'accept' | 'dismiss';
    promptText?: string;
    once?: boolean;
};

const dialogHandlers = new WeakMap<Page, DialogState | null>();
const popupHistory = new WeakMap<Page, Page>();

const ensureDialogListener = (page: Page) => {
    if ((page as any).__rpa_dialog_listener) return;
    (page as any).__rpa_dialog_listener = true;
    page.on('dialog', async (dialog) => {
        const state = dialogHandlers.get(page);
        if (!state) {
            try {
                await dialog.dismiss();
            } catch {
                // ignore
            }
            return;
        }
        if (state.promptText) {
            if (state.mode === 'accept') {
                await dialog.accept(state.promptText);
            } else {
                await dialog.dismiss();
            }
        } else if (state.mode === 'accept') {
            await dialog.accept();
        } else {
            await dialog.dismiss();
        }
        if (state.once) {
            dialogHandlers.set(page, null);
        }
    });
};

export const dialogPopupHandlers: Record<string, ActionHandler> = {
    'page.onDialog': async (ctx, command) => {
        const args = (command as PageOnDialogCommand).args;
        ensureDialogListener(ctx.page);
        dialogHandlers.set(ctx.page, { mode: args.mode, promptText: args.promptText });
        return { ok: true, tabToken: ctx.tabToken, data: { mode: args.mode } };
    },
    'page.handleNextDialog': async (ctx, command) => {
        const args = (command as PageHandleNextDialogCommand).args;
        ensureDialogListener(ctx.page);
        dialogHandlers.set(ctx.page, { mode: args.mode, promptText: args.promptText, once: true });
        return { ok: true, tabToken: ctx.tabToken, data: { mode: args.mode } };
    },
    'page.expectPopup': async (ctx, command) => {
        const args = (command as PageExpectPopupCommand).args;
        if (!ctx.execute) {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'execute callback missing');
        }
        const popupPromise = ctx.page.waitForEvent('popup', { timeout: args.timeout || 5000 });
        const actionCmd = { ...args.action, tabToken: ctx.tabToken };
        const actionResult = await ctx.execute(actionCmd);
        if (!actionResult.ok) {
            return actionResult;
        }
        let popup: Page;
        try {
            popup = await popupPromise;
        } catch (error) {
            throw new ActionError(ERROR_CODES.ERR_POPUP_BLOCKED, 'popup not opened', {
                message: error instanceof Error ? error.message : String(error),
            });
        }
        popupHistory.set(ctx.page, popup);
        const boundToken = await ctx.pageRegistry.bindPage(popup);
        if (!boundToken) {
            throw new ActionError(ERROR_CODES.ERR_POPUP_BLOCKED, 'popup token missing');
        }
        return {
            ok: true,
            tabToken: ctx.tabToken,
            data: {
                popupTabToken: boundToken,
                popupUrl: popup.url(),
                openerTabToken: ctx.tabToken,
            },
        };
    },
    'page.closePopup': async (ctx, command) => {
        const args = (command as PageClosePopupCommand).args;
        if (args.popupTabToken) {
            const entry = ctx.pageRegistry
                .listPages()
                .find((item) => item.tabToken === args.popupTabToken);
            if (entry) {
                await entry.page.close({ runBeforeUnload: true });
            }
            return { ok: true, tabToken: ctx.tabToken, data: { closed: args.popupTabToken } };
        }
        const popup = popupHistory.get(ctx.page);
        if (popup && !popup.isClosed()) {
            await popup.close({ runBeforeUnload: true });
        }
        return { ok: true, tabToken: ctx.tabToken, data: { closed: true } };
    },
};
