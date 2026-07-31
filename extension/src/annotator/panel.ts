import type {
    AnnotatorDraft,
    AnnotatorSemanticInput,
    AnnotatorSession,
    AnnotatorSessionState,
    AnnotatorTarget,
} from './contracts.js';

export type CreateAnnotatorPanelInput = {
    document: Document;
    session: AnnotatorSession;
};

type SemanticKind = AnnotatorSemanticInput['kind'];

export const createAnnotatorPanel = (input: CreateAnnotatorPanelInput): HTMLElement => {
    const document = input.document;
    const root = document.createElement('div');
    root.setAttribute('data-rpa-annotator-panel', 'true');

    const profile = textInput(document, 'Profile name');
    profile.setAttribute('data-annotator-profile', 'true');
    const pageKind = select(document, [
        ['form', 'Form'], ['table', 'Table'], ['dialog', 'Dialog'], ['list', 'List'],
        ['panel', 'Panel'], ['toolbar', 'Toolbar'], ['kv', 'Key/value'],
    ]);
    pageKind.setAttribute('data-annotator-page-kind', 'true');
    const urlPattern = textInput(document, 'URL pattern (optional)');
    urlPattern.setAttribute('data-annotator-url-pattern', 'true');

    const target = document.createElement('select');
    target.setAttribute('data-annotator-target', 'true');
    const semanticKind = document.createElement('select');
    semanticKind.setAttribute('data-annotator-semantic-kind', 'true');
    const semanticValue = textInput(document, 'Business value');
    semanticValue.setAttribute('data-annotator-semantic-value', 'true');
    const displayName = textInput(document, 'Display name / text (optional)');
    displayName.setAttribute('data-annotator-display-name', 'true');

    const draft = document.createElement('textarea');
    draft.setAttribute('aria-label', 'entity_rules draft');
    draft.setAttribute('data-annotator-draft', 'true');
    draft.style.minHeight = '180px';

    const summary = document.createElement('div');
    summary.className = 'hint';
    summary.setAttribute('data-annotator-summary', 'true');
    const selectionSummary = document.createElement('div');
    selectionSummary.className = 'hint';
    const bindings = document.createElement('div');
    bindings.className = 'list';
    bindings.setAttribute('data-annotator-bindings', 'true');
    const diagnostics = document.createElement('div');
    diagnostics.className = 'list';
    diagnostics.setAttribute('data-annotator-diagnostics', 'true');

    const inspectActions = row(document);
    inspectActions.append(
        button(document, 'Open', async () => {
            await input.session.open(profile.value.trim() || undefined);
        }, true),
        button(document, 'Inspect page', async () => {
            await input.session.open();
        }),
        button(document, 'Pick', () => {
            input.session.startPicking();
        }),
        button(document, 'Recognize', async () => {
            await input.session.recognize();
        }),
        button(document, 'Visualize', async () => {
            await input.session.visualize();
        }),
    );

    const applyActions = row(document);
    applyActions.append(
        button(document, 'Apply annotation', async () => {
            const current = editorDraft(draft.value, profile.value, pageKind.value, urlPattern.value);
            const selectedTarget = currentTarget(input.session.getState(), target.value);
            if (!selectedTarget) {throw new Error('select a canonical target first');}
            await input.session.apply({
                draft: current,
                targetId: selectedTarget.id,
                semantic: semanticInput(
                    semanticKind.value as SemanticKind,
                    semanticValue.value,
                    displayName.value,
                    pageKind.value,
                    selectedTarget,
                ),
            });
        }, true),
        button(document, 'Check', async () => {
            const value = editorDraft(draft.value, profile.value, pageKind.value, urlPattern.value);
            input.session.setDraft(value);
            await input.session.check(value);
        }),
        button(document, 'Save', async () => {
            const value = editorDraft(draft.value, profile.value, pageKind.value, urlPattern.value);
            input.session.setDraft(value);
            await input.session.save(value);
        }, true),
    );

    const advanced = document.createElement('details');
    const advancedSummary = document.createElement('summary');
    advancedSummary.textContent = 'Advanced JSON';
    advanced.append(advancedSummary, draft);

    root.append(
        section(document, 'Profile and page', profile, pageKind, urlPattern, inspectActions),
        section(document, 'Canonical target', selectionSummary, target, semanticKind, semanticValue, displayName, applyActions),
        section(document, 'Bindings', bindings),
        section(document, 'Validation', summary, diagnostics),
        advanced,
    );

    let lastDraftJson = '';
    let currentState = input.session.getState();

    const render = (state: AnnotatorSessionState): void => {
        currentState = state;
        if (state.draft) {
            const json = JSON.stringify(state.draft, null, 2);
            if (json !== lastDraftJson) {
                lastDraftJson = json;
                draft.value = json;
                profile.value = state.draft.profileName;
                if (state.draft.page) {
                    pageKind.value = state.draft.page.kind;
                    urlPattern.value = state.draft.page.urlPattern ?? '';
                }
            }
        } else if (!draft.value) {
            const initial = emptyDraft(profile.value.trim());
            lastDraftJson = JSON.stringify(initial, null, 2);
            draft.value = lastDraftJson;
        }
        renderTargets(document, target, state, target.value);
        renderSemanticOptions(document, semanticKind, currentTarget(state, target.value), semanticKind.value as SemanticKind);
        semanticValue.placeholder = semanticPlaceholder(semanticKind.value as SemanticKind);
        selectionSummary.textContent = selectionText(state);
        summary.textContent = stateSummary(state);
        renderBindings(document, bindings, state.draft, (ruleId) => {
            const next = removeRule(state.draft ?? editorDraft(
                draft.value,
                profile.value,
                pageKind.value,
                urlPattern.value,
            ), ruleId);
            input.session.setDraft(next);
        });
        renderDiagnostics(document, diagnostics, state);
        const busy = state.status === 'loading' || state.status === 'applying'
            || state.status === 'checking' || state.status === 'saving';
        for (const child of Array.from(root.getElementsByTagName('button'))) {child.disabled = busy;}
    };

    target.addEventListener('change', () => {
        renderSemanticOptions(document, semanticKind, currentTarget(currentState, target.value), undefined);
        semanticValue.placeholder = semanticPlaceholder(semanticKind.value as SemanticKind);
    });
    semanticKind.addEventListener('change', () => {
        semanticValue.placeholder = semanticPlaceholder(semanticKind.value as SemanticKind);
    });
    draft.addEventListener('input', () => {lastDraftJson = draft.value;});

    input.session.subscribe(render);
    render(currentState);
    return root;
};

