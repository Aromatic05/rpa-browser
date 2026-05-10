import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateStepFileForSerialization, validateStepResolveFileForSerialization } from '../../../src/runner/serialization/types';
import type { Step } from '../../../src/runner/steps/types';

const repoRoot = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const stepTypesSource = read('src/runner/steps/types.ts');
const resolveTargetSource = read('src/runner/steps/helpers/resolve_target.ts');
const serializationSource = read('src/runner/serialization/types.ts');
const runStepsTypesSource = read('src/runner/run_steps_types.ts');
const runStepsSource = read('src/runner/run_steps.ts');
const captureResolveExecutorSource = read('src/runner/steps/executors/capture_resolve.ts');
const checkpointRuntimeSource = read('src/runner/checkpoint/runtime.ts');

const readStepArgsBlock = (stepName: string): string => {
    const start = stepTypesSource.indexOf(`'${stepName}':`);
    assert.notEqual(start, -1, `missing step args block for ${stepName}`);
    const nextStart = stepTypesSource.indexOf(`\n    'browser.`, start + 1);
    return stepTypesSource.slice(start, nextStart === -1 ? undefined : nextStart);
};

test('step model source keeps normalized action target shape', () => {
    assert.equal(stepTypesSource.includes('export type Target'), false);
    assert.equal(stepTypesSource.includes('target?: Target'), false);
    assert.equal(stepTypesSource.includes('@deprecated'), false);
    assert.equal(stepTypesSource.includes('StepHintFile'), false);

    const actionSteps = [
        'browser.take_screenshot',
        'browser.click',
        'browser.fill',
        'browser.type',
        'browser.select_option',
        'browser.hover',
        'browser.scroll',
        'browser.press_key',
    ];

    for (const stepName of actionSteps) {
        const block = readStepArgsBlock(stepName);
        assert.equal(block.includes('id?: string'), false, `${stepName} should not expose args.id`);
        assert.equal(block.includes('target?:'), false, `${stepName} should not expose args.target`);
        assert.equal(block.includes('nodeId?: string;'), true, `${stepName} should expose nodeId`);
        assert.equal(block.includes('selector?: string;'), true, `${stepName} should expose selector`);
        assert.equal(block.includes('resolveId?: string;'), true, `${stepName} should expose resolveId`);
    }

    const dragAndDropBlock = readStepArgsBlock('browser.drag_and_drop');
    for (const field of [
        'sourceNodeId?: string;',
        'sourceSelector?: string;',
        'destNodeId?: string;',
        'destSelector?: string;',
        'destCoord?: { x: number; y: number };',
    ]) {
        assert.equal(dragAndDropBlock.includes(field), true, `drag_and_drop should expose ${field}`);
    }
});

test('resolve target source and serialization source keep resolve sidecar boundary', () => {
    assert.equal(resolveTargetSource.includes(`source: 'nodeId' | 'selector' | 'resolve'`), true);
    assert.equal(resolveTargetSource.includes(`source: 'selector' | 'id' | 'hint'`), false);
    assert.equal(resolveTargetSource.includes(`source: 'id'`), false);
    assert.equal(resolveTargetSource.includes(`source: 'hint'`), false);

    assert.equal(serializationSource.includes('StepResolveFile'), true);
    assert.equal(serializationSource.includes('SerializedStep'), true);
    assert.equal(serializationSource.includes('validateStepResolveFileForSerialization'), true);
    assert.equal(serializationSource.includes('StepHintFile'), false);
    assert.equal(serializationSource.includes('export type StepHint'), false);
});

test('step file validation rejects runtime-only fields and legacy target args', () => {
    assert.doesNotThrow(() =>
        validateStepFileForSerialization({
            version: 1,
            steps: [
                {
                    id: 's1',
                    name: 'browser.click',
                    args: { selector: '#submit' },
                },
            ],
        } as any));

    assert.throws(
        () =>
            validateStepFileForSerialization({
                version: 1,
                steps: [
                    {
                        id: 's1',
                        name: 'browser.click',
                        args: { selector: '#submit', target: { selector: '#submit' } },
                    },
                ],
            } as any),
        /args\.target/,
    );

    assert.throws(
        () =>
            validateStepFileForSerialization({
                version: 1,
                steps: [
                    {
                        id: 's1',
                        name: 'browser.click',
                        args: { id: 'node_1' },
                    },
                ],
            } as any),
        /args\.id/,
    );

    assert.throws(
        () =>
            validateStepFileForSerialization({
                version: 1,
                steps: [
                    {
                        id: 's1',
                        name: 'browser.click',
                        args: { target: { selector: '#submit' } },
                    },
                ],
            } as any),
        /args\.target/,
    );
});

