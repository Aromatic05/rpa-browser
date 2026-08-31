import type {DslProgram, DslStmt} from '../ast/types';
import {collectDefinitelyAssignedVariables} from './definite_assignment';

export const collectAvailableVariablesAtPath = (
    program: DslProgram,
    targetPath: string,
): ReadonlySet<string> | null => collectInBlock(program.body, 'body', new Set(), targetPath);

const collectInBlock = (
    body: readonly DslStmt[],
    blockPath: string,
    initial: ReadonlySet<string>,
    targetPath: string,
): ReadonlySet<string> | null => {
    let assigned = new Set(initial);
    for (let index = 0; index < body.length; index += 1) {
        const statement = body[index];
        const path = `${blockPath}.${index}`;
        if (path === targetPath) {return new Set(assigned);}

        if (statement.kind === 'if') {
            if (targetPath.startsWith(`${path}.then.`)) {
                return collectInBlock(statement.then, `${path}.then`, assigned, targetPath);
            }
            if (targetPath.startsWith(`${path}.else.`)) {
                return statement.else
                    ? collectInBlock(statement.else, `${path}.else`, assigned, targetPath)
                    : null;
            }
        }
        if (statement.kind === 'for' && targetPath.startsWith(`${path}.body.`)) {
            const loopScope = new Set(assigned);
            loopScope.add(statement.item);
            return collectInBlock(statement.body, `${path}.body`, loopScope, targetPath);
        }

        if (targetPath.startsWith(`${path}.`)) {return null;}
        assigned = collectDefinitelyAssignedVariables([statement], assigned);
    }
    return null;
};
