import fs from 'node:fs';
import path from 'node:path';

/**
 * Machine-readable product smoke matrix for the Agent closed-beta readiness
 * assessment. Each workflow in the smoke suite records one entry. The final
 * writer classifies failures into true product blockers, research-quality
 * gaps, and nice-to-have UX issues — never hiding unsupported behavior.
 */

export type SmokeStatus = 'pass' | 'fail';

export type BlockerCategory = 'product' | 'research-gap' | 'ux';

export type SmokeEntry = {
    /** Stable workflow id, e.g. "program.form.ordinary". */
    id: string;
    /** Human-readable workflow name. */
    name: string;
    status: SmokeStatus;
    /** Set only when status === 'fail'. */
    category?: BlockerCategory;
    /** Concise description of the observed blocker when failing. */
    blocker?: string;
    /** Short external-observation evidence strings (DOM/service/world). */
    evidence?: string[];
};

export type ProductSmokeMatrix = {
    generatedAt: string;
    entries: SmokeEntry[];
};

export const newProductSmokeMatrix = (): ProductSmokeMatrix => ({
    generatedAt: new Date().toISOString(),
    entries: [],
});

export const recordEntry = (
    matrix: ProductSmokeMatrix,
    entry: SmokeEntry,
): void => {
    const index = matrix.entries.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) {
        matrix.entries[index] = entry;
    } else {
        matrix.entries.push(entry);
    }
};

export const passEntry = (id: string, name: string, evidence: string[] = []): SmokeEntry => ({
    id,
    name,
    status: 'pass',
    ...(evidence.length > 0 ? {evidence} : {}),
});

export const failEntry = (
    id: string,
    name: string,
    category: BlockerCategory,
    blocker: string,
    evidence: string[] = [],
): SmokeEntry => ({
    id,
    name,
    status: 'fail',
    category,
    blocker,
    ...(evidence.length > 0 ? {evidence} : {}),
});

export type Classification = {
    blockers: SmokeEntry[];
    researchGaps: SmokeEntry[];
    uxIssues: SmokeEntry[];
    passed: SmokeEntry[];
};

export const classifyMatrix = (matrix: ProductSmokeMatrix): Classification => {
    const blockers: SmokeEntry[] = [];
    const researchGaps: SmokeEntry[] = [];
    const uxIssues: SmokeEntry[] = [];
    const passed: SmokeEntry[] = [];
    for (const entry of matrix.entries) {
        if (entry.status === 'pass') {
            passed.push(entry);
            continue;
        }
        if (entry.category === 'research-gap') {
            researchGaps.push(entry);
        } else if (entry.category === 'ux') {
            uxIssues.push(entry);
        } else {
            blockers.push(entry);
        }
    }
    return {blockers, researchGaps, uxIssues, passed};
};

const matrixDir = (): string => {
    const configured = process.env.RPA_PRODUCT_SMOKE_MATRIX?.trim();
    if (configured) {
        return configured;
    }
    return path.resolve(process.cwd(), '.artifacts', 'product-smoke');
};

export const writeProductSmokeMatrix = (
    matrix: ProductSmokeMatrix,
    options: {merge?: ProductSmokeMatrix} = {},
): string => {
    const merged: ProductSmokeMatrix = {
        generatedAt: new Date().toISOString(),
        entries: [],
    };
    // The persisted file is the union across test files; the current run's
    // entries take precedence over previously recorded ones with the same id.
    if (options.merge) {
        for (const entry of options.merge.entries) {
            recordEntry(merged, entry);
        }
    }
    for (const entry of matrix.entries) {
        recordEntry(merged, entry);
    }
    const dir = matrixDir();
    fs.mkdirSync(dir, {recursive: true});
    const jsonPath = path.join(dir, 'product_smoke_matrix.json');
    const mdPath = path.join(dir, 'product_smoke_matrix.md');
    fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2), 'utf8');
    fs.writeFileSync(mdPath, renderMarkdown(merged), 'utf8');
    return jsonPath;
};

export const loadProductSmokeMatrix = (): ProductSmokeMatrix | null => {
    const jsonPath = path.join(matrixDir(), 'product_smoke_matrix.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as ProductSmokeMatrix;
        return Array.isArray(parsed.entries) ? parsed : null;
    } catch {
        return null;
    }
};

const renderMarkdown = (matrix: ProductSmokeMatrix): string => {
    const classification = classifyMatrix(matrix);
    const lines: string[] = [];
    lines.push('# Agent Product Smoke Matrix');
    lines.push('');
    lines.push(`generatedAt: ${matrix.generatedAt}`);
    lines.push('');
    lines.push(`## Summary`);
    lines.push('');
    lines.push(`- pass: ${classification.passed.length}`);
    lines.push(`- product blockers: ${classification.blockers.length}`);
    lines.push(`- research-quality gaps: ${classification.researchGaps.length}`);
    lines.push(`- nice-to-have UX issues: ${classification.uxIssues.length}`);
    lines.push('');
    lines.push('## Workflows');
    lines.push('');
    lines.push('| id | workflow | status | category | blocker |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of [...matrix.entries].sort((a, b) => a.id.localeCompare(b.id))) {
        lines.push(`| ${entry.id} | ${entry.name} | ${entry.status} | ${entry.category ?? ''} | ${entry.blocker ?? ''} |`);
    }
    lines.push('');
    if (classification.blockers.length > 0) {
        lines.push('## True product blockers');
        lines.push('');
        for (const entry of classification.blockers) {
            lines.push(`- **${entry.id}** ${entry.name}: ${entry.blocker}`);
            for (const evidence of entry.evidence ?? []) {
                lines.push(`  - ${evidence}`);
            }
        }
        lines.push('');
    }
    if (classification.researchGaps.length > 0) {
        lines.push('## Research-quality gaps');
        lines.push('');
        for (const entry of classification.researchGaps) {
            lines.push(`- **${entry.id}** ${entry.name}: ${entry.blocker}`);
            for (const evidence of entry.evidence ?? []) {
                lines.push(`  - ${evidence}`);
            }
        }
        lines.push('');
    }
    if (classification.uxIssues.length > 0) {
        lines.push('## Nice-to-have UX issues');
        lines.push('');
        for (const entry of classification.uxIssues) {
            lines.push(`- **${entry.id}** ${entry.name}: ${entry.blocker}`);
            for (const evidence of entry.evidence ?? []) {
                lines.push(`  - ${evidence}`);
            }
        }
        lines.push('');
    }
    return lines.join('\n');
};