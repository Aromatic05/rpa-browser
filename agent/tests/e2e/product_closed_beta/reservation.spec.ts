import {test, expect} from '@playwright/test';
import {startClosedBetaSession, pollProduct} from '../../helpers/product_closed_beta/session';
import {startClosedBetaFauxModel, wireTool, wireText, type ClosedBetaScript} from '../../helpers/product_closed_beta/faux_model_server';
import {
    flushClosedBetaMatrix,
    newClosedBetaMatrix,
    passRow,
    failRow,
    type ClosedBetaMatrix,
} from '../../helpers/product_closed_beta/matrix';

/**
 * Closed-beta acceptance item 7: the workspace reservation prevents Task /
 * Teach / Annotate overlap, and takeover guidance reuses the Task reservation.
 */

const matrix: ClosedBetaMatrix = newClosedBetaMatrix();

const parkScript = (): ClosedBetaScript => (ctx) => {
    if (!ctx.lastTool) {
        return wireTool('agent.request_interaction', {
            kind: 'takeover',
            reason: '2FA required',
            scope: 'workspace',
            guidanceModes: ['manual', 'teach'],
        });
    }
    return wireText('done');
};

type WorkspaceView = {
    workspace?: string;
    reservation?: {owner?: string; ownerTaskId?: string; humanControl?: string; teachKind?: string};
    activeTask?: {taskId?: string};
};

test.describe('closed-beta: workspace activity reservation', () => {
    test.describe.configure({mode: 'serial', timeout: 300_000});

    test('Task / Teach / Annotate overlap is rejected; takeover guidance reuses the Task reservation', async () => {
        const faux = await startClosedBetaFauxModel({script: parkScript()});
        const session = await startClosedBetaSession({modelServer: faux});
        try {
            const none0 = await session.product({verb: 'workspaceView'}) as WorkspaceView;
            expect(none0.reservation?.owner).toBe('none');

            const teach = await session.product({verb: 'beginAuthoring', activity: 'teach', teachKind: 'procedure'}) as WorkspaceView;
            expect(teach.reservation?.owner, JSON.stringify(teach)).toBe('standalone_teach');

            let teachConflictCode = '';
            try {
                await session.product({verb: 'beginAuthoring', activity: 'annotate'});
            } catch (error) {
                teachConflictCode = extractProductCode(error);
            }
            expect(teachConflictCode).toBe('ERR_ACTIVITY_CONFLICT');

            const endedSave = await session.product({verb: 'endAuthoring', outcome: 'saved'}) as WorkspaceView;
            expect(endedSave.reservation?.owner).toBe('none');

            const annotate = await session.product({verb: 'beginAuthoring', activity: 'annotate'}) as WorkspaceView;
            expect(annotate.reservation?.owner).toBe('standalone_annotate');
            const annotateConflict = await session.product({verb: 'beginAuthoring', activity: 'teach', teachKind: 'recovery'}).catch(() => null);
            if (annotateConflict !== null) {
                matrix.rows.push(failRow('cb.reservation.overlap', 'item 7: reservation blocks Task/Teach/Annotate overlap', 'beginAuthoring(teach) did not conflict while annotating'));
                throw new Error('beginAuthoring(teach) must conflict while annotating');
            }
            const endedDiscard = await session.product({verb: 'endAuthoring', outcome: 'discarded'}) as WorkspaceView;
            expect(endedDiscard.reservation?.owner).toBe('none');

            const started = await session.product({verb: 'startTask', prompt: 'take a captive task'}) as {taskId?: string; status?: string};
            expect(started.taskId, JSON.stringify(started)).toBeTruthy();
            const taskId = started.taskId as string;

            const latestToken = async (): Promise<string> => {
                const view = await session.product({verb: 'taskView', taskId}) as {
                    status?: string;
                    interaction?: {kind?: string; interactionToken?: string};
                };
                return view.interaction?.interactionToken as string;
            };

            const waiting = await pollProduct(async () => {
                const token = await latestToken();
                return token ? {token} : null;
            }, 60_000);
            expect(waiting.token).toBeTruthy();

            const withTask = await session.product({verb: 'workspaceView'}) as WorkspaceView;
            expect(withTask.reservation?.owner).toBe('task');

            const conflictDuringTask = await session.product({verb: 'beginAuthoring', activity: 'annotate'}).catch(() => null);
            if (conflictDuringTask !== null) {
                matrix.rows.push(failRow('cb.reservation.overlap', 'item 7: reservation blocks Task/Teach/Annotate overlap', 'beginAuthoring did not conflict while a task owns the reservation'));
                throw new Error('beginAuthoring must conflict while a task owns the reservation');
            }

            const guidance = await session.product({
                verb: 'takeover',
                taskId,
                interactionToken: await latestToken(),
                mode: 'teach',
            }) as WorkspaceView;
            const reservationDuringGuidance = guidance.reservation
                || (await session.product({verb: 'workspaceView'}) as WorkspaceView).reservation;
            const sameTaskReservation = reservationDuringGuidance?.owner === 'task'
                && reservationDuringGuidance?.ownerTaskId === taskId
                && reservationDuringGuidance?.humanControl === 'teach';

            const returned = await session.product({
                verb: 'returnControl',
                taskId,
                interactionToken: await latestToken(),
                mode: 'teach',
            }) as {status?: string};
            const afterReturn = await session.product({verb: 'workspaceView'}) as WorkspaceView;
            const controlReturned = afterReturn.reservation?.humanControl === 'none';

            const evidence: string[] = [
                `standalone teach/annotate acquire+release (saved/discarded)`,
                `task takeover guidance kept owner=task ownerTaskId=${JSON.stringify(taskId)} humanControl=teach (${JSON.stringify(sameTaskReservation)})`,
                `return control cleared humanControl (${JSON.stringify(controlReturned)}); task terminal=${JSON.stringify(returned?.status)}`,
                `conflicts raised product code ERR_ACTIVITY_CONFLICT in teach/annotate/task overlap`,
            ];
            const passed = sameTaskReservation && controlReturned && teachConflictCode === 'ERR_ACTIVITY_CONFLICT';
            matrix.rows.push(passed
                ? passRow('cb.reservation.overlap', 'item 7: reservation prevents Task/Teach/Annotate overlap; takeover reuses the Task reservation', evidence)
                : failRow('cb.reservation.overlap', 'item 7: reservation prevents Task/Teach/Annotate overlap; takeover reuses the Task reservation', 'reservation contract mis-behaved', evidence));
            expect(passed, JSON.stringify({sameTaskReservation, controlReturned, teachConflictCode}, null, 2)).toBe(true);
        } finally {
            await session.close();
            await faux.close();
            flushClosedBetaMatrix(matrix);
        }
    });
});

const extractProductCode = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    const detail = /"productCode":"([A-Z_]+)"/u.exec(message);
    if (detail) {
        return detail[1];
    }
    const match = /ERR_[A-Z_]+/u.exec(message);
    return match ? match[0] : message;
};