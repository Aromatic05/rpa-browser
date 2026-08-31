import crypto from 'node:crypto';
import {describeWorldView} from '../../worldview/descriptor';
import type {WorldView} from '../../worldview/contracts';
import type {DebugSavepoint, DebugTransaction, DebugTransactionState} from './contracts';

const assertEffectPosition = (value: number): void => {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`transaction effect sequence must be a non-negative integer: ${value}`);
    }
};

export const createDebugTransaction = (
    baseline: WorldView,
    seed?: DebugTransactionState,
): DebugTransaction => {
    const id = seed?.id ?? crypto.randomUUID();
    const savepoints: Array<{savepoint: DebugSavepoint; world: WorldView; visible: boolean}> = seed
        ? Array.from(structuredClone(seed.savepoints))
        : [];

    const createSavepoint = (
        world: WorldView,
        effectSequence: number,
        name: string | undefined,
        visible: boolean,
    ): DebugSavepoint => {
        assertEffectPosition(effectSequence);
        const normalizedName = name?.trim();
        if (name !== undefined && !normalizedName) {
            throw new Error('transaction savepoint name must not be empty');
        }
        const savepoint = Object.freeze({
            id: crypto.randomUUID(),
            ...(normalizedName === undefined ? {} : {name: normalizedName}),
            effectSequence,
            world: describeWorldView(world),
        });
        savepoints.push({savepoint, world, visible});
        return savepoint;
    };

    return {
        id,
        baseline,
        savepoint: (world, effectSequence, name) => createSavepoint(world, effectSequence, name, true),
        internalSavepoint: (world, effectSequence) => createSavepoint(world, effectSequence, undefined, false),
        promoteSavepoint: (savepointId, name) => {
            const entry = savepoints.find((candidate) => candidate.savepoint.id === savepointId);
            if (!entry) {throw new Error(`transaction savepoint not found: ${savepointId}`);}
            const normalizedName = name?.trim();
            if (name !== undefined && !normalizedName) {
                throw new Error('transaction savepoint name must not be empty');
            }
            entry.savepoint = Object.freeze({
                ...entry.savepoint,
                ...(normalizedName === undefined ? {} : {name: normalizedName}),
            });
            entry.visible = true;
            return entry.savepoint;
        },
        readSavepoint: (savepointId) => savepoints.find((entry) => entry.savepoint.id === savepointId) ?? null,
        truncateSavepoints: (savepointId) => {
            const index = savepoints.findIndex((entry) => entry.savepoint.id === savepointId);
            if (index < 0) {throw new Error(`transaction savepoint not found: ${savepointId}`);}
            savepoints.splice(index + 1);
        },
        snapshot: (current, effectCount) => {
            assertEffectPosition(effectCount);
            return Object.freeze({
                id,
                baseline: describeWorldView(baseline),
                current: describeWorldView(current),
                effectCount,
                savepoints: Object.freeze(savepoints.filter((entry) => entry.visible).map((entry) => entry.savepoint)),
            });
        },
        exportState: () => Object.freeze({
            id,
            baseline: structuredClone(baseline),
            savepoints: structuredClone(savepoints),
        }),
    };
};