test('run steps request supports step resolves and tab args stay camelCase', () => {
    assert.equal(runStepsTypesSource.includes('stepResolves?: Record<string, StepResolve>;'), true);

    const createTabBlock = readStepArgsBlock('browser.create_tab');
    assert.equal(createTabBlock.includes('tabName: string'), true);
    assert.equal(createTabBlock.includes('url?'), false);

    const switchTabBlock = readStepArgsBlock('browser.switch_tab');
    assert.equal(switchTabBlock.includes('tabName: string'), true);
    assert.equal(switchTabBlock.includes('tabUrl'), false);
    assert.equal(switchTabBlock.includes('tabRef'), false);
    assert.equal(switchTabBlock.includes('tab_id'), false);
    assert.equal(switchTabBlock.includes('tab_url'), false);
    assert.equal(switchTabBlock.includes('tab_ref'), false);

    const closeTabBlock = readStepArgsBlock('browser.close_tab');
    assert.equal(closeTabBlock.includes('tabName: string'), true);
    assert.equal(closeTabBlock.includes('tabRef'), false);
    assert.equal(closeTabBlock.includes('tab_id'), false);
    assert.equal(closeTabBlock.includes('tab_ref'), false);

    const captureResolveBlock = readStepArgsBlock('browser.capture_resolve');
    assert.equal(captureResolveBlock.includes('resolveId?: string;'), false);
    assert.equal(runStepsSource.includes(`'browser.capture_resolve'`), false);
    assert.equal(captureResolveExecutorSource.includes('does not support step.resolve'), false);
    assert.equal(runStepsSource.includes('topLevelResolveId'), false);
    assert.equal(checkpointRuntimeSource.includes('.resolveId ? { resolveId:'), false);
});

test('canonical tab step args reject missing tabName and legacy fields at type level', () => {
    const createOk: Step<'browser.create_tab'> = { id: 'c-ok', name: 'browser.create_tab', args: { tabName: 'tab-a' } };
    const switchOk: Step<'browser.switch_tab'> = { id: 's-ok', name: 'browser.switch_tab', args: { tabName: 'tab-a' } };
    const closeOk: Step<'browser.close_tab'> = { id: 'x-ok', name: 'browser.close_tab', args: { tabName: 'tab-a' } };
    assert.equal(createOk.args.tabName, 'tab-a');
    assert.equal(switchOk.args.tabName, 'tab-a');
    assert.equal(closeOk.args.tabName, 'tab-a');

    // @ts-expect-error browser.create_tab requires tabName.
    const createMissing: Step<'browser.create_tab'> = { id: 'c-missing', name: 'browser.create_tab', args: {} };
    // @ts-expect-error browser.switch_tab requires tabName.
    const switchMissing: Step<'browser.switch_tab'> = { id: 's-missing', name: 'browser.switch_tab', args: {} };
    // @ts-expect-error browser.close_tab requires tabName.
    const closeMissing: Step<'browser.close_tab'> = { id: 'x-missing', name: 'browser.close_tab', args: {} };
    // @ts-expect-error tabRef is not part of canonical switch_tab args.
    const switchTabRef: Step<'browser.switch_tab'> = { id: 's-ref', name: 'browser.switch_tab', args: { tabName: 'tab-a', tabRef: 'tab-a' } };
    // @ts-expect-error tabRef is not part of canonical close_tab args.
    const closeTabRef: Step<'browser.close_tab'> = { id: 'x-ref', name: 'browser.close_tab', args: { tabName: 'tab-a', tabRef: 'tab-a' } };
    // @ts-expect-error create_tab.url is not part of canonical create_tab args.
    const createUrl: Step<'browser.create_tab'> = { id: 'c-url', name: 'browser.create_tab', args: { tabName: 'tab-a', url: 'https://example.com' } };
    assert.equal(Boolean(createMissing || switchMissing || closeMissing || switchTabRef || closeTabRef || createUrl), true);
});

test('step resolve sidecar validation accepts basic resolve file shape', () => {
    assert.doesNotThrow(() =>
        validateStepResolveFileForSerialization({
            version: 1,
            resolves: {
                resolveSubmit: {
                    hint: { raw: { selector: '#submit' } },
                    policy: { requireVisible: true },
                },
            },
        }),
    );
});

// ── protocol lock: removed fields ──

