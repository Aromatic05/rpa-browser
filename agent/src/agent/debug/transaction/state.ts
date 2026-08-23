import crypto from 'node:crypto';
import {describeWorldView} from '../../worldview/descriptor';
import type {WorldView} from '../../worldview/contracts';
import type {DebugSavepoint, DebugTransaction} from './contracts';

const assertEffectPosition = (value: number): void => {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`transaction effect sequence must be a non-negative integer: ${value}`);
    }
};

export const createDebugTransaction = (baseline: WorldView): DebugTransaction => {
    const id = crypto.randomUUID();
    const savepoints: DebugSavepoint[] = [];

    return {
        id,
        baseline,
        savepoint: (world, effectSequence, name) => {
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
            savepoints.push(savepoint);
            return savepoint;
        },
        snapshot: (current, effectCount) => {
            assertEffectPosition(effectCount);
            return Object.freeze({
                id,
                baseline: describeWorldView(baseline),
                current: describeWorldView(current),
                effectCount,
                savepoints: Object.freeze([...savepoints]),
            });
        },
    };
};
