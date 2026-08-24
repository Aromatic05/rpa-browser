import type {DslImport, DslProgram, DslStmt} from '../../../program/dsl/ast/types';
import type {DslProgramEvent} from '../../../program/dsl/debug/contracts';
import type {DslSourceLocation} from '../../../program/dsl/parser/source_map';

export type DebugProgramStatement = Readonly<{
    path: string;
    statement: DslStmt;
    source?: DslSourceLocation;
}>;

export type DebugProgramView = Readonly<{
    programId: string;
    source: string;
    imports: readonly DslImport[];
    statements: readonly DebugProgramStatement[];
}>;

export const buildDebugProgramView = (event: DslProgramEvent): DebugProgramView => Object.freeze({
    programId: event.programId,
    source: event.source,
    imports: Object.freeze(structuredClone(event.program.imports ?? [])),
    statements: Object.freeze(flattenStatements(event.program, event.sourceMap)),
});

const flattenStatements = (
    program: DslProgram,
    sourceMap: DslProgramEvent['sourceMap'],
): DebugProgramStatement[] => {
    const out: DebugProgramStatement[] = [];
    visit(program.body, 'body', sourceMap, out);
    return out;
};

const visit = (
    body: readonly DslStmt[],
    blockPath: string,
    sourceMap: DslProgramEvent['sourceMap'],
    out: DebugProgramStatement[],
): void => {
    body.forEach((statement, index) => {
        const path = `${blockPath}.${index}`;
        const source = Object.prototype.hasOwnProperty.call(sourceMap, path)
            ? sourceMap[path]
            : undefined;
        out.push(Object.freeze({
            path,
            statement: structuredClone(statement),
            ...(source ? {source: structuredClone(source)} : {}),
        }));
        if (statement.kind === 'if') {
            visit(statement.then, `${path}.then`, sourceMap, out);
            if (statement.else) {visit(statement.else, `${path}.else`, sourceMap, out);}
        }
        if (statement.kind === 'for') {
            visit(statement.body, `${path}.body`, sourceMap, out);
        }
    });
};
