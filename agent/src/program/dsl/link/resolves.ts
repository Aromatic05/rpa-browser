import type { DslImport, ResolveActStmt } from '../ast/types';
import type { DslDiagnostic } from '../diagnostics';
import { createDiagnostic } from '../diagnostics';
import type { StepResolve } from '../../../runner/steps/types';
import type { DslResolveResolver } from './types';

export type ResolveBundle = {
    bundleName: string;
    resolves: Record<string, StepResolve>;
};

export type ResolveLinkContext = {
    bundles: ReadonlyMap<string, ResolveBundle>;
    failedAliases: ReadonlySet<string>;
    stepResolves: Record<string, StepResolve>;
};

export const resolveDslResolveImports = (
    imports: readonly DslImport[],
    resolver: DslResolveResolver | undefined,
    diagnostics: DslDiagnostic[],
): ResolveLinkContext => {
    const bundles = new Map<string, ResolveBundle>();
    const failedAliases = new Set<string>();
    const stepResolves: Record<string, StepResolve> = {};

    imports.forEach((imported, index) => {
        if (imported.kind !== 'resolves') {return;}
        if (!resolver) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_RESOLVE_RESOLVER_REQUIRED',
                `resolves resolver is required for bundle: ${imported.bundleName} (alias ${imported.alias})`,
                `imports.${index}`,
            ));
            failedAliases.add(imported.alias);
            return;
        }
        const resolution = resolver.resolveBundle(imported.bundleName);
        for (const diagnostic of resolution.diagnostics) {
            diagnostics.push(createDiagnostic(
                diagnostic.code,
                `${diagnostic.message} (bundle ${imported.bundleName}, alias ${imported.alias})`,
                `imports.${index}`,
            ));
        }
        if (!resolution.resolves) {
            if (resolution.diagnostics.length === 0) {
                diagnostics.push(createDiagnostic(
                    'ERR_DSL_RESOLVE_BUNDLE_NOT_FOUND',
                    `resolve bundle not found: ${imported.bundleName} (alias ${imported.alias})`,
                    `imports.${index}`,
                ));
            }
            failedAliases.add(imported.alias);
            return;
        }
        bundles.set(imported.alias, {bundleName: imported.bundleName, resolves: resolution.resolves});
    });

    return {bundles, failedAliases, stepResolves};
};

export const linkResolveAction = (
    stmt: ResolveActStmt,
    context: ResolveLinkContext,
    diagnostics: DslDiagnostic[],
    path: string,
): ResolveActStmt => {
    const bundle = context.bundles.get(stmt.target.alias);
    const ref = `${stmt.target.alias}.${stmt.target.symbol}`;
    if (!bundle) {
        if (context.failedAliases.has(stmt.target.alias)) {return stmt;}
        diagnostics.push(createDiagnostic(
            'ERR_DSL_RESOLVE_BUNDLE_NOT_FOUND',
            `resolve alias is not linked: ${stmt.target.alias}`,
            `${path}.target`,
        ));
        return stmt;
    }
    const resolve = (bundle.resolves as Record<string, StepResolve | undefined>)[stmt.target.symbol];
    if (!resolve) {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_RESOLVE_SYMBOL_NOT_FOUND',
            `resolve symbol not found: ${bundle.bundleName}.${ref}`,
            `${path}.target`,
        ));
        return stmt;
    }
    const resolveId = `dsl:${stmt.target.alias}:${stmt.target.symbol}`;
    context.stepResolves[resolveId] = resolve;
    return {...stmt, target: {...stmt.target, bundleName: bundle.bundleName}, resolveId};
};
