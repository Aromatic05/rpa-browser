import type {
    ActivityHumanControl,
    ActivityOwnerKind,
    ActivityReservationPort,
    ActivityReservationSnapshot,
} from '../service/session/types';

export type WorkspaceActivityOwner =
    | Readonly<{kind: 'none'}>
    | Readonly<{kind: 'task'; taskId: string}>
    | Readonly<{kind: 'standalone_teach'; teachKind: 'procedure' | 'recovery' | 'demonstration'}>
    | Readonly<{kind: 'standalone_annotate'}>
    | Readonly<{kind: 'playback'}>;

export type WorkspaceHumanControl = ActivityHumanControl;

export type WorkspaceActivityAcquire =
    | Readonly<{ok: true}>
    | Readonly<{ok: false; reason: 'activity-conflict'}>;

export type WorkspaceActivitySetControl =
    | Readonly<{ok: true}>
    | Readonly<{ok: false; reason: 'not-task-owner'}>;

/**
 * WorkspaceActivityReservation — the product-level workspace activity ownership.
 *
 * Higher than any single execution lease: it spans a Task's `running` plus
 * `waiting_for_user`, the generic recording review window, and standalone
 * Teach/Annotate orchestration. Conflicts are rejected, never queued. The
 * reservation is held by the session manager for Task starts and released on
 * terminal settle; standalone authoring/replay activities acquire the same
 * reservation through the product controller.
 */
export type WorkspaceActivityReservation = Readonly<{
    acquire: (owner: WorkspaceActivityOwner) => WorkspaceActivityAcquire;
    release: (owner: WorkspaceActivityOwner) => boolean;
    setHumanControl: (taskId: string, control: WorkspaceHumanControl) => WorkspaceActivitySetControl;
    read: () => ActivityReservationSnapshot;
    toPort: () => ActivityReservationPort;
}>;

const ownerKindOf = (owner: WorkspaceActivityOwner): ActivityOwnerKind => owner.kind;

const SNAPSHOT_NONE: ActivityReservationSnapshot = Object.freeze({
    owner: 'none',
    humanControl: 'none',
});

export const createWorkspaceActivityReservation = (): WorkspaceActivityReservation => {
    let active: WorkspaceActivityOwner = {kind: 'none'};
    let humanControl: WorkspaceHumanControl = 'none';

    const read = (): ActivityReservationSnapshot => {
        if (active.kind === 'none') {return SNAPSHOT_NONE;}
        if (active.kind === 'task') {
            return Object.freeze({
                owner: 'task',
                ownerTaskId: active.taskId,
                humanControl,
            });
        }
        return Object.freeze({
            owner: ownerKindOf(active),
            humanControl: 'none',
        });
    };

    const matches = (owner: WorkspaceActivityOwner): boolean => {
        if (active.kind === 'none') {return false;}
        if (active.kind !== owner.kind) {return false;}
        if (active.kind === 'task' && owner.kind === 'task') {return active.taskId === owner.taskId;}
        return true;
    };

    const reservation: WorkspaceActivityReservation = {
        acquire: (owner) => {
            if (owner.kind === 'none') {return {ok: false, reason: 'activity-conflict'};}
            if (active.kind !== 'none') {return {ok: false, reason: 'activity-conflict'};}
            active = owner;
            if (owner.kind === 'task') {humanControl = 'none';}
            return {ok: true};
        },
        release: (owner) => {
            if (owner.kind === 'none') {return false;}
            if (!matches(owner)) {return false;}
            active = {kind: 'none'};
            humanControl = 'none';
            return true;
        },
        setHumanControl: (taskId, control) => {
            if (active.kind !== 'task' || active.taskId !== taskId) {
                return {ok: false, reason: 'not-task-owner'};
            }
            humanControl = control;
            return {ok: true};
        },
        read,
        toPort: () => ({
            acquireTask: (taskId) => reservation.acquire({kind: 'task', taskId}).ok,
            releaseTask: (taskId) => reservation.release({kind: 'task', taskId}),
            setHumanControl: (taskId, control) => reservation.setHumanControl(taskId, control).ok,
            snapshot: () => reservation.read(),
        }),
    };

    return reservation;
};