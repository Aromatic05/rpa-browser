import type {PageObservation, PageSnapshotSessionEntry} from '../../snapshot';
import {compileBrowserQuery} from '../../../program/query/compile';
import type {BrowserQueryResult, StepArgsMap} from '../steps/types';
import {buildPageSessionEntityView} from './entity_view';
import {executePageSessionQueryIR, type QueryIRExecutionError} from './query_ir';

type BrowserQueryArgs = StepArgsMap['browser.query'];
type StructuralQueryArgs = Extract<BrowserQueryArgs, {from: unknown}>;

export type PageSessionQueryError = QueryIRExecutionError;

export type PageSessionQueryResult =
    | {ok: true; data: BrowserQueryResult}
    | {ok: false; error: PageSessionQueryError};

export const queryPageSessionEntry = (
    entry: PageSnapshotSessionEntry,
    args: BrowserQueryArgs,
): PageSessionQueryResult => {
    const observation = entry.capture.control.observation;
    const compiled = compileBrowserQuery(args);
    if (!compiled.ok) {
        return error(
            compiled.error.code,
            compiled.error.message,
            'op' in args
                ? businessQueryDiagnosticDetails(entry, args, undefined)
                : queryDiagnosticDetails(observation, args),
        );
    }

    const result = executePageSessionQueryIR(entry, compiled.ir);
    if (result.ok) {return result;}
    return {
        ok: false,
        error: {
            ...result.error,
            details: 'op' in args
                ? businessQueryDiagnosticDetails(entry, args, result.error.details)
                : queryDiagnosticDetails(observation, args),
        },
    };
};

const businessQueryDiagnosticDetails = (
    entry: PageSnapshotSessionEntry,
    args: Extract<BrowserQueryArgs, {op: unknown}>,
    resolutionDetails: unknown,
): Record<string, unknown> => {
    const observation = entry.capture.control.observation;
    const availableBusinessTags = buildPageSessionEntityView(entry).entities
        .map((entity) => entity.businessTag)
        .filter((businessTag): businessTag is string => Boolean(businessTag))
        .sort();
    return {
        pageEpoch: observation.identity.pageEpoch,
        captureRevision: observation.identity.captureRevision,
        scopeIds: [...observation.scopes.rootScopeIds],
        operation: args.op,
        businessTag: args.businessTag,
        ...('query' in args ? {query: args.query} : {target: structuredClone(args.target)}),
        semanticProfiles: Object.keys(entry.semanticBindingsByProfile).sort(),
        availableBusinessTags,
        ...(entry.capture.entityRules ? {entityRules: summarizeEntityRules(entry.capture.entityRules)} : {}),
        ...(resolutionDetails === undefined ? {} : {resolution: structuredClone(resolutionDetails)}),
    };
};

const summarizeEntityRules = (
    execution: NonNullable<PageSnapshotSessionEntry['capture']['entityRules']>,
): Record<string, unknown> => ({
    status: execution.status,
    ok: execution.ok,
    diagnostics: execution.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        status: diagnostic.status,
    })),
    profiles: Object.fromEntries(Object.entries(execution.profiles).map(([profileName, profile]) => [profileName, {
        ok: profile.ok,
        diagnostics: profile.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            status: diagnostic.status,
        })),
        rules: Object.fromEntries(Object.entries(profile.bindings).map(([ruleId, binding]) => [ruleId, {
            ok: binding.ok,
            cardinality: binding.cardinality,
            matchedComponentIds: binding.matchedComponentIds,
            matchedNodeIds: binding.matchedNodeIds,
        }])),
    }])),
});

const queryDiagnosticDetails = (
    observation: PageObservation,
    args: StructuralQueryArgs,
): Record<string, unknown> => ({
    pageEpoch: observation.identity.pageEpoch,
    captureRevision: observation.identity.captureRevision,
    scopeIds: [...observation.scopes.rootScopeIds],
    relation: args.relation ?? 'descendant',
    from: args.from,
});

const error = (
    code: PageSessionQueryError['code'],
    message: string,
    details?: unknown,
): PageSessionQueryResult => ({ok: false, error: {code, message, details}});
