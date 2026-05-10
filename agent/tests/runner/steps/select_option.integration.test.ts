import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type { Step, StepResult } from '../../../src/runner/steps/types';
import { executeBrowserSelectOption } from '../../../src/runner/steps/executors/select_option/index';
import { createTraceTools } from '../../../src/runner/trace/tools';
import { getRunnerConfig } from '../../../src/config';
import { RunnerPluginHost } from '../../../src/runner/hotreload/plugin_host';
import { generateSemanticSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/snapshot';

const fixtureUrl = () => {
    const filePath = path.resolve(process.cwd(), 'tests/fixtures/trace_select_option_fixture.html');
    return pathToFileURL(filePath).toString();
};

const setupBinding = async () => {
    const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const { tools, ctx } = createTraceTools({ page, context });
    const gotoResult = await tools['trace.page.goto']({ url: fixtureUrl() });
    assert.equal(gotoResult.ok, true);

    // Generate snapshot with controlIndex
    const snapshot = await generateSemanticSnapshot(page);
    ctx.cache.latestSnapshot = snapshot;

    const binding = {
        workspaceName: 'ws1',
        tabName: 'tab1',
        page,
        traceTools: tools,
        traceCtx: ctx,
    };

    const deps = {
        runtime: {
            resolveBinding: async () => binding,
        },
        config: getRunnerConfig(),
        pluginHost: new RunnerPluginHost(path.resolve(process.cwd(), 'src/runner/plugin_entry.ts')),
    } as any;

    return { browser, page, binding, deps, snapshot };
};

const findNodeIdByAttr = (snapshot: any, key: string, value: string): string | undefined => {
    for (const [nodeId, attrs] of Object.entries(snapshot.attrIndex) as [string, any][]) {
        if (attrs[key] === value) {return nodeId;}
    }
    return undefined;
};

const findNodeIdByTagAndAttr = (snapshot: any, tag: string, key: string, value: string): string | undefined => {
    for (const [nodeId, attrs] of Object.entries(snapshot.attrIndex) as [string, any][]) {
        if (attrs.tag === tag && attrs[key] === value) {return nodeId;}
    }
    return undefined;
};

// ── native_select ──

test('select_option: native_select value match', async () => {
    const { browser, deps, snapshot } = await setupBinding();
    try {
        const selectNodeId = findNodeIdByTagAndAttr(snapshot, 'select', 'id', 'native-select');
        assert.ok(selectNodeId, 'native-select node must exist');
        const step: Step<'browser.select_option'> = {
            id: 'ns-value',
            name: 'browser.select_option',
            args: { nodeId: selectNodeId!, values: ['processing'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: native_select label match', async () => {
    const { browser, deps, snapshot } = await setupBinding();
    try {
        const selectNodeId = findNodeIdByTagAndAttr(snapshot, 'select', 'id', 'native-select');
        assert.ok(selectNodeId);
        const step: Step<'browser.select_option'> = {
            id: 'ns-label',
            name: 'browser.select_option',
            args: { nodeId: selectNodeId!, values: ['已完成'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: native_select empty values returns ERR_BAD_ARGS', async () => {
    const { browser, deps, snapshot } = await setupBinding();
    try {
        const selectNodeId = findNodeIdByTagAndAttr(snapshot, 'select', 'id', 'native-select');
        assert.ok(selectNodeId);
        const step: Step<'browser.select_option'> = {
            id: 'ns-empty',
            name: 'browser.select_option',
            args: { nodeId: selectNodeId!, values: [] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_BAD_ARGS');
        }
    } finally {
        await browser.close();
    }
});

test('select_option: native_select option not found returns error', async () => {
    const { browser, deps, snapshot } = await setupBinding();
    try {
        const selectNodeId = findNodeIdByTagAndAttr(snapshot, 'select', 'id', 'native-select');
        assert.ok(selectNodeId);
        const step: Step<'browser.select_option'> = {
            id: 'ns-notfound',
            name: 'browser.select_option',
            args: { nodeId: selectNodeId!, values: ['nonexistent'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.ok(
                result.error?.code === 'ERR_NOT_FOUND'
                    || result.error?.code === 'ERR_ASSERTION_FAILED'
                    || result.error?.code === 'ERR_TIMEOUT',
                `unexpected error code: ${result.error?.code}`,
            );
        }
    } finally {
        await browser.close();
    }
});

// ── radio_group ──

test('select_option: radio_group single value select success', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'rg-select',
            name: 'browser.select_option',
            args: { selector: '#status-radio-group', values: ['processing'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: radio_group multiple values returns ERR_BAD_ARGS', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'rg-multi',
            name: 'browser.select_option',
            args: { selector: '#status-radio-group', values: ['processing', 'done'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_BAD_ARGS');
        }
    } finally {
        await browser.close();
    }
});

test('select_option: radio_group option not found returns ERR_NOT_FOUND', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'rg-notfound',
            name: 'browser.select_option',
            args: { selector: '#status-radio-group', values: ['nonexistent'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_NOT_FOUND');
        }
    } finally {
        await browser.close();
    }
});

// ── checkbox_group ──

test('select_option: checkbox_group check missing items', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'cbg-check',
            name: 'browser.select_option',
            args: { selector: '#tag-checkbox-group', values: ['normal', 'urgent', 'important'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: checkbox_group uncheck extra items', async () => {
    const { browser, deps } = await setupBinding();
    try {
        // 'normal' is checked by default, we want only 'urgent'
        const step: Step<'browser.select_option'> = {
            id: 'cbg-uncheck',
            name: 'browser.select_option',
            args: { selector: '#tag-checkbox-group', values: ['urgent'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: checkbox_group order-independent equivalence', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'cbg-order',
            name: 'browser.select_option',
            args: { selector: '#tag-checkbox-group', values: ['low', 'urgent', 'important'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: checkbox_group option not found returns ERR_NOT_FOUND', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'cbg-notfound',
            name: 'browser.select_option',
            args: { selector: '#tag-checkbox-group', values: ['nonexistent'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_NOT_FOUND');
        }
    } finally {
        await browser.close();
    }
});

// ── custom_select ──

test('select_option: custom_select via trigger/popup/option from component', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'cs-select',
            name: 'browser.select_option',
            args: { selector: '#combobox-trigger', values: ['审批中'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: custom_select multiple values returns ERR_BAD_ARGS', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'cs-multi',
            name: 'browser.select_option',
            args: { selector: '#combobox-trigger', values: ['processing', 'done'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_BAD_ARGS');
        }
    } finally {
        await browser.close();
    }
});

test('select_option: custom_select option not found returns ERR_NOT_FOUND', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'cs-notfound',
            name: 'browser.select_option',
            args: { selector: '#combobox-trigger', values: ['nonexistent'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_NOT_FOUND');
        }
    } finally {
        await browser.close();
    }
});

// ── control resolution ──

test('select_option: controlRef not found returns ERR_NOT_FOUND', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'cr-notfound',
            name: 'browser.select_option',
            args: {
                selector: '#native-select',
                controlRef: 'control:nonexistent:fake',
                values: ['processing'],
            },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_NOT_FOUND');
        }
    } finally {
        await browser.close();
    }
});

test('select_option: unsupported kind returns ERR_BAD_ARGS', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'bad-kind',
            name: 'browser.select_option',
            args: {
                selector: '#native-select',
                kind: 'date_picker',
                values: ['anything'],
            },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_BAD_ARGS');
        }
    } finally {
        await browser.close();
    }
});

// ── stale trigger: state unchanged assertion ──

test('select_option: stale state unchanged returns error', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'stale',
            name: 'browser.select_option',
            args: { selector: '#stale-trigger', values: ['stable'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.ok(
                result.error?.code === 'ERR_ASSERTION_FAILED'
                    || result.error?.code === 'ERR_NOT_FOUND',
                `unexpected error code: ${result.error?.code}`,
            );
        }
    } finally {
        await browser.close();
    }
});
