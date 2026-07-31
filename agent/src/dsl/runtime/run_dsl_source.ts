import { normalizeDsl } from '../normalize';
import { parseDsl } from '../parser';
import { validateDsl } from '../validate';
import { DslValidationError } from '../diagnostics/errors';
import { runDsl, type RunDslContext, type RunDslResult } from './run_dsl';
import type { DslDiagnostic } from '../diagnostics';

export type RunDslSourceResult = RunDslResult & {
    diagnostics: DslDiagnostic[];
};

export type ValidateDslSourceResult = {
    diagnostics: DslDiagnostic[];
};

export const validateDslSource = (source: string): ValidateDslSourceResult => {
    const parsed = parseDsl(source);
    const normalized = normalizeDsl(parsed);
    return { diagnostics: validateDsl(normalized) };
};

export const runDslSource = async (
    source: string,
    ctx: RunDslContext,
): Promise<RunDslSourceResult> => {
    const parsed = parseDsl(source);
    const normalized = normalizeDsl(parsed);
    const diagnostics = validateDsl(normalized);
    if (diagnostics.length > 0) {
        throw new DslValidationError(diagnostics);
    }
    const result = await runDsl(normalized, ctx);
    return {
        ...result,
        diagnostics,
    };
};
