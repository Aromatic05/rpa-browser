import {test, expect} from '@playwright/test';
import {startFixtureServer} from '../../helpers/server';
import {startClosedBetaSession, pollProduct} from '../../helpers/product_closed_beta/session';
import {startClosedBetaFauxModel, wireTool, wireText, parseProgramOutcome, type ClosedBetaScript} from '../../helpers/product_closed_beta/faux_model_server';
import {buildCheckpointFormRule, saveEntityRule} from '../../helpers/product_closed_beta/entity_rules';
import {
    flushClosedBetaMatrix,
    newClosedBetaMatrix,
    passRow,
    failRow,
    type ClosedBetaMatrix,
} from '../../helpers/product_closed_beta/matrix';

/**
 * Closed-beta acceptance item 3: an objectively irreversible effect produces a
 * Product approval card/barrier; approval executes exactly once; deny never
 * cancels and the workspace stays able to replan.
 */

const matrix: ClosedBetaMatrix = newClosedBetaMatrix();

const CHECKPOINT_PAGE = '/checkpoint_recorder.html';

const APPROVAL_SOURCE = [
    'use entity_rules "cb-approval" as o',
    'fill o.ordersQuery.orderNo with input.orderNo',
    'click o.ordersQuery.query',
    'output ok = input.ok',
].join('\n');

const approvalScript = (): ClosedBetaScript => (ctx) => {
    if (ctx.lastUser.toLowerCase().includes('denied the pending effect')) {
        return wireText('cannot complete; the irreversible effect must not run');
    }
    const last = ctx.lastTool;
    if (!last) {
        return wireTool('browser.snapshot', {});
    }
    if (last.toolName === 'browser.snapshot') {
        return wireTool('agent.execute_program', {source: APPROVAL_SOURCE, input: {orderNo: 'SO-777', ok: true}});
    }
    const outcome = parseProgramOutcome(last.text);
    if (last.toolName === 'agent.execute_program' && outcome?.pause?.reason === 'barrier') {
        return wireText('awaiting approval');
    }
    return wireText('task end');
};

const approvalCapture = (): {script: ClosedBetaScript; sawDeny: () => boolean} => {
    let sawDeny = false;
    const script: ClosedBetaScript = (ctx) => {
        if (ctx.lastUser.toLowerCase().includes('denied the pending effect')) {
            sawDeny = true;
            return wireText('cannot complete; the irreversible effect must not run');
        }
        const last = ctx.lastTool;
        if (!last) {
            return wireTool('browser.snapshot', {});
        }
        if (last.toolName === 'browser.snapshot') {
            return wireTool('agent.execute_program', {source: APPROVAL_SOURCE, input: {orderNo: 'SO-777', ok: true}});
        }
        const outcome = parseProgramOutcome(last.text);
        if (last.toolName === 'agent.execute_program' && outcome?.pause?.reason === 'barrier') {
            return wireText('awaiting approval');
        }
        return wireText('task end');
    };
    return {script, sawDeny: () => sawDeny};
};

type TaskView = {
    taskId?: string;
    status?: string;
    error?: {code?: string};
    interaction?: {kind?: string; risk?: string; actionName?: string; interactionToken?: string};
};

const waitForInteraction = async (session: Awaited<ReturnType<typeof startClosedBetaSession>>, taskId: string): Promise<TaskView> =>
    pollProduct<TaskView>(async () => {
        const view = await session.product({verb: 'taskView', taskId}) as TaskView;
        return view?.interaction?.interactionToken ? view : null;
    }, 90_000);