const renderTargets = (
    document: Document,
    element: HTMLSelectElement,
    state: AnnotatorSessionState,
    preferred: string,
): void => {
    const targets = selectableTargets(state);
    element.replaceChildren();
    if (targets.length === 0) {
        element.appendChild(option(document, '', 'Pick a page target first'));
        return;
    }
    for (const target of targets) {
        element.appendChild(option(document, target.id, targetLabel(target)));
    }
    element.value = targets.some((target) => target.id === preferred) ? preferred : targets[0].id;
};

const selectableTargets = (state: AnnotatorSessionState): AnnotatorTarget[] => {
    const projection = state.projection;
    if (!projection) {return [];}
    const useful = projection.targets.filter((target) => semanticKinds(target).length > 0);
    if (projection.selection.status !== 'resolved') {
        return useful.filter((target) => target.kind === 'structural-root' || target.kind === 'field'
            || target.kind === 'action' || target.kind === 'column');
    }
    const selectedNodeId = projection.selection.nodeId;
    const direct = useful.filter((target) => target.nodeIds.includes(selectedNodeId));
    const componentIds = new Set(direct.map((target) => target.componentId).filter(Boolean));
    const roots = useful.filter((target) => target.kind === 'structural-root'
        && Boolean(target.componentId) && componentIds.has(target.componentId));
    const selection = useful.filter((target) => target.kind === 'selection-scope'
        && target.nodeIds.includes(selectedNodeId));
    return uniqueTargets([...roots, ...direct, ...selection]);
};

const semanticKinds = (target: AnnotatorTarget): SemanticKind[] => {
    if (target.kind === 'field' && target.domain === 'form') {return ['field'];}
    if (target.kind === 'column' && target.domain === 'table') {return ['column', 'primary-key'];}
    if (target.kind === 'action' && target.domain === 'form') {return ['action'];}
    if (target.kind === 'action' && target.domain === 'table') {return ['table-action'];}
    if (target.kind === 'structural-root' || target.kind === 'host' || target.kind === 'selection-scope') {
        return ['entity'];
    }
    return [];
};

const renderSemanticOptions = (
    document: Document,
    element: HTMLSelectElement,
    target: AnnotatorTarget | undefined,
    preferred: SemanticKind | undefined,
): void => {
    const kinds = target ? semanticKinds(target) : [];
    element.replaceChildren();
    if (kinds.length === 0) {
        element.appendChild(option(document, '', 'No supported annotation'));
        return;
    }
    for (const kind of kinds) {element.appendChild(option(document, kind, semanticLabel(kind)));}
    element.value = preferred && kinds.includes(preferred) ? preferred : kinds[0];
};

