import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductSmokeSession, fixtureUrl, httpBase, bearerHeaders} from '../../../helpers/agent_product_harness';
import {
    createScriptedModelRuntime,
    planFormProgramScript,
    tool,
    lastToolResult,
    assistant,
    type ModelScript,
} from '../../../helpers/agent_product_faux';
import {startFixtureServer} from '../../../helpers/server';
import {passEntry, failEntry} from '../../../helpers/agent_product_matrix';
import type {AgentRunResult} from '../../../../src/agent/execution/types';
import {
    parseCaptureResolveTarget,
} from '../../../helpers/agent_product_faux';

const CUSTOMER_PROFILE = '/step_actions/customer_profile.html';

const runAgentRequest = async (port: number, body: Record<string, unknown>) => {
    const response = await fetch(`${httpBase(port)}/agent`, {
        method: 'POST',
        headers: bearerHeaders(undefined),
        body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `agent run failed with ${response.status}`);
    return await response.json() as AgentRunResult;
};

const reactBaselineFillScript = (selector: string, value: string): ModelScript => (context) => {
    const last = lastToolResult(context.messages);
    if (!last) {
        return tool('browser.snapshot', {});
    }
    if (last.toolName === 'browser.snapshot') {
        return tool('browser.fill', {selector, value});
    }
    return assistant('done');
};

test('product: ordinary DOM form via snapshot->capture_resolve->Program', async () => {
    const faux = createScriptedModelRuntime(planFormProgramScript({fieldSelector: '#customerName', value: 'Alice'}));
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({modelRuntime: faux.runtime});
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, CUSTOMER_PROFILE));

        const result = await runAgentRequest(port, {
            prompt: 'fill the customer name field',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
        });

        assert.equal(result.executionMode, 'program');
        const program = result.programs?.[0];
        assert.equal(program?.status, 'completed', JSON.stringify(program?.error ?? program?.pause ?? null));
        assert.equal((JSON.parse(program?.text ?? '{}') as Record<string, unknown>).result, 'Alice');
        assert.ok(faux.toolCallCount() >= 3, 'model must read, resolve, then transact');
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.locator('#customerName').inputValue(), 'Alice', 'real DOM must hold the program effect');
        session.record(passEntry('program.form.ordinary', 'ordinary DOM form via snapshot->capture_resolve->Program'));
    } catch (error) {
        session.record(failEntry('program.form.ordinary', 'ordinary DOM form via snapshot->capture_resolve->Program', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});

test('product: multi-step form with compute and ensure', async () => {
    const faux = createScriptedModelRuntime(planFormProgramScript({
        fieldSelector: '#customerName',
        value: 'ACME',
        secondFieldSelector: '#contactName',
        secondValue: 'Bob',
    }));
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({modelRuntime: faux.runtime});
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, CUSTOMER_PROFILE));

        const result = await runAgentRequest(port, {
            prompt: 'fill the customer profile with two fields',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
        });

        const program = result.programs?.[0];
        assert.equal(program?.status, 'completed', JSON.stringify(program?.error ?? program?.pause ?? null));
        assert.equal((JSON.parse(program?.text ?? '{}') as Record<string, unknown>).ok, true);
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.locator('#customerName').inputValue(), 'ACME');
        assert.equal(await session.page.locator('#contactName').inputValue(), 'Bob');
        session.record(passEntry('program.form.multi-step-compute', 'multi-step form with compute + ensure'));
    } catch (error) {
        session.record(failEntry('program.form.multi-step-compute', 'multi-step form with compute + ensure', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});

test('product: multi-step program carrying observed revisions fills each target exactly once', async () => {
    // The production guidance passes the observed target envelope
    // {nodeId, meta} into program input. Both fills were resolved from the same
    // snapshot, so the second effect's expected-world precondition predates the
    // first effect's own write. The transaction-local world lineage advances the
    // second precondition across the first effect's journaled worldAfter, so both
    // fills execute once without self-conflict.
    let captures = 0;
    const resolvedTargets: Array<{nodeId: string; meta: {pageEpoch: string; captureRevision: number}}> = [];
    const parseOutcome = (text: string): {status: string; pause?: {reason: string}} | null => {
        try {
            return JSON.parse(text) as {status: string; pause?: {reason: string}};
        } catch {
            return null;
        }
    };
    const script: ModelScript = (context) => {
        const last = lastToolResult(context.messages);
        if (!last) {
            return tool('browser.snapshot', {});
        }
        if (last.toolName === 'browser.snapshot') {
            return tool('browser.capture_resolve', {selector: '#customerName'});
        }
        if (last.toolName === 'browser.capture_resolve') {
            captures += 1;
            const target = parseCaptureResolveTarget(last.text);
            if (!target) {throw new Error('capture_resolve did not return an observed target envelope');}
            resolvedTargets.push(target);
            if (captures === 1) {
                return tool('browser.capture_resolve', {selector: '#contactName'});
            }
            const source = [
                'fill input.target with input.value',
                'fill input.target2 with input.value2',
                'output ok = input.value',
            ].join('\n');
            return tool('agent.execute_program', {
                source,
                input: {target: resolvedTargets[0], target2: resolvedTargets[1], value: 'A', value2: 'B'},
            });
        }
        if (last.toolName === 'agent.execute_program' || last.toolName === 'debug.cross_barrier') {
            const outcome = parseOutcome(last.text);
            if (outcome?.status === 'paused' && outcome.pause?.reason === 'barrier') {
                return tool('debug.cross_barrier', {});
            }
            return assistant('terminal');
        }
        return assistant('terminal');
    };
    const faux = createScriptedModelRuntime(script);
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({modelRuntime: faux.runtime});
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, CUSTOMER_PROFILE));
        const result = await runAgentRequest(port, {
            prompt: 'fill two fields with observed revisions',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
        });
        const program = result.programs?.[0];
        assert.equal(program?.status, 'completed', JSON.stringify(program?.error ?? program?.pause ?? null));
        assert.equal((JSON.parse(program?.text ?? '{}') as Record<string, unknown>).ok, 'A');
        assert.ok(resolvedTargets.length === 2 && captures === 2, 'the model must resolve both targets before transacting');
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.locator('#customerName').inputValue(), 'A',
            'the first fill must land exactly once');
        assert.equal(await session.page.locator('#contactName').inputValue(), 'B',
            'the second fill must land exactly once without a world self-conflict');
        session.record(passEntry('program.form.observed-multi-step', 'multi-step program carrying observed revisions', [
            `observed epoch ${resolvedTargets[0]?.meta.pageEpoch} revision ${resolvedTargets[0]?.meta.captureRevision} advanced across both journaled fills`,
        ]));
    } catch (error) {
        session.record(failEntry('program.form.observed-multi-step', 'multi-step program carrying observed revisions', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});

test('product: Program vs react-baseline mode selection on the same form', async () => {
    const programFaux = createScriptedModelRuntime(planFormProgramScript({fieldSelector: '#customerName', value: 'ModeProgram'}));
    const baselineFaux = createScriptedModelRuntime(reactBaselineFillScript('#customerName', 'ModeBaseline'));
    const fixture = await startFixtureServer();
    const programSession = await openProductSmokeSession({modelRuntime: programFaux.runtime});
    const baselineSession = await openProductSmokeSession({modelRuntime: baselineFaux.runtime});
    const programPort = await programSession.startService();
    const baselinePort = await baselineSession.startService();
    try {
        await programSession.page.goto(fixtureUrl(fixture, CUSTOMER_PROFILE));
        const programRun = await runAgentRequest(programPort, {
            prompt: 'mode selection program',
            provider: programFaux.provider,
            model: programFaux.model,
            executionMode: 'program',
        });
        assert.equal(programRun.executionMode, 'program');
        assert.ok(programRun.programs?.length === 1, 'program mode exposes the program summary');
        assert.equal(programRun.programs?.[0]?.status, 'completed');
        await programSession.page.waitForTimeout(250);
        assert.equal(await programSession.page.locator('#customerName').inputValue(), 'ModeProgram');

        await baselineSession.page.goto(fixtureUrl(fixture, CUSTOMER_PROFILE));
        const baselineRun = await runAgentRequest(baselinePort, {
            prompt: 'mode selection baseline',
            provider: baselineFaux.provider,
            model: baselineFaux.model,
            executionMode: 'react-baseline',
        });
        assert.equal(baselineRun.executionMode, 'react-baseline');
        assert.ok(!baselineRun.programs || baselineRun.programs.length === 0,
            'react-baseline must not fabricate a program summary');
        await baselineSession.page.waitForTimeout(250);
        assert.equal(await baselineSession.page.locator('#customerName').inputValue(), 'ModeBaseline');

        programSession.record(passEntry('agent.mode-selection', 'Program vs react-baseline mode selection', [
            'program mode produced a program summary and mutated the DOM',
            'react-baseline mode mutated the DOM without a program summary',
        ]));
    } catch (error) {
        programSession.record(failEntry('agent.mode-selection', 'Program vs react-baseline mode selection', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        programSession.flushMatrix();
        await programSession.stop();
        await baselineSession.stop();
        await fixture.close();
    }
});