import { normalizeDsl } from '../normalize';
import { parseDsl } from '../parser';
import { validateDsl } from '../validate';
import { linkDsl, type DslEntityRulesResolver } from '../link';
import { DslValidationError } from '../diagnostics/errors';
import { runDsl, type RunDslContext, type RunDslResult } from './run_dsl';
import type { DslDiagnostic } from '../diagnostics';

export type RunDslSourceResult = RunDslResult & {
    diagnostics: DslDiagnostic[];
};

export type ValidateDslSourceResult = {
    diagnostics: DslDiagnostic[];
};

export const validateDslSource = (source: string, entityRulesResolver?: DslEntityRulesResolver): ValidateDslSourceResult => {
    const parsed = parseDsl(source);
    const linked = linkDsl(parsed, entityRulesResolver);
    const normalized = normalizeDsl(linked.program);
    return { diagnostics: [...linked.diagnostics, ...validateDsl(normalized)] };
};

export const runDslSource = async (
    source: string,
    ctx: RunDslContext,
): Promise<RunDslSourceResult> => {
    const parsed = parseDsl(source);
    const linked = linkDsl(parsed, ctx.entityRulesResolver);
    const normalized = normalizeDsl(linked.program);
    const diagnostics = [...linked.diagnostics, ...validateDsl(normalized)];
    if (diagnostics.length > 0) {
        throw new DslValidationError(diagnostics);
    }
    const result = await runDsl(normalized, ctx);
    return {
        ...result,
        diagnostics,
    };
};
