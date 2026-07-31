import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const executorModulePath = '../../../src/runner/steps/executors/select_option/index.ts';

test('runner select_option adapter executes only through Snapshot V2 control action', async () => {
    const { executeBrowserSelectOption } = await import(executorModulePath) as {
        executeBrowserSelectOption: (step: unknown, deps: unknown, workspaceName: string) => Promise<{
            ok: boolean;
            data?: Record<string, unknown>;
            error?: { code: string };
        }>;
    };
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<select id="target"><option value="A">A</option><option value="B">B</option></select>');
        const tab = { name: 'tab', page };
        const workspace = {
            tabs: {
                getActiveTab: () => tab,
                listTabs: () => [tab],
                setActiveTab: () => undefined,
            },
            browserSession: {
                start: async () => undefined,
                pageRegistry: {},
            },
        };
        const deps = {
            resolveWorkspace: () => workspace,
            runtime: {
                awaitExecutableTab: async () => ({}),
                resolveBinding: async () => ({ page }),
            },
            config: {
                waitPolicy: {
                    pageReadyTimeoutMs: 1000,
                    visibleTimeoutMs: 1000,
                },
            },
        };
        const result = await executeBrowserSelectOption({
            id: 'select-1',
            name: 'browser.select_option',
            args: { selector: '#target', kind: 'native_select', values: ['B'] },
        }, deps, 'workspace');
        assert.equal(result.ok, true);
        assert.equal(await page.locator('#target').inputValue(), 'B');
        assert.equal(typeof result.data?.controlRef, 'string');
    } finally {
        await browser.close();
    }
});
