import type {CredentialResolver} from '../../../../security/credentials';
import type {StepResult, StepUnion} from '../../../runner/steps/types';
import type {StepExecutionPort} from '../run_dsl';
import {resolveCredentialRefsDeep} from './credential_refs';

export type CredentialResolvingStepExecutorOptions = {
    resolver: CredentialResolver;
    execute: StepExecutionPort['execute'];
};

const credentialFailureResult = (
    error: unknown,
    step: StepUnion,
): {stepId: string; ok: false; error: NonNullable<StepResult['error']>} => {
    const code = error && typeof error === 'object' && typeof (error as {code?: unknown}).code === 'string'
        ? (error as {code: string}).code
        : 'ERR_SECURITY_CREDENTIAL_UNRESOLVABLE';
    const message = error && typeof error === 'object' && typeof (error as {message?: unknown}).message === 'string'
        ? (error as {message: string}).message
        : typeof error === 'string'
            ? error
            : `credential resolution failed for step: ${step.id}`;
    return {
        stepId: step.id,
        ok: false,
        error: {
            code,
            message,
            details: {stepId: step.id, stepName: step.name},
        },
    };
};

export const createCredentialResolvingStepExecutor = (
    options: CredentialResolvingStepExecutorOptions,
): StepExecutionPort['execute'] => async (step) => {
    let args: unknown;
    try {
        args = await resolveCredentialRefsDeep(step.args, options.resolver.resolve);
    } catch (error) {
        return credentialFailureResult(error, step);
    }
    return await options.execute({...step, args} as StepUnion);
};