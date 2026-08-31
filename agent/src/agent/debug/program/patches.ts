import type {DslStmt} from '../../../program/dsl/ast/types';

export type DebugProgramPatch = Readonly<{
    programId: string;
    path: string;
    source: string;
    statement: DslStmt;
}>;

export type DebugProgramPatchStore = Readonly<{
    set: (patch: DebugProgramPatch) => DebugProgramPatch;
    get: (programId: string, path: string) => DebugProgramPatch | null;
    remove: (programId: string, path: string) => DebugProgramPatch | null;
    list: (programId?: string) => readonly DebugProgramPatch[];
}>;


export const isDurableProgramPatchStatement = (statement: DslStmt): boolean =>
    statement.kind !== 'if' && statement.kind !== 'for' && statement.kind !== 'checkpoint';

const keyOf = (programId: string, path: string): string => `${programId}\u0000${path}`;

export const createDebugProgramPatchStore = (): DebugProgramPatchStore => {
    const patches = new Map<string, DebugProgramPatch>();
    return Object.freeze({
        set: (patch) => {
            const stored = Object.freeze(structuredClone(patch));
            patches.set(keyOf(stored.programId, stored.path), stored);
            return structuredClone(stored);
        },
        get: (programId, path) => {
            const patch = patches.get(keyOf(programId, path));
            return patch ? structuredClone(patch) : null;
        },
        remove: (programId, path) => {
            const key = keyOf(programId, path);
            const patch = patches.get(key);
            if (!patch) {return null;}
            patches.delete(key);
            return structuredClone(patch);
        },
        list: (programId) => Object.freeze(
            [...patches.values()]
                .filter((patch) => !programId || patch.programId === programId)
                .map((patch) => structuredClone(patch)),
        ),
    });
};
