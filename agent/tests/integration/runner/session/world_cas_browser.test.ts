import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { createWorkspaceHarness } from '../../../helpers/workspace_harness';
import { createWorkspaceProgramExecutor } from '../../../../src/agent/workspace/program_executor';
import { executeBrowserCaptureResolve } from '../../../../src/automation/runner/steps/executors/capture_resolve';
import { stepExecutors } from '../../../../src/automation/runner/steps/executors';
import type { RunStepsDeps } from '../../../../src/automation/runner/run_steps_types';
import type { Step, StepUnion } from '../../../../src/automation/runner/steps/types';
import type { Workflow } from '../../../../src/automation/workflow';

const step = <T extends StepUnion['name']>(
    id: string,
    name: T,
    args: Extract<StepUnion, { name: T }>['args'],
): Step<T> => ({id, name, args} as Step<T>);

const captureTarget = async (
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<{nodeId: string; meta: {pageEpoch: string; captureRevision: number}}> => {
    const resolved = await executeBrowserCaptureResolve(
        step('capture-resolve', 'browser.capture_resolve', {selector: '#submit'}),
        deps,
        workspaceName,
    );
    assert.equal(resolved.ok, true, JSON.stringify(resolved.error ?? {}));
    const data = resolved.data as {target: {nodeId: string; meta: {pageEpoch: string; captureRevision: number}}};
    return {nodeId: data.target.nodeId, meta: data.target.meta};
};

const clickProgram = `let t = compute eq(1, 1)
click input.target
output done = t`;

const runProgramAtBarrier = async (
    executor: ReturnType<typeof createWorkspaceProgramExecutor>,
    envelope: {nodeId: string; meta: {pageEpoch: string; captureRevision: number}},
) => {
    const start = await executor({
        source: clickProgram,
        input: {target: {nodeId: envelope.nodeId, meta: envelope.meta}},
    });
    assert.equal(start.summary.status, 'paused', JSON.stringify(start.summary));
    assert.ok(start.debug, 'program must expose the retained session');
    return {session: start.debug.session, pause: start.debug.pause};
};

test('a page that mutates itself invalidates the observed world so a stale program envelope conflicts and never clicks', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent(`<button id="submit">Submit</button><script>
            window.__clickCount = 0;
            document.getElementById('submit').addEventListener('click', () => { window.__clickCount += 1; });
        </script>`);

        let mutationNotifications = 0;
        const {registry, runStepsDeps} = createWorkspaceHarness({
            getPage: async () => page,
            pluginHost: {getExecutors: () => stepExecutors} as never,
            onPageMutation: (mutated, session) => {
                assert.equal(mutated, page);
                mutationNotifications += 1;
                session.markDirty(mutated, 'interaction');
            },
        });
        const workspaceName = `ws-cas-${Date.now().toString(36)}`;
        const workflow = {name: workspaceName} as unknown as Workflow;
        const workspace = registry.createWorkspace(workspaceName, workflow);
        workspace.tabs.createTab({tabName: 'main'});
        const executor = createWorkspaceProgramExecutor({
            workspaceName,
            deps: runStepsDeps,
            runWorkspaceExecution: async (_actionType, run) => await run(),
        });

        // Capture/resolve the target at revision N on a quiet page.
        const first = await captureTarget(runStepsDeps, workspaceName);
        const firstRevision = first.meta.captureRevision;
        const pageKey: Page = page;
        assert.equal(runStepsDeps.pageSession.readFreshness(pageKey, page.url()).status, 'fresh');
        assert.equal(mutationNotifications, 0, 'capturing a quiet page must not signal the observer');

        // The page changes itself via setTimeout; no rpa-browser tool is involved.
        await page.evaluate(() => {
            setTimeout(() => {
                document.querySelector('#submit')!.textContent = 'Submit now';
            }, 50);
        });
        await settle();
        assert.equal(runStepsDeps.pageSession.readFreshness(pageKey, page.url()).status, 'dirty');

        // The program effect carries the old envelope; the precondition check must
        // see the recaptured world and refuse to click.
        const staleRun = await runProgramAtBarrier(executor, first);
        assert.equal(staleRun.pause.world.revision.captureRevision, firstRevision + 1);
        const conflict = await staleRun.session.crossBarrier(staleRun.pause.continuationId);
        assert.equal(conflict.status, 'paused');
        if (conflict.status !== 'paused') {throw new Error('expected a paused conflict failure');}
        assert.equal(conflict.pause.reason, 'failure');
        if (conflict.pause.reason !== 'failure') {throw new Error('expected a failure pause');}
        assert.equal(conflict.pause.failure.code, 'ERR_AGENT_WORLD_CONFLICT');
        assert.deepEqual(conflict.pause.failure.details, {
            expected: {...first.meta},
            actual: {pageEpoch: first.meta.pageEpoch, captureRevision: firstRevision + 1},
        });
        assert.equal(await page.evaluate(() => (window as unknown as {__clickCount: number}).__clickCount), 0);

        // Re-resolving the target observes revision N+1; the same effect then
        // succeeds exactly once.
        const refreshed = await captureTarget(runStepsDeps, workspaceName);
        assert.equal(refreshed.meta.captureRevision, firstRevision + 1);
        const freshRun = await runProgramAtBarrier(executor, refreshed);
        const completed = await freshRun.session.crossBarrier(freshRun.pause.continuationId);
        assert.equal(completed.status, 'completed', JSON.stringify(completed));
        if (completed.status !== 'completed') {throw new Error('expected program completion');}
        assert.deepEqual(completed.output, {done: true});
        assert.equal(await page.evaluate(() => (window as unknown as {__clickCount: number}).__clickCount), 1);
    } finally {
        await browser.close();
    }
});

test('a quiet page does not spuriously bump the capture revision across repeated captures', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent('<button id="submit">Submit</button>');

        let mutationNotifications = 0;
        const {registry, runStepsDeps} = createWorkspaceHarness({
            getPage: async () => page,
            pluginHost: {getExecutors: () => stepExecutors} as never,
            onPageMutation: (_mutated, session) => {
                mutationNotifications += 1;
            },
        });
        const workspaceName = `ws-quiet-${Date.now().toString(36)}`;
        const workflow = {name: workspaceName} as unknown as Workflow;
        const workspace = registry.createWorkspace(workspaceName, workflow);
        workspace.tabs.createTab({tabName: 'main'});

        const first = await captureTarget(runStepsDeps, workspaceName);
        const pageKey: Page = page;
        for (let index = 0; index < 3; index += 1) {
            const again = await captureTarget(runStepsDeps, workspaceName);
            assert.equal(again.meta.pageEpoch, first.meta.pageEpoch);
            assert.equal(again.meta.captureRevision, first.meta.captureRevision, `capture ${index} must reuse the clean session`);
        }
        assert.equal(runStepsDeps.pageSession.readFreshness(pageKey, page.url()).status, 'fresh');
        assert.equal(mutationNotifications, 0, 'repeated snapshot reads must never signal the observer');
    } finally {
        await browser.close();
    }
});

const settle = async (ms = 500): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
};