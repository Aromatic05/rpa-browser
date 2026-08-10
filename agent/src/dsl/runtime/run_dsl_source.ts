import { normalizeDsl } from '../normalize';
import { parseDsl } from '../parser';
import { validateDsl } from '../validate';
import { linkDsl, type DslEntityRulesResolver, type DslResolveResolver } from '../link';
import { DslValidationError } from '../diagnostics/errors';
import { runDsl, type RunDslContext, type RunDslResult } from './run_dsl';
import type { DslDiagnostic } from '../diagnostics';

export type RunDslSourceResult = RunDslResult & {
    diagnostics: DslDiagnostic[];
};

export type ValidateDslSourceResult = {
    diagnostics: DslDiagnostic[];
};

export const validateDslSource = (
    source: string,
    entityRulesResolver?: DslEntityRulesResolver,
    resolveResolver?: DslResolveResolver,
    options: {allowFailureRoot?: boolean} = {},
): ValidateDslSourceResult => {
    const parsed = parseDsl(source);
    const linked = linkDsl(parsed, entityRulesResolver, resolveResolver);
    if (linked.diagnostics.length > 0) {
        return {diagnostics: linked.diagnostics};
    }
    const normalized = normalizeDsl(linked.program);
    return {diagnostics: validateDsl(normalized, options)};
};

export const runDslSource = async (
    source: string,
    ctx: RunDslContext,
): Promise<RunDslSourceResult> => {
    const parsed = parseDsl(source);
    const linked = linkDsl(parsed, ctx.entityRulesResolver, ctx.resolveResolver);
    if (linked.diagnostics.length > 0) {
        throw new DslValidationError(linked.diagnostics);
    }
    const normalized = normalizeDsl(linked.program);
    const diagnostics = validateDsl(normalized, {allowFailureRoot: ctx.failure !== undefined});
    if (diagnostics.length > 0) {
        throw new DslValidationError(diagnostics);
    }
    const result = await runDsl(normalized, {...ctx, stepResolves: linked.stepResolves});
    return {
        ...result,
        diagnostics,
    };
};