test.describe('closed-beta: irreversible effect approval card', () => {
    test.describe.configure({mode: 'serial', timeout: 300_000});

    test('approval executes exactly once and the irreversible effect lands once', async () => {
        const fixture = await startFixtureServer();
        const faux = await startClosedBetaFauxModel({script: approvalScript()});
        const session = await startClosedBetaSession({modelServer: faux});
        try {
            await saveEntityRule(session, buildCheckpointFormRule({
                profileName: 'cb-approval',
                fieldEffect: 'reversible',
                actionEffect: 'irreversible',
            }));
            await session.openTab(`${fixture.baseURL}${CHECKPOINT_PAGE}`);

            const started = await session.product({verb: 'startTask', prompt: 'run the irreversible order query'}) as TaskView;
            expect(started.taskId, JSON.stringify(started)).toBeTruthy();
            const taskId = started.taskId as string;

            const waiting = await waitForInteraction(session, taskId);
            const card = waiting.interaction ?? {};
            const cardValid = card.kind === 'approval' && card.risk === 'irreversible' && Boolean(card.interactionToken);

            const approved = await session.product({
                verb: 'approve',
                taskId,
                interactionToken: card.interactionToken as string,
            }) as TaskView;
            expect(approved.status === 'completed' || approved.status === 'running', JSON.stringify(approved)).toBe(true);

            const settled = await pollProduct(async () => {
                const view = await session.product({verb: 'taskView', taskId}) as TaskView;
                return view.status === 'completed' ? view : null;
            }, 60_000);

            await session.evaluate(`(() => { return new Promise((resolve) => setTimeout(resolve, 300)); })()`);
            const countOnce = await session.evaluate<string>(`return document.body.dataset?.queryCount ?? '';`);
            const resultText = await session.evaluate<string>(`return document.querySelector('#query-result')?.textContent ?? '';`);

            const evidence: string[] = [
                `approval card kind=${JSON.stringify(card.kind)} risk=${JSON.stringify(card.risk)} actionName=${JSON.stringify(card.actionName)}`,
                `task terminal status=${JSON.stringify(settled.status)}`,
                `DOM queryCount=${JSON.stringify(countOnce)} (must be '1')`,
                `DOM query-result=${JSON.stringify(resultText)}`,
            ];
            const passed = cardValid
                && settled.status === 'completed'
                && countOnce === '1'
                && resultText === 'SO-777|';
            matrix.rows.push(passed
                ? passRow('cb.approval.execute-once', 'item 3: irreversible effect -> approval card -> approve executes exactly once', evidence)
                : failRow('cb.approval.execute-once', 'item 3: irreversible effect -> approval card -> approve executes exactly once', 'approval flow mis-behaved', evidence));
            expect(passed, JSON.stringify({cardValid, status: settled.status, countOnce, resultText}, null, 2)).toBe(true);
        } finally {
            await session.close();
            await faux.close();
            await fixture.close();
            flushClosedBetaMatrix(matrix);
        }
    });

    test('deny never cancels, replans in the retained loop, and never executes the irreversible effect', async () => {
        const fixture = await startFixtureServer();
        const capture = approvalCapture();
        const faux = await startClosedBetaFauxModel({script: capture.script});
        const session = await startClosedBetaSession({modelServer: faux});
        try {
            await saveEntityRule(session, buildCheckpointFormRule({
                profileName: 'cb-approval',
                fieldEffect: 'reversible',
                actionEffect: 'irreversible',
            }));
            await session.openTab(`${fixture.baseURL}${CHECKPOINT_PAGE}`);

            const started = await session.product({verb: 'startTask', prompt: 'run the irreversible order query'}) as TaskView;
            const taskId = started.taskId as string;
            const first = await waitForInteraction(session, taskId);
            const firstToken = first.interaction?.interactionToken as string;

            const denied = await session.product({
                verb: 'deny',
                taskId,
                interactionToken: firstToken,
                reason: 'not safe yet',
                requestedAlternative: 'I will review the query manually',
            }) as TaskView;
            expect(denied.status !== 'cancelled', JSON.stringify(denied)).toBe(true);

            // The model replans inside the retained loop: the deny decision
            // must be delivered back to the Agent, and the irreversible effect
            // must never execute. The still-paused retained execution re-surfaces
            // a fresh approval card for the same barrier.
            const replanned = await pollProduct(async () => (capture.sawDeny() ? true : null), 30_000);
            const capturedDeny = replanned;
            expect(replanned).toBe(true);

            const second = await waitForInteraction(session, taskId);
            const secondToken = second.interaction?.interactionToken as string;
            const freshCard = second.status === 'waiting_for_user'
                && second.interaction?.kind === 'approval'
                && secondToken !== firstToken;
            const notMutated = await session.evaluate<{count: string; result: string}>(`return {
                count: document.body.dataset?.queryCount ?? '',
                result: document.querySelector('#query-result')?.textContent ?? ''
            };`);
            const workspace = await session.product({verb: 'workspaceView'}) as {
                reservation?: {owner?: string; ownerTaskId?: string};
            };

            const recovered = await session.product({
                verb: 'approve',
                taskId,
                interactionToken: secondToken,
            }) as TaskView;
            expect(recovered.status === 'completed' || recovered.status === 'running', JSON.stringify(recovered)).toBe(true);
            await pollProduct(async () => {
                const view = await session.product({verb: 'taskView', taskId}) as TaskView;
                return view.status === 'completed' ? view : null;
            }, 60_000);
            const afterApprove = await session.evaluate<{count: string}>(`return { count: document.body.dataset?.queryCount ?? '' };`);

            const evidence: string[] = [
                `deny did NOT cancel: task stayed ${JSON.stringify(second.status)} with a fresh approval card`,
                `model replanned after deny (deny control message delivered): ${JSON.stringify(capture.sawDeny())}`,
                `irreversible effect NOT executed while denied: queryCount=${JSON.stringify(notMutated.count)} result=${JSON.stringify(notMutated.result)}`,
                `the denied task keeps the workspace reservation (owner=${JSON.stringify(workspace.reservation?.owner)}) until resolved`,
                `a follow-up approval on the fresh card completed and executed exactly once (queryCount=${JSON.stringify(afterApprove.count)})`,
            ];
            const passed = capturedDeny
                && freshCard
                && notMutated.count === '' && notMutated.result === ''
                && (workspace.reservation?.owner === 'task')
                && afterApprove.count === '1';
            matrix.rows.push(passed
                ? passRow('cb.approval.deny-replan', 'item 3: deny does not cancel and replans within the retained loop; approval still executes exactly once', evidence)
                : failRow('cb.approval.deny-replan', 'item 3: deny does not cancel and replans within the retained loop; approval still executes exactly once', 'deny path mis-behaved', evidence));
            expect(passed, JSON.stringify({freshCard, notMutated, workspace, afterApprove, sawDeny: capture.sawDeny()}, null, 2)).toBe(true);
        } finally {
            await session.close();
            await faux.close();
            await fixture.close();
            flushClosedBetaMatrix(matrix);
        }
    });
});