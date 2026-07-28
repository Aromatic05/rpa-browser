import test from 'node:test';
import assert from 'node:assert/strict';
import {executeBrowserAssert} from '../../../../src/runner/steps/executors/assert';
import type {Step} from '../../../../src/runner/steps/types';
import type {RunStepsDeps} from '../../../../src/runner/run_steps';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const createDeps = async (options: {
    url?: string;
    textVisibleResult?: boolean;
}): Promise<RunStepsDeps> => {
    const currentUrl = options.url || 'https://example.test/page';
    const page = {url: () => currentUrl};
    const traceTools = {
        'trace.page.getInfo': async () => ({ok: true, data: {url: currentUrl}}),
        'trace.page.evaluate': async () => ({ok: true, data: options.textVisibleResult ?? true}),
    };
    const deps = completeRunStepsDeps({pluginHost: {} as never}, {
        workspaceName: 'ws-1',
        tabName: 'tab-token-1',
        page,
        traceTools,
    });
    const fixture = createV2BusinessPage();
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: currentUrl,
        capture: async () => fixture.capture,
    });
    return deps;
};

const createAssertStep = (args: Step<'browser.assert'>['args']): Step<'browser.assert'> => ({
    id: 'assert-1',
    name: 'browser.assert',
    args,
});

test('assert urlIncludes success and failure', async () => {
    const success = await executeBrowserAssert(
        createAssertStep({urlIncludes: '/ok'}),
        await createDeps({url: 'https://example.test/ok'}),
        'ws-1',
    );
    assert.equal(success.ok, true);

    const failure = await executeBrowserAssert(
        createAssertStep({urlIncludes: '/ok'}),
        await createDeps({url: 'https://example.test/nope'}),
        'ws-1',
    );
    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, 'ERR_CHECKPOINT_ASSERT_FAILED');
});

test('assert textVisible success and failure', async () => {
    const success = await executeBrowserAssert(
        createAssertStep({textVisible: 'Hello'}),
        await createDeps({textVisibleResult: true}),
        'ws-1',
    );
    assert.equal(success.ok, true);

    const failure = await executeBrowserAssert(
        createAssertStep({textVisible: 'Hello'}),
        await createDeps({textVisibleResult: false}),
        'ws-1',
    );
    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, 'ERR_CHECKPOINT_ASSERT_FAILED');
});

test('assert entityExists filters the V2 EntityView', async () => {
    const deps = await createDeps({});
    const success = await executeBrowserAssert(createAssertStep({
        entityExists: {
            query: 'order table',
            kind: 'table',
            businessTag: 'order.table.main',
        },
    }), deps, 'ws-1');
    assert.equal(success.ok, true);

    const failure = await executeBrowserAssert(createAssertStep({
        entityExists: {query: 'missing entity', businessTag: 'missing.tag'},
    }), deps, 'ws-1');
    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, 'ERR_CHECKPOINT_ASSERT_FAILED');
});

test('assert rejects an empty rule set', async () => {
    const result = await executeBrowserAssert(
        createAssertStep({}),
        await createDeps({}),
        'ws-1',
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_BAD_ARGS');
});
