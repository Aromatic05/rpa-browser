import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { LoadEntityRulesOptions, LoadEntityRulesResult, NormalizedEntityRuleBundle } from './types';
import { validateEntityRules } from './validate';

const MATCH_FILE = 'match.yaml';
const ANNOTATION_FILE = 'annotation.yaml';

export const loadEntityRules = (options: LoadEntityRulesOptions = {}): LoadEntityRulesResult => {
    const rulesRootDir = options.rulesRootDir || path.resolve(process.cwd(), 'entity_rules');
    if (!fs.existsSync(rulesRootDir)) {
        return { errors: [] };
    }

    const dirEntries = safeReadDir(rulesRootDir)
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

    const errors: string[] = [];
    const bundles: NormalizedEntityRuleBundle[] = [];

    for (const dirName of dirEntries) {
        const dirPath = path.join(rulesRootDir, dirName);
        const matchPath = path.join(dirPath, MATCH_FILE);
        const annotationPath = path.join(dirPath, ANNOTATION_FILE);
        if (!fs.existsSync(matchPath) || !fs.existsSync(annotationPath)) {
            continue;
        }

        const matchParsed = parseYamlFile(matchPath);
        if (!matchParsed.ok) {
            errors.push(`entity_rules/${dirName}/${MATCH_FILE}: ${matchParsed.error}`);
            continue;
        }

        const annotationParsed = parseYamlFile(annotationPath);
        if (!annotationParsed.ok) {
            errors.push(`entity_rules/${dirName}/${ANNOTATION_FILE}: ${annotationParsed.error}`);
            continue;
        }

        const validated = validateEntityRules(dirName, matchParsed.data, annotationParsed.data);
        if (!validated.ok) {
            for (const error of validated.errors) {
                errors.push(`entity_rules/${dirName}: ${error}`);
            }
            continue;
        }

        bundles.push(validated.bundle);
    }

    const filtered = bundles.filter((bundle) => matchesPage(bundle, options.pageKind, options.pageUrl));

    return {
        bundle: filtered[0],
        errors,
    };
};

const matchesPage = (
    bundle: NormalizedEntityRuleBundle,
    pageKind: string | undefined,
    pageUrl: string | undefined,
): boolean => {
    if (pageKind && bundle.page.kind !== pageKind) return false;
    if (!bundle.page.urlPattern) return true;
    if (!pageUrl) return false;
    try {
        return new RegExp(bundle.page.urlPattern).test(pageUrl);
    } catch {
        return false;
    }
};

const parseYamlFile = (filePath: string): { ok: true; data: unknown } | { ok: false; error: string } => {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = parse(raw);
        return { ok: true, data };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'unknown parse error',
        };
    }
};

const safeReadDir = (dirPath: string) => {
    try {
        return fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return [];
    }
};
