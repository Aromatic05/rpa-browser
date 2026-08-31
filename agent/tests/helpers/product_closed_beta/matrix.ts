import fs from 'node:fs';
import path from 'node:path';

/**
 * Closed-beta product acceptance matrix.
 *
 * The suite drives the product ONLY through user-visible/transport surfaces
 * (Workspace WS `agent.product` Action, `/agent/product` HTTP, real panel DOM,
 * recorded artifacts). Every matrix row maps one closed-beta acceptance item to
 * an external-observation verdict. The machine-readable JSON lives under the
 * e2e tests directory (never docs/production).
 */

export type ClosedBetaStatus = 'pass' | 'fail' | 'blocked';

export type ClosedBetaRow = {
    /** Stable item id, e.g. "cb.product.fresh-config". */
    id: string;
    /** Acceptance statement. */
    item: string;
    status: ClosedBetaStatus;
    /** Concise observed blocker when not passing. */
    blocker?: string;
    /** Short external-observation evidence strings. */
    evidence?: string[];
};

export type ClosedBetaMatrix = {
    generatedAt: string;
    rows: ClosedBetaRow[];
};

export const newClosedBetaMatrix = (): ClosedBetaMatrix => ({
    generatedAt: new Date().toISOString(),
    rows: [],
});

export const recordRow = (matrix: ClosedBetaMatrix, row: ClosedBetaRow): void => {
    const index = matrix.rows.findIndex((candidate) => candidate.id === row.id);
    if (index >= 0) {
        matrix.rows[index] = row;
    } else {
        matrix.rows.push(row);
    }
};

export const passRow = (id: string, item: string, evidence: string[] = []): ClosedBetaRow => ({
    id,
    item,
    status: 'pass',
    ...(evidence.length > 0 ? {evidence} : {}),
});

export const failRow = (id: string, item: string, blocker: string, evidence: string[] = []): ClosedBetaRow => ({
    id,
    item,
    status: 'fail',
    blocker,
    ...(evidence.length > 0 ? {evidence} : {}),
});

export const blockedRow = (id: string, item: string, blocker: string): ClosedBetaRow => ({
    id,
    item,
    status: 'blocked',
    blocker,
});

const artifactsDir = (): string => {
    const configured = process.env.RPA_CLOSED_BETA_MATRIX?.trim();
    if (configured) {
        return configured;
    }
    return path.resolve(process.cwd(), 'tests', 'e2e', 'product_closed_beta', '.artifacts');
};

export const flushClosedBetaMatrix = (matrix: ClosedBetaMatrix): string => {
    const dir = artifactsDir();
    fs.mkdirSync(dir, {recursive: true});
    const jsonPath = path.join(dir, 'product_closed_beta_matrix.json');
    const mdPath = path.join(dir, 'product_closed_beta_matrix.md');
    const merged: ClosedBetaMatrix = {generatedAt: new Date().toISOString(), rows: []};
    try {
        const existing = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as ClosedBetaMatrix;
        if (Array.isArray(existing.rows)) {
            for (const row of existing.rows) {
                recordRow(merged, row);
            }
        }
    } catch {
        // fresh run; no previous matrix
    }
    for (const row of matrix.rows) {
        recordRow(merged, row);
    }
    fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2), 'utf8');
    fs.writeFileSync(mdPath, renderMarkdown(merged), 'utf8');
    return jsonPath;
};

const renderMarkdown = (matrix: ClosedBetaMatrix): string => {
    const passed = matrix.rows.filter((row) => row.status === 'pass').length;
    const failed = matrix.rows.filter((row) => row.status === 'fail').length;
    const blocked = matrix.rows.filter((row) => row.status === 'blocked').length;
    const lines: string[] = [];
    lines.push('# Closed-Beta Product Acceptance Matrix');
    lines.push('');
    lines.push(`generatedAt: ${matrix.generatedAt}`);
    lines.push('');
    lines.push(`- pass: ${passed}`);
    lines.push(`- fail: ${failed}`);
    lines.push(`- blocked: ${blocked}`);
    lines.push('');
    lines.push('| id | item | status | blocker |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of [...matrix.rows].sort((a, b) => a.id.localeCompare(b.id))) {
        lines.push(`| ${row.id} | ${row.item.replace(/\|/gu, '\\|')} | ${row.status} | ${row.blocker ?? ''} |`);
    }
    lines.push('');
    for (const row of matrix.rows) {
        if (row.status === 'pass' || !row.blocker || row.evidence?.length === 0) {
            continue;
        }
        lines.push(`## ${row.id} — ${row.status}`);
        lines.push('');
        lines.push(row.blocker);
        lines.push('');
        for (const evidence of row.evidence ?? []) {
            lines.push(`- ${evidence}`);
        }
        lines.push('');
    }
    return lines.join('\n');
};