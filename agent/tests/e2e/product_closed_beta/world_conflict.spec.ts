import {test, expect} from '@playwright/test';
import {startFixtureServer} from '../../helpers/server';
import {startClosedBetaSession} from '../../helpers/product_closed_beta/session';
import {startClosedBetaFauxModel, wireTool, wireText, parseProgramOutcome} from '../../helpers/product_closed_beta/faux_model_server';
import {
    flushClosedBetaMatrix,
    newClosedBetaMatrix,
    passRow,
    failRow,
    type ClosedBetaMatrix,
} from '../../helpers/product_closed_beta/matrix';

/**
 * Closed-beta acceptance item 8: async DOM mutation between the observed read
 * and the transact produces a World conflict (ERR_AGENT_WORLD_CONFLICT), never
 * a stale mutation. Verified at the Workspace WS `agent.run` transport (the
 * same workspace executor the product surface uses) against the real page.
 */

const matrix: ClosedBetaMatrix = newClosedBetaMatrix();

const CUSTOMER_PROFILE = '/step_actions/customer_profile.html';

type ResolvedTarget = {nodeId: string; meta: {pageEpoch: string; captureRevision: number}};

test.describe('closed-beta: world conflict on stale observed transact', () => {
    test.describe.configure({mode: 'serial', timeout: 300_000});

    test('async DOM re-render between read and transact yields a World conflict and no stale mutation', async () => {
        const fixture = await startFixtureServer();
        const faux = await startClosedBetaFauxModel({
            script: (ctx) => {
                const last = ctx.lastTool;
                if (!last) {
                    return wireTool('debug.cross_barrier', {});
                }
                if (last.toolName === 'debug.cross_barrier') {
                    const outcome = parseProgramOutcome(last.text);
                    if (outcome?.status === 'paused' && outcome.pause?.reason === 'barrier') {
                        return wireTool('debug.cross_barrier', {});
                    }
                }
                return wireText('conflict observed');
            },
        });
        const session = await startClosedBetaSession({modelServer: faux});
        try {
            await session.openTab(`${fixture.baseURL}${CUSTOMER_PROFILE}`);

            const snapshot = await session.runStep({id: 'cb-snapshot-before', name: 'browser.snapshot', args: {}});
            expect(snapshot.ok, JSON.stringify(snapshot.error || {})).toBe(true);
            const resolved = await session.runStep({id: 'cb-resolve-before', name: 'browser.capture_resolve', args: {selector: '#customerName'}});
            expect(resolved.ok, JSON.stringify(resolved.error || {})).toBe(true);
            const target = (resolved.data as {target?: ResolvedTarget}).target;
            expect(target?.nodeId && target.meta?.pageEpoch, JSON.stringify(resolved.data)).toBeTruthy();
            const beforeEpoch = target!.meta.pageEpoch;
            const beforeRevision = target!.meta.captureRevision;

            await session.evaluate(`(() => {
                const original = document.querySelector('#customerName');
                if (original && original.parentElement) {
                    const replacement = document.createElement('input');
                    replacement.id = 'customerName-v2';
                    replacement.setAttribute('aria-label', 'customer name v2');
                    original.parentElement.replaceChild(replacement, original);
                }
            })()`);
            const refreshed = await session.runStep({id: 'cb-snapshot-refresh', name: 'browser.snapshot', args: {refresh: true}});
            expect(refreshed.ok, JSON.stringify(refreshed.error || {})).toBe(true);

            const runReply = await session.dispatch('agent.run', {
                prompt: 'fill from a previously observed target',
                provider: faux.provider,
                model: faux.model,
                executionMode: 'program',
                source: 'fill input.target with input.value\noutput result = input.value',
                input: {target, value: 'StaleTax'},
            });
            expect(runReply.type).toBe('agent.run.result');

            const result = (runReply.payload ?? {}) as {
                programs?: Array<{
                    status?: string;
                    pause?: {reason?: string; failure?: {code?: string}};
                    effects?: Array<{worldBefore?: {pageEpoch?: string; captureRevision?: number}; worldAfter?: {pageEpoch?: string; captureRevision?: number}}>;
                }>;
            };
            const program = result.programs?.[0];
            const conflict = program?.status === 'paused'
                && program?.pause?.reason === 'failure'
                && program?.pause?.failure?.code === 'ERR_AGENT_WORLD_CONFLICT';
            const unchangedWorlds = (program?.effects ?? []).every((effect) =>
                effect.worldBefore?.pageEpoch === effect.worldAfter?.pageEpoch
                && effect.worldBefore?.captureRevision === effect.worldAfter?.captureRevision);

            const domAfter = await session.evaluate<{v1Value: string; v1Existed: boolean; v2Value: string}>(`return {
                v1Value: document.querySelector('#customerName')?.value ?? '',
                v1Existed: Boolean(document.querySelector('#customerName')),
                v2Value: document.querySelector('#customerName-v2')?.value ?? '',
            };`);

            const evidence: string[] = [
                `observed epoch=${beforeEpoch} revision=${beforeRevision} then re-rendered`,
                `program.status=${JSON.stringify(program?.status)} pause.reason=${JSON.stringify(program?.pause?.reason)} failure.code=${JSON.stringify(program?.pause?.failure?.code)}`,
                `no effect mutated the world change ${unchangedWorlds}`,
                `real DOM after attempt: ${JSON.stringify(domAfter)} (stale value must never land)`,
            ];
            const passed = conflict && unchangedWorlds && domAfter.v1Value === '' && domAfter.v2Value === '';
            matrix.rows.push(passed
                ? passRow('cb.world-conflict.dom-mutation', 'item 8: async DOM mutation between read and transact yields a World conflict, never a stale mutation', evidence)
                : failRow('cb.world-conflict.dom-mutation', 'item 8: async DOM mutation between read and transact yields a World conflict, never a stale mutation', 'world-conflict guard mis-behaved', evidence));
            expect(passed, JSON.stringify({conflict, unchangedWorlds, domAfter, beforeEpoch, beforeRevision}, null, 2)).toBe(true);
        } finally {
            await session.close();
            await faux.close();
            await fixture.close();
            flushClosedBetaMatrix(matrix);
        }
    });
});