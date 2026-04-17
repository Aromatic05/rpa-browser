import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetNodeId } from '../../src/runner/steps/helpers/resolve_target';
import { clearReplayEnhancementContext, setReplayEnhancementContext } from '../../src/runner/steps/helpers/replay_enhancement_context';
import { executeBrowserClick } from '../../src/runner/steps/executors/click';
import { executeBrowserFill } from '../../src/runner/steps/executors/fill';
import type { Step } from '../../src/runner/steps/types';
import type { RecordedStepEnhancement } from '../../src/record/types';

const createBinding = () => {
    const calls: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const binding = {
        workspaceId: 'ws-test',
        page: {},
        traceCtx: { cache: {} },
        traceTools: {
            'trace.a11y.resolveByNodeId': async () => ({ ok: true, data: {} }),
            'trace.a11y.findByA11yHint': async () => ({ ok: true, data: [] }),
            'trace.locator.waitForVisible': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'waitForVisible', payload });
                return { ok: true, data: {} };
            },
            'trace.locator.scrollIntoView': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'scrollIntoView', payload });
                return { ok: true, data: {} };
            },
            'trace.locator.click': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'click', payload });
                return { ok: true, data: {} };
            },
            'trace.locator.focus': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'focus', payload });
                return { ok: true, data: {} };
            },
            'trace.locator.fill': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'fill', payload });
                return { ok: true, data: {} };
            },
        },
    } as any;

    const deps = {
        runtime: {
            ensureActivePage: async () => binding,
        },
        config: {
            waitPolicy: {
                visibleTimeoutMs: 800,
                interactionTimeoutMs: 1200,
            },
            humanPolicy: {
                enabled: false,
                clickDelayMsRange: { min: 0, max: 0 },
                typeDelayMsRange: { min: 0, max: 0 },
                scrollDelayMsRange: { min: 0, max: 0 },
            },
            confidencePolicy: {},
        },
    } as any;

    return { binding, deps, calls };
};

const withReplayEnhancement = async (stepId: string, enhancement: RecordedStepEnhancement, run: () => Promise<void>) => {
    setReplayEnhancementContext('ws-test', { [stepId]: enhancement });
    try {
        await run();
    } finally {
        clearReplayEnhancementContext('ws-test');
    }
};

test('resolve_target keeps legacy direct selector path without enhancement', async () => {
    const { binding } = createBinding();
    const resolved = await resolveTargetNodeId(binding, { selector: '#legacy' });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.target.selector, '#legacy');
    assert.equal(resolved.target.resolution?.usedEnhancement, undefined);
});

test('resolve_target uses enhancement fallback when direct target path fails', async () => {
    const { binding } = createBinding();
    await withReplayEnhancement(
        'step-fallback',
        {
            version: 1,
            eventType: 'click',
            rawContext: { selector: '#enhanced-fallback' },
            replayHints: { requireVisible: true },
        },
        async () => {
            const resolved = await resolveTargetNodeId(binding, { id: 'unknown-node' }, { stepId: 'step-fallback' });
            assert.equal(resolved.ok, true);
            if (!resolved.ok) return;
            assert.equal(resolved.target.selector, '#enhanced-fallback:visible');
            assert.equal(resolved.target.resolution?.usedEnhancement, true);
            assert.equal(resolved.target.resolution?.usedFallback, true);
        },
    );
});

test('click executor consumes enhancement-aware resolve fallback', async () => {
    const { deps, calls } = createBinding();
    const step: Step<'browser.click'> = {
        id: 'click-enhanced',
        name: 'browser.click',
        args: {},
        meta: { source: 'play', ts: Date.now() },
    };

    await withReplayEnhancement(
        step.id,
        {
            version: 1,
            eventType: 'click',
            rawContext: { selector: '#click-from-enhancement' },
            replayHints: { requireVisible: true },
        },
        async () => {
            const result = await executeBrowserClick(step, deps, 'ws-test');
            assert.equal(result.ok, true);
        },
    );

    const clickCall = calls.find((call) => call.name === 'click');
    assert.ok(clickCall);
    assert.equal(clickCall?.payload.selector, '#click-from-enhancement:visible');
});

test('fill executor consumes enhancement-aware resolve fallback', async () => {
    const { deps, calls } = createBinding();
    const step: Step<'browser.fill'> = {
        id: 'fill-enhanced',
        name: 'browser.fill',
        args: { value: 'hello' },
        meta: { source: 'play', ts: Date.now() },
    };

    await withReplayEnhancement(
        step.id,
        {
            version: 1,
            eventType: 'input',
            rawContext: { selector: '#fill-from-enhancement' },
            replayHints: { requireVisible: true },
        },
        async () => {
            const result = await executeBrowserFill(step, deps, 'ws-test');
            assert.equal(result.ok, true);
        },
    );

    const fillCall = calls.find((call) => call.name === 'fill');
    assert.ok(fillCall);
    assert.equal(fillCall?.payload.selector, '#fill-from-enhancement:visible');
});
