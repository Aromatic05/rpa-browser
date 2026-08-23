import type { DslStmt } from '../ast/types';

export const collectDefinitelyAssignedVariables = (
    body: readonly DslStmt[],
    initial: ReadonlySet<string>,
): Set<string> => {
    let assigned = new Set(initial);
    for (const stmt of body) {
        if (stmt.kind === 'let') {
            assigned.add(stmt.name);
            continue;
        }
        if (stmt.kind === 'checkpoint' && stmt.bind) {
            assigned.add(stmt.bind);
            continue;
        }
        if (stmt.kind === 'if') {
            const thenAssigned = collectDefinitelyAssignedVariables(stmt.then, assigned);
            const elseAssigned = stmt.else
                ? collectDefinitelyAssignedVariables(stmt.else, assigned)
                : new Set(assigned);
            assigned = intersect(thenAssigned, elseAssigned);
        }
    }
    return assigned;
};

const intersect = (left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> =>
    new Set([...left].filter((name) => right.has(name)));
