import type {DslStmt} from '../../../dsl/ast/types';
import type {DslDiagnostic} from '../../../dsl/diagnostics';
import {linkDsl, type DslEntityRulesResolver, type DslResolveResolver} from '../../../dsl/link';
import {normalizeDsl} from '../../../dsl/normalize';
import {parseDsl} from '../../../dsl/parser';

export type CompileStatementPatchResult =
    | Readonly<{ok: true; statement: DslStmt}>
    | Readonly<{
        ok: false;
        error: Readonly<{
            code: 'ERR_DSL_PATCH_INVALID' | 'ERR_DSL_PATCH_UNSUPPORTED';
            message: string;
            diagnostics?: readonly DslDiagnostic[];
        }>;
    }>;

export const compileStatementPatch = (
    originalSource: string,
    patchSource: string,
    entityRulesResolver?: DslEntityRulesResolver,
    resolveResolver?: DslResolveResolver,
): CompileStatementPatchResult => {
    try {
        const original = parseDsl(originalSource);
        const imports = original.imports ?? [];
        const source = [
            ...imports.map(renderImport),
            patchSource.trim(),
        ].filter(Boolean).join('\n');
        const parsed = parseDsl(source);
        if ((parsed.imports?.length ?? 0) !== imports.length) {
            return invalid('statement patch cannot add or replace imports');
        }
        const linked = linkDsl(parsed, entityRulesResolver, resolveResolver);
        if (linked.diagnostics.length > 0) {
            return {
                ok: false,
                error: {
                    code: 'ERR_DSL_PATCH_INVALID',
                    message: 'statement patch could not be linked',
                    diagnostics: structuredClone(linked.diagnostics),
                },
            };
        }
        const normalized = normalizeDsl(linked.program);
        if (normalized.body.length !== 1) {
            return invalid('statement patch must contain exactly one executable statement');
        }
        const statement = normalized.body[0];
        if (statement.kind === 'resolve_act') {
            return {
                ok: false,
                error: {
                    code: 'ERR_DSL_PATCH_UNSUPPORTED',
                    message: 'resolve-based statement patches require a dynamic resolve sidecar and are not supported',
                },
            };
        }
        return {ok: true, statement: structuredClone(statement)};
    } catch (error) {
        return invalid(error instanceof Error ? error.message : 'invalid statement patch');
    }
};

const renderImport = (value: NonNullable<ReturnType<typeof parseDsl>['imports']>[number]): string =>
    value.kind === 'entity_rules'
        ? `use entity_rules "${value.profileName}" as ${value.alias}`
        : `use resolves "${value.bundleName}" as ${value.alias}`;

const invalid = (message: string): CompileStatementPatchResult => ({
    ok: false,
    error: {code: 'ERR_DSL_PATCH_INVALID', message},
});
