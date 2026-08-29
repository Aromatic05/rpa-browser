import type {DslProgram, DslStmt} from '../../../program/dsl/ast/types';
import type {DebugProgramPatch} from './patches';
import type {DebugProgramView} from './view';

export const buildDebugProgramOverlay = (
    view: DebugProgramView,
    patches: readonly DebugProgramPatch[],
): DslProgram => {
    const body = view.statements
        .filter((entry) => /^body\.\d+$/u.test(entry.path))
        .sort((left, right) => topLevelIndex(left.path) - topLevelIndex(right.path))
        .map((entry) => structuredClone(entry.statement));
    const program: DslProgram = {
        imports: structuredClone([...view.imports]),
        body,
    };
    for (const patch of patches) {
        if (patch.programId !== view.programId) {continue;}
        replaceStatement(program.body, patch.path, patch.statement);
    }
    return program;
};

const topLevelIndex = (path: string): number => Number(path.slice('body.'.length));

const replaceStatement = (
    root: DslStmt[],
    path: string,
    replacement: DslStmt,
): void => {
    const parts = path.split('.');
    if (parts[0] !== 'body') {throw new Error(`invalid DSL program path: ${path}`);}
    let block = root;
    let cursor = 1;
    while (cursor < parts.length) {
        const index = Number(parts[cursor]);
        if (!Number.isInteger(index) || index < 0 || index >= block.length) {
            throw new Error(`invalid DSL program path: ${path}`);
        }
        cursor += 1;
        if (cursor === parts.length) {
            block[index] = structuredClone(replacement);
            return;
        }
        const branch = parts[cursor];
        cursor += 1;
        const statement = block[index];
        if ((branch === 'then' || branch === 'else') && statement.kind === 'if') {
            if (branch === 'else' && !statement.else) {throw new Error(`invalid DSL program path: ${path}`);}
            block = branch === 'then' ? statement.then : statement.else!;
            continue;
        }
        if (branch === 'body' && statement.kind === 'for') {
            block = statement.body;
            continue;
        }
        throw new Error(`invalid DSL program path: ${path}`);
    }
    throw new Error(`invalid DSL program path: ${path}`);
};