const renderBindings = (
    document: Document,
    root: HTMLElement,
    draft: AnnotatorDraft | undefined,
    remove: (ruleId: string) => void,
): void => {
    root.replaceChildren();
    const items = draft?.annotation.bindings ?? [];
    if (items.length === 0) {
        root.appendChild(hint(document, 'No annotations yet. Pick a target and apply business semantics.'));
        return;
    }
    for (const binding of items) {
        const item = document.createElement('div');
        item.className = 'annotator-binding';
        const text = document.createElement('span');
        text.textContent = `${String(binding.ruleId)}  ${bindingSummary(binding)}`;
        const removeButton = button(document, 'Remove', () => {
            remove(String(binding.ruleId));
        });
        item.append(text, removeButton);
        root.appendChild(item);
    }
};

const renderDiagnostics = (
    document: Document,
    root: HTMLElement,
    state: AnnotatorSessionState,
): void => {
    root.replaceChildren();
    const diagnostics = state.validation?.diagnostics ?? state.projection?.diagnostics ?? [];
    if (diagnostics.length === 0) {
        root.appendChild(hint(document, 'No diagnostics.'));
        return;
    }
    for (const diagnostic of diagnostics.slice(0, 20)) {
        const item = document.createElement('div');
        item.className = `annotator-diagnostic ${diagnostic.severity}`;
        item.textContent = `${diagnostic.severity}: ${diagnostic.code} — ${diagnostic.message}`;
        root.appendChild(item);
    }
};

const semanticInput = (
    kind: SemanticKind,
    rawValue: string,
    rawDisplayName: string,
    pageKind: string,
    target: AnnotatorTarget,
): AnnotatorSemanticInput => {
    const value = required(rawValue, semanticPlaceholder(kind));
    const name = rawDisplayName.trim() || target.label;
    if (kind === 'entity') {
        return {
            kind,
            businessTag: value,
            ...(name ? {displayName: name} : {}),
            entityKind: (target.domain === 'form' || target.domain === 'table'
                ? target.domain
                : pageKind) as Extract<AnnotatorSemanticInput, {kind: 'entity'}>['entityKind'],
        };
    }
    if (kind === 'field') {return {kind, fieldKey: value, ...(name ? {displayName: name} : {})};}
    if (kind === 'action') {return {kind, actionIntent: value, ...(name ? {displayName: name} : {})};}
    if (kind === 'column') {return {kind, fieldKey: value, ...(name ? {displayName: name} : {})};}
    if (kind === 'primary-key') {return {kind, fieldKey: value};}
    return {kind: 'table-action', actionIntent: value, ...(name ? {displayName: name} : {})};
};

const editorDraft = (
    raw: string,
    profileName: string,
    pageKind: string,
    urlPattern: string,
): AnnotatorDraft => {
    const parsed = parseDraft(raw, profileName);
    const normalizedProfileName = profileName.trim() || parsed.profileName;
    if (!normalizedProfileName) {throw new Error('profile name is required');}
    return {
        ...parsed,
        profileName: normalizedProfileName,
        page: {
            kind: pageKind as NonNullable<AnnotatorDraft['page']>['kind'],
            ...(urlPattern.trim() ? {urlPattern: urlPattern.trim()} : {}),
        },
    };
};

const parseDraft = (raw: string, profileName: string): AnnotatorDraft => {
    if (!raw.trim()) {return emptyDraft(profileName.trim());}
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('annotator draft must be an object');
    }
    const record = value as Record<string, unknown>;
    const normalizedProfileName = typeof record.profileName === 'string' && record.profileName.trim()
        ? record.profileName.trim()
        : profileName.trim();
    if (!isArtifactPart(record.match, 'rules') || !isArtifactPart(record.annotation, 'bindings')) {
        throw new Error('annotator draft must contain V2 match.rules and annotation.bindings');
    }
    return {
        profileName: normalizedProfileName,
        page: record.page === undefined ? undefined : structuredClone(record.page) as AnnotatorDraft['page'],
        match: structuredClone(record.match) as AnnotatorDraft['match'],
        annotation: structuredClone(record.annotation) as AnnotatorDraft['annotation'],
    };
};

const removeRule = (draft: AnnotatorDraft, ruleId: string): AnnotatorDraft => {
    const removed = new Set([ruleId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const rule of draft.match.rules) {
            if (typeof rule.ruleId !== 'string' || typeof rule.within !== 'string') {continue;}
            if (removed.has(rule.within) && !removed.has(rule.ruleId)) {
                removed.add(rule.ruleId);
                changed = true;
            }
        }
    }
    return {
        ...structuredClone(draft),
        match: {version: 2, rules: draft.match.rules.filter((rule) =>
            typeof rule.ruleId !== 'string' || !removed.has(rule.ruleId))},
        annotation: {version: 2, bindings: draft.annotation.bindings.filter((binding) =>
            typeof binding.ruleId !== 'string' || !removed.has(binding.ruleId))},
    };
};

