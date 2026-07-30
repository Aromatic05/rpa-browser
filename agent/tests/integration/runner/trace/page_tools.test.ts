import test from 'node:test';
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {createPageTools} from '../../../../src/runner/trace/tools/page';
import type {ToolsBuildContext} from '../../../../src/runner/trace/tools/context';

const createTools = () => {
    const page = {
        evaluate: async (callback: (arg: unknown) => unknown, arg: unknown) => await callback(arg),
    } as unknown as Page;
    const base = {
        opts: {},
        ctx: {cache: {}, tags: {}},
        getCurrentPage: () => page,
        setCurrentPage: () => undefined,
        run: async (_operation: string, _args: unknown, operation: () => Promise<unknown>) => {
            try {
                return {ok: true, data: await operation()};
            } catch (error) {
                return {
                    ok: false,
                    error: {
                        code: 'ERR_INTERNAL',
                        message: error instanceof Error ? error.message : String(error),
                    },
                };
            }
        },
        ensureA11yCache: async () => undefined,
        resolveSelectorLocator: async () => {throw new Error('not used');},
    } as unknown as ToolsBuildContext;
    return createPageTools(base);
};

test('trace.page.evaluate invokes a function expression with arg', async () => {
    const result = await createTools()['trace.page.evaluate']({
        expression: '({needle}) => needle === "恢复后的页面"',
        arg: {needle: '恢复后的页面'},
    });

    assert.equal(result.ok, true);
    assert.equal(result.data, true);
});

test('trace.page.evaluate keeps statement-body expressions working', async () => {
    const result = await createTools()['trace.page.evaluate']({
        expression: 'return arg.left + arg.right;',
        arg: {left: 2, right: 3},
    });

    assert.equal(result.ok, true);
    assert.equal(result.data, 5);
});