test('protocol lock: timeout fields are removed from StepArgsMap', () => {
    // @ts-expect-error timeout is removed from browser.click
    const clickWithTimeout: Step<'browser.click'> = { id: 't1', name: 'browser.click', args: { selector: '#x', timeout: 1000 } };
    // @ts-expect-error timeout is removed from browser.fill
    const fillWithTimeout: Step<'browser.fill'> = { id: 't2', name: 'browser.fill', args: { value: 'x', timeout: 1000 } };
    // @ts-expect-error timeout is removed from browser.type
    const typeWithTimeout: Step<'browser.type'> = { id: 't3', name: 'browser.type', args: { text: 'x', timeout: 1000 } };
    // @ts-expect-error timeout is removed from browser.hover
    const hoverWithTimeout: Step<'browser.hover'> = { id: 't4', name: 'browser.hover', args: { selector: '#x', timeout: 1000 } };
    // @ts-expect-error timeout is removed from browser.scroll
    const scrollWithTimeout: Step<'browser.scroll'> = { id: 't5', name: 'browser.scroll', args: { timeout: 1000 } };
    // @ts-expect-error timeout is removed from browser.press_key
    const pkWithTimeout: Step<'browser.press_key'> = { id: 't6', name: 'browser.press_key', args: { key: 'Enter', timeout: 1000 } };
    // @ts-expect-error timeout is removed from browser.goto
    const gotoWithTimeout: Step<'browser.goto'> = { id: 't7', name: 'browser.goto', args: { url: 'https://x.com', timeout: 5000 } };
    // @ts-expect-error timeout is removed from browser.go_back
    const gbWithTimeout: Step<'browser.go_back'> = { id: 't8', name: 'browser.go_back', args: { timeout: 5000 } };
    // @ts-expect-error timeout is removed from browser.reload
    const reloadWithTimeout: Step<'browser.reload'> = { id: 't9', name: 'browser.reload', args: { timeout: 5000 } };
    // @ts-expect-error timeout is removed from browser.select_option
    const soWithTimeout: Step<'browser.select_option'> = { id: 't10', name: 'browser.select_option', args: { values: ['x'], timeout: 1000 } };
    // @ts-expect-error timeout is removed from browser.drag_and_drop
    const ddWithTimeout: Step<'browser.drag_and_drop'> = { id: 't11', name: 'browser.drag_and_drop', args: { sourceSelector: '#a', destCoord: { x: 0, y: 0 }, timeout: 1000 } };
    assert.equal(Boolean(clickWithTimeout || fillWithTimeout || typeWithTimeout || hoverWithTimeout || scrollWithTimeout || pkWithTimeout || gotoWithTimeout || gbWithTimeout || reloadWithTimeout || soWithTimeout || ddWithTimeout), true);
});

test('protocol lock: delay_ms is removed from browser.type', () => {
    // @ts-expect-error delay_ms is removed from browser.type
    const step: Step<'browser.type'> = { id: 'd1', name: 'browser.type', args: { text: 'x', delay_ms: 50 } };
    assert.equal(Boolean(step), true);
});

test('protocol lock: coord is removed from browser.click', () => {
    // @ts-expect-error coord is removed from browser.click
    const step: Step<'browser.click'> = { id: 'c1', name: 'browser.click', args: { coord: { x: 0, y: 0 } } };
    assert.equal(Boolean(step), true);
});

test('protocol lock: kind, controlRef, searchText removed from browser.select_option', () => {
    // @ts-expect-error kind is removed from browser.select_option
    const withKind: Step<'browser.select_option'> = { id: 'k1', name: 'browser.select_option', args: { values: ['x'], kind: 'native_select' } };
    // @ts-expect-error controlRef is removed from browser.select_option
    const withCR: Step<'browser.select_option'> = { id: 'k2', name: 'browser.select_option', args: { values: ['x'], controlRef: 'c:1' } };
    // @ts-expect-error searchText is removed from browser.select_option
    const withST: Step<'browser.select_option'> = { id: 'k3', name: 'browser.select_option', args: { values: ['x'], searchText: 'x' } };
    assert.equal(Boolean(withKind || withCR || withST), true);
});

test('protocol lock: includeA11y and focus_only removed from browser.snapshot', () => {
    // @ts-expect-error includeA11y is removed from browser.snapshot
    const withA11y: Step<'browser.snapshot'> = { id: 's1', name: 'browser.snapshot', args: { includeA11y: true } };
    // @ts-expect-error focus_only is removed from browser.snapshot
    const withFO: Step<'browser.snapshot'> = { id: 's2', name: 'browser.snapshot', args: { focus_only: true } };
    assert.equal(Boolean(withA11y || withFO), true);
});

