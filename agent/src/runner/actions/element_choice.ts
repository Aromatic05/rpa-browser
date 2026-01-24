import type { ActionHandler } from '../execute';
import type {
    ElementCheckCommand,
    ElementSelectOptionCommand,
    ElementSelectRadioCommand,
    ElementSetCheckedCommand,
    ElementUncheckCommand,
} from '../commands';
import { resolveTarget } from '../../runtime/target_resolver';
import { ActionError } from '../execute';
import { ERROR_CODES } from '../error_codes';

export const elementChoiceHandlers: Record<string, ActionHandler> = {
    'element.check': async (ctx, command) => {
        const args = (command as ElementCheckCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        await locator.setChecked(true, args.options || {});
        return { ok: true, tabToken: ctx.tabToken, data: { checked: true } };
    },
    'element.uncheck': async (ctx, command) => {
        const args = (command as ElementUncheckCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        await locator.setChecked(false, args.options || {});
        return { ok: true, tabToken: ctx.tabToken, data: { checked: false } };
    },
    'element.setChecked': async (ctx, command) => {
        const args = (command as ElementSetCheckedCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        await locator.setChecked(args.checked, args.options || {});
        return { ok: true, tabToken: ctx.tabToken, data: { checked: args.checked } };
    },
    'element.selectRadio': async (ctx, command) => {
        const args = (command as ElementSelectRadioCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        await locator.check(args.options || {});
        return { ok: true, tabToken: ctx.tabToken, data: { checked: true } };
    },
    'element.selectOption': async (ctx, command) => {
        const args = (command as ElementSelectOptionCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        const count = await locator.count();
        if (count === 0) {
            throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, 'select target not found');
        }
        if (
            typeof args.value === 'undefined' &&
            typeof args.label === 'undefined' &&
            typeof args.index === 'undefined'
        ) {
            throw new ActionError(
                ERROR_CODES.ERR_BAD_ARGS,
                'selectOption requires value/label/index',
            );
        }
        const options = { timeout: 5000, ...(args.options || {}) } as any;
        const selected = await locator.selectOption(
            {
                value: args.value,
                label: args.label,
                index: args.index,
            },
            options,
        );
        if (!selected?.length) {
            throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, 'option not found');
        }
        return { ok: true, tabToken: ctx.tabToken, data: { selected } };
    },
};
