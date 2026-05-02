import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { getLogger } from '../../../../../logging/logger';
import { defaultEntityRuleConfig, selectEntityRuleProfiles, type EntityRuleProfileMeta } from '../../../../../config/entity_rules';
import type { LoadEntityRulesOptions, LoadEntityRulesResult, NormalizedEntityRuleBundle } from './types';
import { validateEntityRules } from './validate';

const log = getLogger('entity');
const MATCH_FILE = 'match.yaml';
const ANNOTATION_FILE = 'annotation.yaml';
const WORKFLOWS_DIR = 'workflows';
const ENTITY_RULES_DIR = 'entity_rules';
type BundleSource = 'workflow';

type LoadedBundleCandidate = {
    bundle: NormalizedEntityRuleBundle;
    aliases: string[];
    source: BundleSource;
};

export const loadEntityRules = (options: LoadEntityRulesOptions = {}): LoadEntityRulesResult => {
    const config = options.config || defaultEntityRuleConfig;

    log.info('entity.rules.load.start', {
        enabled: config.enabled,
        selection: config.selection,
        strict: config.strict,
        rootDir: config.rootDir,
        profiles: config.profiles,
        pageKind: options.pageKind,
        pageUrl: options.pageUrl,
    });

    if (!config.enabled || config.selection === 'disabled') {
        log.info('entity.rules.load.end', { selectedProfile: null, reason: 'disabled' });
        return { errors: [], warnings: [] };
    }

    const workflowRootDir = path.join(config.rootDir, WORKFLOWS_DIR);
    if (!fs.existsSync(workflowRootDir)) {
        const issue = `entity rules root not found: ${workflowRootDir}`;
        const result = resultWithIssue(config.strict, issue);
        log.info('entity.rules.load.end', {
            selectedProfile: null,
            reason: 'rules_root_missing_workflow',
            errors: result.errors,
            warnings: result.warnings,
        });
        return result;
    }

    const entries = collectBundleEntries(config.rootDir);

    const loadedBundles: LoadedBundleCandidate[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const entry of entries) {
        const loaded = loadProfileBundle(entry.bundleDir, entry.bundleId);
        if (loaded.ok) {
            loadedBundles.push({
                bundle: loaded.bundle,
                aliases: entry.aliases,
                source: entry.source,
            });
            continue;
        }

        for (const issue of loaded.issues) {
            const message = `entity_rules/${entry.bundleId}: ${issue}`;
            if (config.strict) {
                errors.push(message);
            } else {
                warnings.push(message);
            }
            log.warn('entity.rules.validate.failed', {
                profile: entry.bundleId,
                issue: message,
            });
        }
    }

    const profileMetas: EntityRuleProfileMeta[] = loadedBundles.map((item) => ({
        name: item.bundle.id,
        aliases: item.aliases,
        pageKind: item.bundle.page.kind,
        urlPattern: item.bundle.page.urlPattern,
    }));

    const selected = selectEntityRuleProfiles(config, profileMetas, {
        kind: options.pageKind,
        url: options.pageUrl,
    });
    errors.push(...selected.errors);
    warnings.push(...selected.warnings);

    if (selected.selected.length > 1) {
        log.warn('entity.rules.profile.conflict', {
            selection: config.selection,
            profiles: selected.selected,
            pageKind: options.pageKind,
            pageUrl: options.pageUrl,
        });
    }

    const selectedProfile = selected.selected[0];
    if (selectedProfile) {
        log.info('entity.rules.profile.selected', {
            selection: config.selection,
            profile: selectedProfile,
            pageKind: options.pageKind,
            pageUrl: options.pageUrl,
        });
    }

    const bundle = selectedProfile ? loadedBundles.find((item) => item.bundle.id === selectedProfile)?.bundle : undefined;

    if (selectedProfile && !bundle) {
        const issue = `entity profile not loaded: ${selectedProfile}`;
        if (config.strict) {
            errors.push(issue);
        } else {
            warnings.push(issue);
        }
    }

    log.info('entity.rules.load.end', {
        selectedProfile: selectedProfile || null,
        errors: errors.length,
        warnings: warnings.length,
    });

    return {
        bundle,
        selectedProfile,
        errors,
        warnings,
    };
};

const loadProfileBundle = (
    bundleDir: string,
    bundleId: string,
): { ok: true; bundle: NormalizedEntityRuleBundle } | { ok: false; issues: string[] } => {
    const matchPath = path.join(bundleDir, MATCH_FILE);
    const annotationPath = path.join(bundleDir, ANNOTATION_FILE);

    if (!fs.existsSync(matchPath) || !fs.existsSync(annotationPath)) {
        return {
            ok: false,
            issues: [`missing ${MATCH_FILE} or ${ANNOTATION_FILE}`],
        };
    }

    const matchParsed = parseYamlFile(matchPath);
    if (!matchParsed.ok) {
        return {
            ok: false,
            issues: [`${MATCH_FILE}: ${matchParsed.error}`],
        };
    }

    const annotationParsed = parseYamlFile(annotationPath);
    if (!annotationParsed.ok) {
        return {
            ok: false,
            issues: [`${ANNOTATION_FILE}: ${annotationParsed.error}`],
        };
    }

    const validated = validateEntityRules(bundleId, matchParsed.data, annotationParsed.data);
    if (!validated.ok) {
        return {
            ok: false,
            issues: validated.errors,
        };
    }

    return {
        ok: true,
        bundle: validated.bundle,
    };
};

const collectBundleEntries = (
    rootDir: string,
): Array<{ bundleId: string; bundleDir: string; aliases: string[]; source: BundleSource }> => {
    const workflowRootDir = path.join(rootDir, WORKFLOWS_DIR);
    const workflowEntries: Array<{ bundleId: string; bundleDir: string; aliases: string[]; source: BundleSource }> = [];

    for (const sceneEntry of safeReadDir(workflowRootDir).filter((entry) => entry.isDirectory())) {
        const scene = sceneEntry.name;
        const rulesDir = path.join(workflowRootDir, scene, ENTITY_RULES_DIR);
        for (const ruleEntry of safeReadDir(rulesDir).filter((entry) => entry.isDirectory())) {
            const ruleName = ruleEntry.name;
            workflowEntries.push({
                bundleId: `${scene}/${ruleName}`,
                bundleDir: path.join(rulesDir, ruleName),
                aliases: [ruleName],
                source: 'workflow',
            });
        }
    }
    return workflowEntries.sort((left, right) => left.bundleId.localeCompare(right.bundleId));
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

const resultWithIssue = (strict: boolean, issue: string): LoadEntityRulesResult => {
    if (strict) {
        return { errors: [issue], warnings: [] };
    }
    return { errors: [], warnings: [issue] };
};
