import type {DebugProgramPatch} from './patches';
import type {DebugProgramView} from './view';

export class DebugProgramMaterializationError extends Error {}

type SourceEdit = Readonly<{
    start: number;
    end: number;
    replacement: string;
}>;

export const materializeDebugProgramSource = (
    program: DebugProgramView,
    patches: readonly DebugProgramPatch[],
): string => {
    const statements = new Map(program.statements.map((statement) => [statement.path, statement]));
    const lineOffsets = buildLineOffsets(program.source);
    const edits = patches
        .filter((patch) => patch.programId === program.programId)
        .map((patch): SourceEdit => {
            const target = statements.get(patch.path);
            if (!target) {
                throw new DebugProgramMaterializationError(`program patch target not found: ${program.programId}:${patch.path}`);
            }
            if (!target.source) {
                throw new DebugProgramMaterializationError(`program patch source location unavailable: ${program.programId}:${patch.path}`);
            }
            const start = sourceOffset(lineOffsets, target.source.line, target.source.column, program.source.length);
            const end = sourceOffset(lineOffsets, target.source.endLine, target.source.endColumn, program.source.length);
            if (end < start) {
                throw new DebugProgramMaterializationError(`invalid program patch source range: ${program.programId}:${patch.path}`);
            }
            const indentation = ' '.repeat(Math.max(0, target.source.column - 1));
            const replacement = indentContinuationLines(patch.source.trim(), indentation);
            return Object.freeze({start, end, replacement});
        })
        .sort((left, right) => right.start - left.start || right.end - left.end);

    assertNonOverlapping(edits, program.programId);
    let source = program.source;
    for (const edit of edits) {
        source = `${source.slice(0, edit.start)}${edit.replacement}${source.slice(edit.end)}`;
    }
    return source;
};

const buildLineOffsets = (source: string): readonly number[] => {
    const offsets = [0];
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === '\n') {offsets.push(index + 1);}
    }
    return offsets;
};

const sourceOffset = (
    lineOffsets: readonly number[],
    line: number,
    column: number,
    sourceLength: number,
): number => {
    const lineStart = lineOffsets[line - 1];
    if (lineStart === undefined || line < 1 || column < 1) {
        throw new DebugProgramMaterializationError(`invalid DSL source location: ${line}:${column}`);
    }
    const offset = lineStart + column - 1;
    if (offset > sourceLength) {
        throw new DebugProgramMaterializationError(`DSL source location exceeds source length: ${line}:${column}`);
    }
    return offset;
};

const indentContinuationLines = (source: string, indentation: string): string =>
    source.split('\n').map((line, index) => index === 0 ? line : `${indentation}${line}`).join('\n');

const assertNonOverlapping = (edits: readonly SourceEdit[], programId: string): void => {
    for (let index = 1; index < edits.length; index += 1) {
        const previous = edits[index - 1];
        const current = edits[index];
        if (current.end > previous.start) {
            throw new DebugProgramMaterializationError(`overlapping durable patches in program: ${programId}`);
        }
    }
};
