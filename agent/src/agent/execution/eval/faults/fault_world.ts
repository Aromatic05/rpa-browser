import {AGENT_EVAL_WORLD_ERROR_CODES, AgentEvalWorldError} from '../world';
import type {AgentEvalFixtureSpec, AgentEvalWorld, AgentEvalWorldHandle} from '../world';
import {AGENT_FAULT_ERROR_CODES, AgentFaultWorldError} from './contracts';
import type {
    AgentFaultErrorCode,
    AgentFaultEvent,
    AgentFaultEventKind,
    AgentFaultSpec,
    AgentFaultWorld,
    CreateFaultInjectingWorldOptions,
} from './contracts';

type PendingWrite = Readonly<{mode: 'fill' | 'transact', expectedRevision?: number}>;

const isStaleTargetError = (error: unknown): error is AgentEvalWorldError =>
    error instanceof AgentEvalWorldError && error.code === AGENT_EVAL_WORLD_ERROR_CODES.staleTarget;

/**
 * Wrap any committed eval world implementation with an external fault script.
 * The wrapper is the single injection point: production agents and the
 * simulated policy runners only ever see generic port errors carrying
 * worldChanged metadata, never fault-kind-specific logic.
 */
export const createFaultInjectingWorld = (
    base: AgentEvalWorld,
    options: CreateFaultInjectingWorldOptions,
): AgentFaultWorld => {
    const specs: AgentFaultSpec[] = [];
    const attempts = new Map<string, number>();
    const handleEpoch = new WeakMap<object, number>();
    const events: AgentFaultEvent[] = [];
    let sequence = 0;
    let epoch = 1;
    let lastSpec: AgentEvalFixtureSpec | null = null;

    const log = (
        kind: AgentFaultEventKind,
        key: string,
        extra: Partial<Omit<AgentFaultEvent, 'sequence' | 'kind' | 'key'>> = {},
    ): void => {
        sequence += 1;
        events.push(Object.freeze({
            sequence,
            kind,
            key,
            epoch,
            revision: base.revision(),
            ...extra,
        }));
    };

    const trackHandle = <T extends object>(handle: T): T => {
        handleEpoch.set(handle, epoch);
        return handle;
    };

    const nextAttempt = (key: string): number => {
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        return attempt;
    };

    const specFor = (key: string): AgentFaultSpec | undefined =>
        specs.find((candidate) => candidate.targetKey === key);

    const requireLiveHandle = (handle: AgentEvalWorldHandle): void => {
        const createdAt = handleEpoch.get(handle) ?? epoch;
        if (createdAt < epoch) {
            log('fill-rejected', handle.key, {
                worldChanged: false,
                reason: AGENT_FAULT_ERROR_CODES.staleTarget,
            });
            throw new AgentFaultWorldError(
                AGENT_FAULT_ERROR_CODES.staleTarget,
                `handle for ${handle.key} predates page epoch ${epoch}`,
                false,
                base.revision(),
                epoch,
            );
        }
    };

    const staleCheckedFill = async (handle: AgentEvalWorldHandle, value: string): Promise<number> => {
        try {
            return await base.fill(handle, value);
        } catch (error) {
            if (isStaleTargetError(error)) {
                log('fill-rejected', handle.key, {worldChanged: false, reason: error.code});
            }
            throw error;
        }
    };

    const faultError = (
        code: AgentFaultErrorCode,
        message: string,
        worldChanged: boolean,
    ): AgentFaultWorldError =>
        new AgentFaultWorldError(code, message, worldChanged, base.revision(), epoch);

    const applyWrite = async (
        handle: AgentEvalWorldHandle,
        value: string,
        pending: PendingWrite,
    ): Promise<number> => {
        const attempt = nextAttempt(handle.key);
        requireLiveHandle(handle);
        const spec = specFor(handle.key);

        if (spec) {
            switch (spec.kind) {
                case 'epoch-navigation': {
                    if (attempt === (spec.fireOn ?? 1)) {
                        await options.navigate(lastSpec ? {page: lastSpec.page} : {page: 'about:blank'});
                        epoch += 1;
                        log('navigation', handle.key, {worldChanged: true});
                        requireLiveHandle(handle);
                    }
                    break;
                }
                case 'revision-drift': {
                    if (attempt === (spec.fireOn ?? 1)) {
                        await base.drift(handle.key);
                        log('drift', handle.key, {worldChanged: true});
                        await staleCheckedFill(handle, value);
                        throw new Error(`revision-drift fault did not invalidate the handle for ${handle.key}`);
                    }
                    break;
                }
                case 'external-mutation-conflict': {
                    if (attempt === (spec.fireOn ?? 1)) {
                        await base.fill(base.field(handle.key), spec.externalValue ?? 'external');
                        log('external-mutate', handle.key, {
                            value: spec.externalValue ?? 'external',
                            worldChanged: true,
                        });
                        if (pending.mode === 'transact'
                            && pending.expectedRevision !== undefined
                            && base.revision() !== pending.expectedRevision) {
                            log('fill-rejected', handle.key, {
                                value,
                                worldChanged: false,
                                reason: AGENT_FAULT_ERROR_CODES.revisionConflict,
                            });
                            throw faultError(
                                AGENT_FAULT_ERROR_CODES.revisionConflict,
                                `external world mutation moved the revision past expected ${pending.expectedRevision}`,
                                false,
                            );
                        }
                    }
                    break;
                }
                case 'ambiguous-timeout': {
                    if (attempt === (spec.fireOn ?? 1)) {
                        if (spec.effectApplied) {
                            await base.fill(handle, value);
                            log('fill-failed-after-apply', handle.key, {
                                value,
                                worldChanged: true,
                                reason: AGENT_FAULT_ERROR_CODES.postEffectTimeout,
                            });
                            throw faultError(
                                AGENT_FAULT_ERROR_CODES.postEffectTimeout,
                                `post-effect timeout on ${handle.key}; the effect may have landed`,
                                true,
                            );
                        }
                        log('fill-failed-no-effect', handle.key, {
                            value,
                            worldChanged: false,
                            reason: AGENT_FAULT_ERROR_CODES.postEffectTimeout,
                        });
                        throw faultError(
                            AGENT_FAULT_ERROR_CODES.postEffectTimeout,
                            `post-effect timeout on ${handle.key}; the effect may not have landed`,
                            false,
                        );
                    }
                    break;
                }
                case 'mutation-report-error': {
                    if (attempt === (spec.fireOn ?? 1)) {
                        await base.fill(handle, value);
                        log('fill-failed-after-apply', handle.key, {
                            value,
                            worldChanged: true,
                            reason: AGENT_FAULT_ERROR_CODES.postEffectError,
                        });
                        throw faultError(
                            AGENT_FAULT_ERROR_CODES.postEffectError,
                            `mutation on ${handle.key} reported failure after the effect landed`,
                            true,
                        );
                    }
                    break;
                }
                case 'transactional-restore': {
                    if (attempt === (spec.fireOn ?? 1)) {
                        const partial = spec.partialValue ?? `${value}~partial`;
                        await base.fill(handle, partial);
                        log('fill-failed-after-apply', handle.key, {
                            value: partial,
                            worldChanged: true,
                            reason: AGENT_FAULT_ERROR_CODES.partialApply,
                        });
                        throw faultError(
                            AGENT_FAULT_ERROR_CODES.partialApply,
                            `mutation on ${handle.key} left a stray partial effect`,
                            true,
                        );
                    }
                    break;
                }
                case 'compensation-partial-restore': {
                    const restoreAttempt = attempt === (spec.fireOn ?? 1) + 1;
                    if (attempt === (spec.fireOn ?? 1) || restoreAttempt) {
                        const stray = restoreAttempt
                            ? spec.halfRestoredValue ?? 'HalfRestored'
                            : spec.partialValue ?? `${value}~partial`;
                        await base.fill(handle, stray);
                        log('fill-failed-after-apply', handle.key, {
                            value: stray,
                            worldChanged: true,
                            reason: restoreAttempt
                                ? AGENT_FAULT_ERROR_CODES.partialRestore
                                : AGENT_FAULT_ERROR_CODES.partialApply,
                        });
                        throw faultError(
                            restoreAttempt ? AGENT_FAULT_ERROR_CODES.partialRestore : AGENT_FAULT_ERROR_CODES.partialApply,
                            restoreAttempt
                                ? `compensation on ${handle.key} only partially restored the world`
                                : `mutation on ${handle.key} left a stray partial effect`,
                            true,
                        );
                    }
                    break;
                }
            }
        }

        const writeHandle = pending.mode === 'transact' ? base.field(handle.key) : handle;
        const revision = await staleCheckedFill(writeHandle, value);
        log('fill-applied', handle.key, {value, worldChanged: true});
        return revision;
    };

    return Object.freeze({
        base,
        arm: (spec: AgentFaultSpec) => {
            specs.push(Object.freeze({...spec}));
        },
        armed: () => Object.freeze(specs.map((spec) => ({...spec}))),
        events: () => Object.freeze(events.map((event) => ({...event}))),
        epoch: () => epoch,
        reseed: (seed: number) => {
            base.reseed(seed);
        },
        random: () => base.random(),
        load: async (spec: AgentEvalFixtureSpec) => {
            specs.length = 0;
            attempts.clear();
            events.length = 0;
            sequence = 0;
            epoch = 1;
            lastSpec = spec;
            await base.load(spec);
            log('load', spec.page, {worldChanged: true});
        },
        field: (key: string) => trackHandle(base.field(key)),
        read: async (handle: AgentEvalWorldHandle) => {
            const value = await base.read(handle);
            log('read', handle.key, {value: value ?? ''});
            return value;
        },
        fill: (handle: AgentEvalWorldHandle, value: string) => applyWrite(handle, value, {mode: 'fill'}),
        transact: (handle: AgentEvalWorldHandle, value: string, expectedRevision: number) =>
            applyWrite(handle, value, {mode: 'transact', expectedRevision}),
        click: async (handle: AgentEvalWorldHandle) => {
            nextAttempt(handle.key);
            requireLiveHandle(handle);
            const revision = await base.click(handle);
            log('click-applied', handle.key, {worldChanged: true});
            return revision;
        },
        drift: async (key: string) => {
            await base.drift(key);
            log('drift', key, {worldChanged: true});
        },
        refresh: (key: string) => {
            const handle = trackHandle(base.field(key));
            log('rebind', key);
            return handle;
        },
        revision: () => base.revision(),
    });
};
