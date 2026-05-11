import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type { Step, StepResult } from '../../../src/runner/steps/types';
import { executeBrowserSelectOption, findTargetNode } from '../../../src/runner/steps/executors/select_option/index';
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

// ── target node resolution ──

test('select_option: resolve target node by #id selector', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'tn-id',
            name: 'browser.select_option',
            args: { selector: '#native-select', values: ['processing'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: resolve target node by data-testid selector via attrIndex', () => {
    const mockNode = { id: 'n1', role: 'combobox', children: [] };
    const snapshot = {
        root: mockNode,
        nodeIndex: { n1: mockNode },
        attrIndex: {
            n1: { id: 'combo1', 'data-testid': 'combo-test', tag: 'div' },
        },
        locatorIndex: {},
        bboxIndex: {},
        contentStore: {},
        controlIndex: {},
        entityIndex: { entities: {}, byNodeId: {} },
    } as any;

    const step: Step<'browser.select_option'> = {
        id: 'tn-testid',
        name: 'browser.select_option',
        args: { selector: '[data-testid="combo-test"]', values: ['x'] },
    };
    const node = findTargetNode(snapshot, step, step.args.selector!);
    assert.ok(node, 'target node should be found via data-testid');
    assert.equal(node!.id, 'n1');
});

test('select_option: resolve target node via locatorIndex direct.query', async () => {
    const { browser, deps, snapshot } = await setupBinding();
    try {
        const selectNodeId = findNodeIdByTagAndAttr(snapshot, 'select', 'id', 'native-select');
        assert.ok(selectNodeId);
        const locatorQuery = snapshot.locatorIndex[selectNodeId]?.direct?.query;
        assert.ok(locatorQuery, 'native-select must have locatorIndex direct.query');
        const step: Step<'browser.select_option'> = {
            id: 'tn-locator-query',
            name: 'browser.select_option',
            args: { selector: locatorQuery!, values: ['processing'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: unmappable selector returns ERR_NOT_FOUND', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'tn-unmappable',
            name: 'browser.select_option',
            args: { selector: '#nonexistent-element', values: ['anything'] },
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
            assert.equal(result.error?.code, 'ERR_NOT_FOUND');
        }
    } finally {
        await browser.close();
    }
});

test('select_option: native_select label already selected state unchanged returns ok', async () => {
    const { browser, deps, snapshot } = await setupBinding();
    try {
        const selectNodeId = findNodeIdByTagAndAttr(snapshot, 'select', 'id', 'native-select');
        assert.ok(selectNodeId);
        // '待审批' is the default selected option label (value='pending')
        const step: Step<'browser.select_option'> = {
            id: 'ns-label-unchanged',
            name: 'browser.select_option',
            args: { nodeId: selectNodeId!, values: ['待审批'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: native_select state unchanged neither value nor label match returns ERR_ASSERTION_FAILED', async () => {
    const { browser, deps, page, snapshot } = await setupBinding();
    try {
        const selectNodeId = findNodeIdByTagAndAttr(snapshot, 'select', 'id', 'native-select');
        assert.ok(selectNodeId);

        // Intercept change events to reset the selection back to the default,
        // so the selection state appears unchanged but the target matches
        // neither afterValues nor afterLabels.
        await page.evaluate(() => {
            const select = document.getElementById('native-select') as HTMLSelectElement;
            select.addEventListener('change', () => {
                select.value = 'pending';
            });
        });

        const step: Step<'browser.select_option'> = {
            id: 'ns-unchanged-nomatch',
            name: 'browser.select_option',
            args: { nodeId: selectNodeId!, values: ['processing'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_ASSERTION_FAILED');
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

test('select_option: radio_group already selected asserts group state without click', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'rg-already',
            name: 'browser.select_option',
            args: { selector: '#status-radio-group', values: ['pending'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: radio_group asserts no other radio checked after action', async () => {
    // Verify the executor source contains the defensive assertion that checks
    // non-target options are not selected. This guards against regressions
    // that would remove the group-wide state validation.
    const fs = await import('node:fs');
    const source = fs.readFileSync(
        new URL('../../../src/runner/steps/executors/select_option/choice_group.ts', import.meta.url).pathname,
        'utf8',
    );
    assert.equal(source.includes('other radio options should not be selected'), true);
    assert.equal(source.includes('if (checked)'), true);
    assert.equal(source.includes('opt.nodeId === targetOption.nodeId'), true);
    assert.equal(source.includes('continue'), true);
});

test('select_option: radio_group ambiguous match returns ERR_AMBIGUOUS', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'rg-ambiguous',
            name: 'browser.select_option',
            args: { selector: '#status-radio-group', values: ['待审批'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_AMBIGUOUS');
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

test('select_option: checkbox_group label-based matching uses matched nodeIds', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'cbg-label',
            name: 'browser.select_option',
            args: { selector: '#tag-checkbox-group', values: ['低优先级'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
    } finally {
        await browser.close();
    }
});

test('select_option: checkbox_group ambiguous match returns ERR_AMBIGUOUS', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'cbg-ambiguous',
            name: 'browser.select_option',
            args: { selector: '#tag-checkbox-group', values: ['紧急'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_AMBIGUOUS');
        }
    } finally {
        await browser.close();
    }
});

test('select_option: checkbox_group extra checked not cleaned returns ERR_ASSERTION_FAILED', async () => {
    const { browser, deps, page } = await setupBinding();
    try {
        // Block unchecking by intercepting clicks on checked checkboxes
        await page.evaluate(() => {
            document.querySelectorAll('#tag-checkbox-group input[type="checkbox"]').forEach((cb) => {
                cb.addEventListener('click', (e) => {
                    if ((e.target as HTMLInputElement).checked) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                    }
                });
            });
        });

        // Check all checkboxes to create extra checked state
        await page.evaluate(() => {
            document.querySelectorAll('#tag-checkbox-group input[type="checkbox"]').forEach((cb) => {
                (cb as HTMLInputElement).checked = true;
            });
        });

        // Try to select only 'urgent' - unchecking others will be blocked
        const step: Step<'browser.select_option'> = {
            id: 'cbg-extra',
            name: 'browser.select_option',
            args: { selector: '#tag-checkbox-group', values: ['urgent'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_ASSERTION_FAILED');
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

// ── custom_select source guards ──

test('select_option: custom_select does not use has-text fallback', () => {
    const source = readFileSync(
        path.resolve(process.cwd(), 'src/runner/steps/executors/select_option/custom_select.ts'),
        'utf8',
    );
    assert.equal(source.includes('has-text'), false, 'custom_select must not contain has-text');
    assert.equal(source.includes('getByText'), false, 'custom_select must not contain getByText');
});

test('select_option: custom_select does not use aria-selected early return', () => {
    const source = readFileSync(
        path.resolve(process.cwd(), 'src/runner/steps/executors/select_option/custom_select.ts'),
        'utf8',
    );
    assert.equal(
        source.includes("getAttribute('aria-selected')"),
        false,
        'custom_select must not read aria-selected as early success signal',
    );
});

test('select_option: custom_select popupNodeId missing returns ERR_NOT_FOUND', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'cs-nopopup',
            name: 'browser.select_option',
            args: { selector: '#broken-trigger', values: ['anything'] },
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

test('select_option: custom_select aria-selected set but component state unchanged returns ERR_ASSERTION_FAILED', async () => {
    const { browser, deps, page } = await setupBinding();
    try {
        // On option click, set aria-selected on a DIFFERENT option than the one
        // being clicked. The stale handler still does not update the model. The
        // post-action component will show the wrong option as selected, so the
        // target value won't match selectedValues/selectedLabels.
        await page.evaluate(() => {
            const popup = document.getElementById('stale-popup');
            if (popup) {
                popup.addEventListener('click', (e) => {
                    const clicked = (e.target as Element).closest('[role="option"]');
                    if (!clicked) return;
                    const allOpts = popup.querySelectorAll('[role="option"]');
                    allOpts.forEach((opt) => {
                        if (opt !== clicked) {
                            opt.setAttribute('aria-selected', 'true');
                        }
                    });
                });
            }
        });

        const step: Step<'browser.select_option'> = {
            id: 'cs-ariaselected-stale',
            name: 'browser.select_option',
            args: { selector: '#stale-trigger', values: ['稳定值'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_ASSERTION_FAILED');
        }
    } finally {
        await browser.close();
    }
});

test('select_option: custom_select post-action control missing returns ERR_ASSERTION_FAILED', async () => {
    const { browser, deps, page } = await setupBinding();
    try {
        // Remove the trigger element after the popup option is clicked, so the
        // post-action snapshot cannot register the control.
        await page.evaluate(() => {
            const popup = document.getElementById('combobox-popup');
            if (popup) {
                popup.addEventListener('click', () => {
                    const trigger = document.getElementById('combobox-trigger');
                    if (trigger) trigger.remove();
                });
            }
        });

        const step: Step<'browser.select_option'> = {
            id: 'cs-postaction-missing',
            name: 'browser.select_option',
            args: { selector: '#combobox-trigger', values: ['审批中'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_ASSERTION_FAILED');
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
                selector: '#button-chip',
                values: ['anything'],
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

test('select_option: select_option only accepts canonical args', async () => {
    const { browser, deps } = await setupBinding();
    try {
        const step: Step<'browser.select_option'> = {
            id: 'canonical',
            name: 'browser.select_option',
            args: {
                selector: '#native-select',
                values: ['processing'],
            },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
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
            args: { selector: '#stale-trigger', values: ['稳定值'] },
        };
        const result = await executeBrowserSelectOption(step, deps, 'ws1');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error?.code, 'ERR_ASSERTION_FAILED');
        }
    } finally {
        await browser.close();
    }
});
