import type {DslProgram} from '../ast/types';

export type DslSourceLocation = Readonly<{
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
}>;

export type DslSourceMap = Readonly<Record<string, DslSourceLocation>>;

export type DslParsedDocument = Readonly<{
    program: DslProgram;
    sourceMap: DslSourceMap;
}>;
