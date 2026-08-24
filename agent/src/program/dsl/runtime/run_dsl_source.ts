import { normalizeDsl } from '../normalize';
import {parseDslDocument} from '../parser';
import { validateDsl } from '../validate';
import { linkDsl, type DslEntityRulesResolver, type DslResolveResolver } from '../link';
import { DslValidationError } from '../diagnostics/errors';
import { runDsl, type RunDslContext, type RunDslResult } from './run_dsl';
import type { DslDiagnostic } from '../diagnostics';
import type {DslProgram} from '../ast/types';
import type {DslSourceMap} from '../parser/source_map';
import type {StepResolve} from '../../../runner/steps/types';

export type RunDslSourceResult = RunDslResult & {
    diagnostics: DslDiagnostic[];
};

export type CompiledDslSource = Readonly<{
    program: DslProgram;
    sourceMap: DslSourceMap;
    diagnostics: readonly DslDiagnostic[];
    stepResolves: Readonly<Record<string, StepResolve>>;
}>;

export type ValidateDslSourceResult = {
    diagnostics: DslDiagnostic[];
};

export const validateDslSource = (
    source: string,
    entityRulesResolver?: DslEntityRulesResolver,
    resolveResolver?: DslResolveResolver,
    options: {allowFailureRoot?: boolean} = {},
): ValidateDslSourceResult => {
    try {
        return {
            diagnostics: [...compileDslSource(source, entityRulesResolver, resolveResolver, options).diagnostics],
        };
    } catch (error) {
        if (error instanceof DslValidationError) {
            return {diagnostics: [...error.diagnostics]};
        }
        throw error;
    }
};

export const runDslSource = async (
    source: string,
    ctx: RunDslContext,
): Promise<RunDslSourceResult> => {
    const compiled = compileDslSource(
        source,
        ctx.entityRulesResolver,
        ctx.resolveResolver,
        {allowFailureRoot: ctx.failure !== undefined},
    );
    await ctx.debugPort?.onProgram?.(Object.freeze({
        programId: ctx.debugProgramId ?? 'main',
        source,
        program: structuredClone(compiled.program),
        sourceMap: structuredClone(compiled.sourceMap),
    }));
    const result = await runDsl(compiled.program, {
        ...ctx,
        stepResolves: {...compiled.stepResolves},
        debugSourceMap: compiled.sourceMap,
    });
    return {
        ...result,
        diagnostics: [...compiled.diagnostics],
    };
};

export const compileDslSource = (
    source: string,
    entityRulesResolver?: DslEntityRulesResolver,
    resolveResolver?: DslResolveResolver,
    options: {allowFailureRoot?: boolean} = {},
): CompiledDslSource => {
    const parsed = parseDslDocument(source);
    const linked = linkDsl(parsed.program, entityRulesResolver, resolveResolver);
    if (linked.diagnostics.length > 0) {
        throw new DslValidationError(linked.diagnostics);
    }
    const normalized = normalizeDsl(linked.program);
    const diagnostics = validateDsl(normalized, options);
    if (diagnostics.length > 0) {
        throw new DslValidationError(diagnostics);
    }
    return Object.freeze({
        program: normalized,
        sourceMap: parsed.sourceMap,
        diagnostics: Object.freeze([...diagnostics]),
        stepResolves: Object.freeze({...linked.stepResolves}),
    });
};