test('protocol lock: sourceResolveId and destResolveId removed from browser.drag_and_drop', () => {
    // @ts-expect-error sourceResolveId is removed from browser.drag_and_drop
    const withSrc: Step<'browser.drag_and_drop'> = { id: 'd1', name: 'browser.drag_and_drop', args: { sourceResolveId: 'r1', destCoord: { x: 0, y: 0 } } };
    // @ts-expect-error destResolveId is removed from browser.drag_and_drop
    const withDst: Step<'browser.drag_and_drop'> = { id: 'd2', name: 'browser.drag_and_drop', args: { sourceSelector: '#a', destResolveId: 'r2' } };
    assert.equal(Boolean(withSrc || withDst), true);
});

// ── protocol lock: retained fields ──

test('protocol lock: resolveId is retained in action step args', () => {
    const step: Step<'browser.click'> = { id: 'r1', name: 'browser.click', args: { resolveId: 'res1' } };
    assert.equal(step.args.resolveId, 'res1');
});

test('protocol lock: evaluate.mutatesPage is retained', () => {
    const step: Step<'browser.evaluate'> = { id: 'e1', name: 'browser.evaluate', args: { expression: '1', mutatesPage: true } };
    assert.equal(step.args.mutatesPage, true);
});

test('protocol lock: capture_resolve.limit is retained', () => {
    const step: Step<'browser.capture_resolve'> = { id: 'cr1', name: 'browser.capture_resolve', args: { text: 'x', limit: 3 } };
    assert.equal(step.args.limit, 3);
});

test('protocol lock: read_console.limit is retained', () => {
    const step: Step<'browser.read_console'> = { id: 'rc1', name: 'browser.read_console', args: { limit: 10 } };
    assert.equal(step.args.limit, 10);
});

test('protocol lock: read_network.limit is retained', () => {
    const step: Step<'browser.read_network'> = { id: 'rn1', name: 'browser.read_network', args: { limit: 10 } };
    assert.equal(step.args.limit, 10);
});

test('protocol lock: browser.query.limit is retained', () => {
    const block = readStepArgsBlock('browser.query');
    assert.equal(block.includes('limit?: number;'), true, 'browser.query should expose limit');
});

test('protocol lock: take_screenshot.full_page and inline are retained', () => {
    const step: Step<'browser.take_screenshot'> = {
        id: 'ts1', name: 'browser.take_screenshot',
        args: { full_page: true, inline: true },
    };
    assert.equal(step.args.full_page, true);
    assert.equal(step.args.inline, true);
});

test('protocol lock: browser.click.options is retained', () => {
    const step: Step<'browser.click'> = {
        id: 'co1', name: 'browser.click',
        args: { selector: '#x', options: { button: 'right', double: true } },
    };
    assert.equal(step.args.options?.button, 'right');
    assert.equal(step.args.options?.double, true);
});

test('protocol lock: drag_and_drop.destCoord is retained', () => {
    const step: Step<'browser.drag_and_drop'> = {
        id: 'dd1', name: 'browser.drag_and_drop',
        args: { sourceSelector: '#a', destCoord: { x: 100, y: 200 } },
    };
    assert.equal(step.args.destCoord?.x, 100);
    assert.equal(step.args.destCoord?.y, 200);
});

test('protocol lock: browser.select_option args only accepts canonical fields', () => {
    const block = readStepArgsBlock('browser.select_option');
    assert.equal(block.includes('nodeId?: string;'), true, 'select_option should expose nodeId');
    assert.equal(block.includes('selector?: string;'), true, 'select_option should expose selector');
    assert.equal(block.includes('resolveId?: string;'), true, 'select_option should expose resolveId');
    assert.equal(block.includes('values: string[]'), true, 'select_option should expose values');
    assert.equal(block.includes('kind?'), false, 'select_option must not expose kind');
    assert.equal(block.includes('controlRef?'), false, 'select_option must not expose controlRef');
    assert.equal(block.includes('searchText?'), false, 'select_option must not expose searchText');
    assert.equal(block.includes('timeout?'), false, 'select_option must not expose timeout');
});

test('protocol lock: browser.mouse exists for coordinate-level mouse operations', () => {
    const step: Step<'browser.mouse'> = {
        id: 'm1', name: 'browser.mouse',
        args: { action: 'click', x: 100, y: 200 },
    };
    assert.equal(step.args.action, 'click');
    assert.equal(step.args.x, 100);
    assert.equal(step.args.y, 200);
});
