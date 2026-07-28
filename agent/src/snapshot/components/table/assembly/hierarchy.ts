import type { AnalysisDiagnostic, PageObservation } from '../../../observation/model/contracts';
import type { TableRow, TableRowHierarchy } from '../model/contracts';
import { evidence } from './dom';

export type HierarchyBuildResult = {
    hierarchy?: TableRowHierarchy;
    diagnostics: AnalysisDiagnostic[];
};

export const buildRowHierarchy = (
    observation: PageObservation,
    rows: readonly TableRow[],
): HierarchyBuildResult => {
    const hasAriaLevel = rows.some((row) => row.level !== undefined);
    if (!hasAriaLevel) {
        return {
            hierarchy: {
                parentRowIdByRowId: Object.fromEntries(rows.map((row) => [row.id, undefined])),
                levelByRowId: Object.fromEntries(rows.map((row) => [row.id, undefined])),
                source: 'unknown',
            },
            diagnostics: [],
        };
    }

    const parentRowIdByRowId: Record<string, string | undefined> = {};
    const levelByRowId: Record<string, number | undefined> = {};
    const diagnostics: AnalysisDiagnostic[] = [];
    const stack: TableRow[] = [];
    let previousLevel: number | undefined;
    for (const row of rows) {
        const level = row.level;
        levelByRowId[row.id] = level;
        if (level === undefined) {
            parentRowIdByRowId[row.id] = undefined;
            continue;
        }
        if (previousLevel !== undefined && level > previousLevel + 1) {
            diagnostics.push({
                code: 'table.hierarchy.invalid-level-jump',
                severity: 'warning',
                stage: 'table-hierarchy',
                status: 'partial',
                nodeIds: [row.nodeId],
                evidence: [evidence('table.row.aria-level', 'exact', 'a11y', [row.nodeId], { level })],
                message: `row aria-level jumps from ${previousLevel} to ${level}`,
            });
            parentRowIdByRowId[row.id] = undefined;
        } else {
            while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) {stack.pop();}
            const parent = stack.at(-1);
            parentRowIdByRowId[row.id] = parent && parent.level === level - 1 ? parent.id : undefined;
        }
        stack.push(row);
        previousLevel = level;
    }
    return {
        hierarchy: { parentRowIdByRowId, levelByRowId, source: 'aria-level' },
        diagnostics,
    };
};
