import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateStepFileForSerialization, validateStepResolveFileForSerialization } from '../../../src/runner/serialization/types';

const repoRoot = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const stepTypesSource = read('src/runner/steps/types.ts');
const resolveTargetSource = read('src/runner/steps/helpers/resolve_target.ts');
const serializationSource = read('src/runner/serialization/types.ts');
const runStepsTypesSource = read('src/runner/run_steps_types.ts');
const runStepsSource = read('src/runner/run_steps.ts');
const captureResolveExecutorSource = read('src/runner/steps/executors/capture_resolve.ts');

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
        'sourceResolveId?: string;',
        'destNodeId?: string;',
        'destSelector?: string;',
        'destResolveId?: string;',
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
    assert.throws(
        () =>
            validateStepFileForSerialization({
                version: 1,
                steps: [
                    {
                        id: 's1',
                        name: 'browser.click',
                        args: { selector: '#submit' },
                        meta: { source: 'record' },
                    },
                ],
            } as any),
        /meta/,
    );

    assert.throws(
        () =>
            validateStepFileForSerialization({
                version: 1,
                steps: [
                    {
                        id: 's1',
                        name: 'browser.click',
                        args: { selector: '#submit' },
                        resolve: { hint: { raw: { selector: '#submit' } } },
                    },
                ],
            } as any),
        /resolve/,
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

    const switchTabBlock = readStepArgsBlock('browser.switch_tab');
    assert.equal(switchTabBlock.includes('tabId?: string;'), true);
    assert.equal(switchTabBlock.includes('tabUrl?: string;'), true);
    assert.equal(switchTabBlock.includes('tabRef?: string'), true);
    assert.equal(switchTabBlock.includes('tab_id'), false);
    assert.equal(switchTabBlock.includes('tab_url'), false);
    assert.equal(switchTabBlock.includes('tab_ref'), false);

    const closeTabBlock = readStepArgsBlock('browser.close_tab');
    assert.equal(closeTabBlock.includes('tabId?: string'), true);
    assert.equal(closeTabBlock.includes('tabRef?: string'), true);
    assert.equal(closeTabBlock.includes('tab_id'), false);
    assert.equal(closeTabBlock.includes('tab_ref'), false);

    const captureResolveBlock = readStepArgsBlock('browser.capture_resolve');
    assert.equal(captureResolveBlock.includes('resolveId'), false);
    assert.equal(runStepsSource.includes(`'browser.capture_resolve'`), false);
    assert.equal(captureResolveExecutorSource.includes('does not support step.resolve'), true);
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
