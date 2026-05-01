import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type { Step } from '../../../src/runner/steps/types';
import { executeBrowserSelectOption } from '../../../src/runner/steps/executors/select_option';
import { createTraceTools } from '../../../src/runner/trace/tools';
import { getRunnerConfig } from '../../../src/config';
import { RunnerPluginHost } from '../../../src/runner/hotreload/plugin_host';

const fixtureUrl = () => {
    const filePath = path.resolve(process.cwd(), 'tests/fixtures/trace_select_option_fixture.html');
    return pathToFileURL(filePath).toString();
};

const runSelectStep = async <T = undefined>(step: Step<'browser.select_option'>, inspect?: (page: any) => Promise<T>) => {
    const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const { tools, ctx } = createTraceTools({ page, context });
        const goto = await tools['trace.page.goto']({ url: fixtureUrl() });
        assert.equal(goto.ok, true);
        const binding = {
            workspaceName: 'ws1',
            tabName: 'tab1',
            tabName: 'token1',
            page,
            traceTools: tools,
            traceCtx: ctx,
        };
        const deps = {
            runtime: {
                ensureActivePage: async () => binding,
            },
            config: getRunnerConfig(),
            pluginHost: new RunnerPluginHost(path.resolve(process.cwd(), 'src/runner/plugin_entry.ts')),
        } as any;
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        const inspected = inspect ? await inspect(page) : (undefined as T);
        return { result, inspected };
    } finally {
        await browser.close();
    }
};

test('select_option: native <select> supports value and label', async () => {
    const byValueStep: Step<'browser.select_option'> = {
        id: 'native-value',
        name: 'browser.select_option',
        args: { selector: '#native-select', values: ['processing'] },
    };
    const byValue = await runSelectStep(byValueStep);
    assert.equal(byValue.result.ok, true);

    const byLabelStep: Step<'browser.select_option'> = {
        id: 'native-label',
        name: 'browser.select_option',
        args: { selector: '#native-select', values: ['已完成'] },
    };
    const byLabel = await runSelectStep(byLabelStep);
    assert.equal(byLabel.result.ok, true);
});

test('select_option: custom combobox supports popup select and state change', async () => {
    const step: Step<'browser.select_option'> = {
        id: 'custom-combobox',
        name: 'browser.select_option',
        args: { selector: '#combobox-trigger', values: ['审批中'] },
    };
    const { result } = await runSelectStep(step);
    assert.equal(result.ok, true);
});

test('select_option: button + listbox should not false-hit hidden native select', async () => {
    const step: Step<'browser.select_option'> = {
        id: 'button-listbox',
        name: 'browser.select_option',
        args: { selector: '#button-trigger', values: ['办公用品'] },
    };
    const { result, inspected } = await runSelectStep(step, async (page) => page.locator('#hidden-native-mirror').inputValue());
    assert.equal(result.ok, true);
    assert.equal(inspected, 'travel');
});

test('select_option: explicit errors for option-not-found, popup-not-found, state-not-changed', async () => {
    const optionMissingStep: Step<'browser.select_option'> = {
        id: 'option-missing',
        name: 'browser.select_option',
        args: { selector: '#combobox-trigger', values: ['不存在选项'] },
    };
    const optionMissing = await runSelectStep(optionMissingStep);
    assert.equal(optionMissing.result.ok, false);
    if (!optionMissing.result.ok) {
        assert.equal(optionMissing.result.error?.code, 'ERR_NOT_FOUND');
        assert.match(optionMissing.result.error?.message || '', /option not found/i);
    }

    const popupMissingStep: Step<'browser.select_option'> = {
        id: 'popup-missing',
        name: 'browser.select_option',
        args: { selector: '#broken-trigger', values: ['任意值'] },
    };
    const popupMissing = await runSelectStep(popupMissingStep);
    assert.equal(popupMissing.result.ok, false);
    if (!popupMissing.result.ok) {
        assert.equal(popupMissing.result.error?.code, 'ERR_NOT_FOUND');
        assert.match(popupMissing.result.error?.message || '', /popup not found/i);
    }

    const noChangeStep: Step<'browser.select_option'> = {
        id: 'state-no-change',
        name: 'browser.select_option',
        args: { selector: '#stale-trigger', values: ['稳定值'] },
    };
    const noChange = await runSelectStep(noChangeStep);
    assert.equal(noChange.result.ok, false);
    if (!noChange.result.ok) {
        assert.equal(noChange.result.error?.code, 'ERR_ASSERTION_FAILED');
        assert.match(noChange.result.error?.message || '', /state not changed after selection/i);
    }
});