const currentTarget = (state: AnnotatorSessionState, targetId: string): AnnotatorTarget | undefined =>
    state.projection?.targets.find((target) => target.id === targetId);

const selectionText = (state: AnnotatorSessionState): string => {
    const selection = state.projection?.selection;
    if (!selection || selection.status === 'none') {return 'No confirmed selection.';}
    if (selection.status === 'resolved') {return `Selected canonical node: ${selection.nodeId}`;}
    if (selection.status === 'ambiguous') {return `Ambiguous selection: ${selection.candidateNodeIds.join(', ')}`;}
    return 'Selection is stale. Pick the target again.';
};

const stateSummary = (state: AnnotatorSessionState): string => {
    const identity = state.projection?.identity;
    const validation = state.validation ? ` validation=${state.validation.ok ? 'ok' : 'invalid'}` : '';
    const error = state.error ? ` error=${state.error}` : '';
    return `status=${state.status} epoch=${identity?.pageEpoch ?? '-'} revision=${identity ? String(identity.captureRevision) : '-'}${validation}${error}`;
};

const targetLabel = (target: AnnotatorTarget): string =>
    `${target.kind}${target.domain ? `/${target.domain}` : ''}: ${target.label ?? target.memberId ?? target.id}`;

const semanticLabel = (kind: SemanticKind): string => ({
    entity: 'Business entity',
    field: 'Form field',
    action: 'Form action',
    column: 'Table column',
    'primary-key': 'Table primary key',
    'table-action': 'Table row action',
})[kind];

const semanticPlaceholder = (kind: SemanticKind): string => ({
    entity: 'businessTag, e.g. order.form',
    field: 'fieldKey, e.g. buyer',
    action: 'actionIntent, e.g. submit',
    column: 'fieldKey, e.g. orderNo',
    'primary-key': 'fieldKey, e.g. orderNo',
    'table-action': 'actionIntent, e.g. approve',
})[kind];

const bindingSummary = (binding: Record<string, unknown>): string => [
    binding.businessTag, binding.fieldKey, binding.actionIntent,
    binding.primaryKey ? 'primary-key' : undefined,
    Array.isArray(binding.columns) ? `${String(binding.columns.length)} columns` : undefined,
].filter(Boolean).join(' · ');

const emptyDraft = (profileName: string): AnnotatorDraft => ({
    profileName,
    match: {version: 2, rules: []},
    annotation: {version: 2, bindings: []},
});

const isArtifactPart = (value: unknown, collection: 'rules' | 'bindings'): boolean =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).version === 2
    && Array.isArray((value as Record<string, unknown>)[collection]);

const section = (document: Document, titleText: string, ...children: Node[]): HTMLElement => {
    const root = document.createElement('div');
    root.className = 'annotator-section';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = titleText;
    root.append(title, ...children);
    return root;
};

const row = (document: Document): HTMLElement => {
    const root = document.createElement('div');
    root.className = 'annotator-actions';
    return root;
};

const textInput = (document: Document, placeholder: string): HTMLInputElement => {
    const element = document.createElement('input');
    element.placeholder = placeholder;
    return element;
};

const select = (document: Document, values: Array<[string, string]>): HTMLSelectElement => {
    const element = document.createElement('select');
    for (const [value, label] of values) {element.appendChild(option(document, value, label));}
    return element;
};

const option = (document: Document, value: string, label: string): HTMLOptionElement => {
    const element = document.createElement('option');
    element.value = value;
    element.textContent = label;
    return element;
};

const button = (
    document: Document,
    label: string,
    action: () => void | Promise<void>,
    primary = false,
): HTMLButtonElement => {
    const element = document.createElement('button');
    element.textContent = label;
    if (primary) {element.classList.add('primary');}
    element.addEventListener('click', () => {
        element.removeAttribute('data-error');
        void Promise.resolve(action()).catch((error: unknown) => {
            element.setAttribute('data-error', error instanceof Error ? error.message : String(error));
        });
    });
    return element;
};

const hint = (document: Document, text: string): HTMLElement => {
    const element = document.createElement('div');
    element.className = 'hint';
    element.textContent = text;
    return element;
};

const required = (value: string, field: string): string => {
    const normalized = value.trim();
    if (!normalized) {throw new Error(`${field} is required`);}
    return normalized;
};

const uniqueTargets = (targets: AnnotatorTarget[]): AnnotatorTarget[] => {
    const seen = new Set<string>();
    return targets.filter((target) => {
        if (seen.has(target.id)) {return false;}
        seen.add(target.id);
        return true;
    });
};
