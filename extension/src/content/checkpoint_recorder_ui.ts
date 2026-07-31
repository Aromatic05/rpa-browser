import type {Action} from '../shared/types.js';

type RecorderPhase = 'idle' | 'setup' | 'recording' | 'review' | 'saving' | 'success';
type CheckpointKind = 'procedure' | 'recovery';
type OperationKind = 'any' | 'click' | 'fill' | 'select' | 'assert';
type OutputKind = 'none' | 'table.currentRows' | 'table.rowCount';

type RecordedStepSummary = {
    index: number;
    stepId: string;
    stepName: string;
    label: string;
    recordedValue?: unknown;
    profileName?: string;
    businessTag?: string;
    fieldKey?: string;
    fieldHint?: string;
    actionHint?: string;
    actionRole?: 'row';
    rowPrimaryKey?: {fieldKey: string; value: string};
};

type EntityRuleField = {fieldKey: string; label: string; targetKind: 'entity.field' | 'form.field' | 'table.filter'};
type EntityRuleAction = {actionIntent: string; label: string; targetKind: 'entity.action' | 'form.action' | 'table.module_action'};
type EntityRuleRowAction = {actionIntent: string; label: string; targetKind: 'table.row_action'};
type EntityRulePrimaryKey = {fieldKey: string; label: string};
type EntityRuleOutput = {kind: OutputKind; label: string};
type EntityRuleOption = {
    profileName: string;
    businessTag: string;
    entityKind: 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv';
    label: string;
    fields: EntityRuleField[];
    actions: EntityRuleAction[];
    rowActions: EntityRuleRowAction[];
    primaryKey?: EntityRulePrimaryKey;
    outputs: EntityRuleOutput[];
};

export type CheckpointRecorderUIOptions = {
    launchers: HTMLElement;
    surface: HTMLElement;
    before?: Node | null;
    sendAction: (type: string, payload?: Record<string, unknown>) => Promise<Action>;
    onActiveChange?: (active: boolean) => void;
    onEntityRulePreview?: (selection: {
        profileName: string;
        businessTag: string;
        entityKind: 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv';
    } | null) => void | Promise<void>;
    recordingAutoHideMs?: number;
};

export type CheckpointRecorderUIHandle = {
    setVisible: (visible: boolean) => void;
    onPageChanged: () => void;
    unmount: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const readFailure = (action: Action): string => {
    const payload = isRecord(action.payload) ? action.payload : {};
    return typeof payload.message === 'string' && payload.message.trim()
        ? payload.message
        : '操作失败，请重试';
};

const readSteps = (action: Action): RecordedStepSummary[] => {
    const payload = isRecord(action.payload) ? action.payload : {};
    if (!Array.isArray(payload.steps)) {return [];}
    return payload.steps.flatMap((item) => {
        if (!isRecord(item)
            || typeof item.index !== 'number'
            || typeof item.stepId !== 'string'
            || typeof item.stepName !== 'string'
            || typeof item.label !== 'string') {return [];}
        return [{
            index: item.index,
            stepId: item.stepId,
            stepName: item.stepName,
            label: item.label,
            ...('recordedValue' in item ? {recordedValue: structuredClone(item.recordedValue)} : {}),
            ...(typeof item.profileName === 'string' ? {profileName: item.profileName} : {}),
            ...(typeof item.businessTag === 'string' ? {businessTag: item.businessTag} : {}),
            ...(typeof item.fieldKey === 'string' ? {fieldKey: item.fieldKey} : {}),
            ...(typeof item.fieldHint === 'string' ? {fieldHint: item.fieldHint} : {}),
            ...(typeof item.actionHint === 'string' ? {actionHint: item.actionHint} : {}),
            ...(item.actionRole === 'row' ? {actionRole: 'row' as const} : {}),
            ...(isRecord(item.rowPrimaryKey)
                && typeof item.rowPrimaryKey.fieldKey === 'string'
                && typeof item.rowPrimaryKey.value === 'string'
                ? {rowPrimaryKey: {fieldKey: item.rowPrimaryKey.fieldKey, value: item.rowPrimaryKey.value}}
                : {}),
        }];
    });
};

const readEntityRules = (action: Action): EntityRuleOption[] => {
    const payload = isRecord(action.payload) ? action.payload : {};
    if (!Array.isArray(payload.entityRules)) {return [];}
    return payload.entityRules.flatMap((item) => {
        if (!isRecord(item)
            || typeof item.profileName !== 'string'
            || typeof item.businessTag !== 'string'
            || !['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'].includes(String(item.entityKind))
            || typeof item.label !== 'string') {return [];}
        const fields: EntityRuleField[] = Array.isArray(item.fields) ? item.fields.flatMap((field) => {
            if (!isRecord(field)
                || typeof field.fieldKey !== 'string'
                || typeof field.label !== 'string'
                || !['entity.field', 'form.field', 'table.filter'].includes(String(field.targetKind))) {return [];}
            return [{fieldKey: field.fieldKey, label: field.label, targetKind: field.targetKind as EntityRuleField['targetKind']}];
        }) : [];
        const actions: EntityRuleAction[] = Array.isArray(item.actions) ? item.actions.flatMap((action) => {
            if (!isRecord(action)
                || typeof action.actionIntent !== 'string'
                || typeof action.label !== 'string'
                || !['entity.action', 'form.action', 'table.module_action'].includes(String(action.targetKind))) {return [];}
            return [{actionIntent: action.actionIntent, label: action.label, targetKind: action.targetKind as EntityRuleAction['targetKind']}];
        }) : [];
        const rowActions: EntityRuleRowAction[] = Array.isArray(item.rowActions) ? item.rowActions.flatMap((action) => {
            if (!isRecord(action)
                || typeof action.actionIntent !== 'string'
                || typeof action.label !== 'string'
                || action.targetKind !== 'table.row_action') {return [];}
            return [{actionIntent: action.actionIntent, label: action.label, targetKind: 'table.row_action' as const}];
        }) : [];
        const primaryKey = isRecord(item.primaryKey)
            && typeof item.primaryKey.fieldKey === 'string'
            && typeof item.primaryKey.label === 'string'
            ? {fieldKey: item.primaryKey.fieldKey, label: item.primaryKey.label}
            : undefined;
        const outputs: EntityRuleOutput[] = Array.isArray(item.outputs) ? item.outputs.flatMap((output) => {
            if (!isRecord(output)
                || !['none', 'table.currentRows', 'table.rowCount'].includes(String(output.kind))
                || typeof output.label !== 'string') {return [];}
            return [{kind: output.kind as OutputKind, label: output.label}];
        }) : [];
        return [{
            profileName: item.profileName,
            businessTag: item.businessTag,
            entityKind: item.entityKind as EntityRuleOption['entityKind'],
            label: item.label,
            fields,
            actions,
            rowActions,
            ...(primaryKey ? {primaryKey} : {}),
            outputs: outputs.length ? outputs : [{kind: 'none' as const, label: '无'}],
        }];
    });
};

const createButton = (label: string, className = ''): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (className) {button.className = className;}
    return button;
};

const createOption = (value: string, label: string): HTMLOptionElement => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
};

const entityOptionKey = (option: EntityRuleOption): string =>
    `${option.profileName}\u0000${option.businessTag}`;

const isInputStep = (step: RecordedStepSummary): boolean =>
    step.stepName === 'browser.fill' || step.stepName === 'browser.type' || step.stepName === 'browser.select_option';

const isActionStep = (step: RecordedStepSummary): boolean => step.stepName === 'browser.click';

const compactValue = (value: unknown): string => {
    if (Array.isArray(value)) {return value.map((item) => compactValue(item)).join('、');}
    if (value === undefined || value === null || value === '') {return ''}
    const text = typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
            ? String(value)
            : JSON.stringify(value);
    return text.length > 32 ? `${text.slice(0, 29)}…` : text;
};

export const mountCheckpointRecorderUI = (options: CheckpointRecorderUIOptions): CheckpointRecorderUIHandle => {
    const style = document.createElement('style');
    style.textContent = `
      .checkpoint-launch { height:38px; padding:0 13px; border:none; border-radius:999px; background:#fff7ed; color:#9a3412; font-size:12px; font-weight:750; cursor:pointer; box-shadow:0 8px 20px rgba(154,52,18,.16); }
      .checkpoint-launch:hover { background:#ffedd5; }
      .checkpoint-launch.active { background:#c2410c; color:#fff; }
      .checkpoint-recorder { position:fixed; left:50%; bottom:14px; z-index:2147483647; width:min(640px,calc(100vw - 24px)); max-height:min(620px,calc(100vh - 28px)); overflow:auto; transform:translateX(-50%); border:1px solid rgba(148,163,184,.42); border-radius:14px; background:rgba(255,255,255,.98); color:#0f172a; box-shadow:0 18px 50px rgba(15,23,42,.28); pointer-events:auto; }
      .checkpoint-recorder[hidden] { display:none; }
      .checkpoint-recorder.setup { left:auto; right:16px; top:68px; bottom:auto; width:min(360px,calc(100vw - 24px)); max-height:calc(100vh - 84px); transform:none; }
      .checkpoint-recorder.dragged { transform:none; }
      .checkpoint-recorder header { min-height:38px; display:flex; align-items:center; gap:8px; padding:7px 8px 7px 12px; border-bottom:1px solid #e2e8f0; cursor:move; user-select:none; touch-action:none; }
      .checkpoint-recorder header strong { flex:1; min-width:0; overflow:hidden; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
      .checkpoint-recorder header small { color:#64748b; font-size:10px; }
      .checkpoint-recorder header button { width:28px; height:28px; padding:0; border:0; border-radius:8px; background:transparent; color:#64748b; font-size:16px; }
      .checkpoint-recorder header button:hover { background:#f1f5f9; }
      .checkpoint-body { display:grid; gap:10px; padding:11px 12px 12px; }
      .checkpoint-status { display:flex; align-items:center; gap:9px; }
      .record-dot { width:9px; height:9px; border-radius:50%; background:#dc2626; box-shadow:0 0 0 4px #fee2e2; animation:checkpoint-pulse 1.4s infinite; }
      .checkpoint-copy { flex:1; min-width:0; color:#334155; font-size:11px; line-height:1.45; }
      .checkpoint-actions { display:flex; justify-content:flex-end; gap:7px; }
      .checkpoint-recorder button { min-height:32px; border:1px solid #cbd5e1; border-radius:9px; padding:0 10px; background:#fff; color:#334155; font-size:11px; font-weight:700; cursor:pointer; }
      .checkpoint-recorder button:hover:not(:disabled) { background:#f8fafc; }
      .checkpoint-recorder button.primary { border-color:#c2410c; background:#c2410c; color:#fff; }
      .checkpoint-recorder button.danger { border-color:#fecaca; background:#fff1f2; color:#b91c1c; }
      .checkpoint-recorder button:disabled { opacity:.45; cursor:default; }
      .checkpoint-recorder label { display:grid; gap:4px; color:#475569; font-size:10px; font-weight:700; }
      .checkpoint-recorder input[type="text"], .checkpoint-recorder select { width:100%; height:34px; box-sizing:border-box; border:1px solid #cbd5e1; border-radius:9px; padding:0 9px; background:#fff; color:#0f172a; font-size:11px; }
      .checkpoint-recorder input:focus-visible, .checkpoint-recorder select:focus-visible, .checkpoint-recorder button:focus-visible, .checkpoint-launch:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
      .checkpoint-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .checkpoint-section { display:grid; gap:7px; padding-top:2px; }
      .checkpoint-section > strong { font-size:11px; }
      .checkpoint-map-list { display:grid; gap:6px; }
      .checkpoint-map-row { display:grid; grid-template-columns:minmax(130px,1fr) minmax(180px,1.25fr); align-items:center; gap:8px; }
      .checkpoint-map-copy { min-width:0; color:#334155; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .checkpoint-map-copy small { color:#64748b; }
      .checkpoint-check { display:flex; grid-column:1/-1; align-items:center; gap:7px; font-size:11px; font-weight:600; }
      .checkpoint-check input { width:15px; height:15px; margin:0; }
      .checkpoint-note { margin:0; padding:8px 9px; border-radius:9px; background:#f8fafc; color:#475569; font-size:11px; line-height:1.45; }
      .checkpoint-error { margin:0; color:#b91c1c; font-size:11px; }
      .checkpoint-success { color:#047857; font-size:11px; font-weight:700; }
      @keyframes checkpoint-pulse { 0%,100% { opacity:1; } 50% { opacity:.45; } }
      @media (max-width:620px) { .checkpoint-grid, .checkpoint-map-row { grid-template-columns:1fr; } .checkpoint-check { grid-column:auto; } }
    `;
    options.surface.getRootNode().appendChild(style);

    const launcher = createButton('录制检查点', 'checkpoint-launch');
    launcher.setAttribute('aria-label', '录制业务检查点或错误恢复');
    launcher.setAttribute('data-rpa-checkpoint-action', 'launch');
    options.launchers.insertBefore(launcher, options.before ?? null);

    const dock = document.createElement('section');
    dock.className = 'checkpoint-recorder';
    dock.hidden = true;
    dock.setAttribute('role', 'dialog');
    dock.setAttribute('aria-label', '检查点录制与标注');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    const subtitle = document.createElement('small');
    const hideButton = createButton('×');
    hideButton.setAttribute('aria-label', '收起检查点面板');
    header.append(title, subtitle, hideButton);
    const body = document.createElement('div');
    body.className = 'checkpoint-body';
    dock.append(header, body);
    options.surface.appendChild(dock);

    const recordingAutoHideMs = Math.max(0, options.recordingAutoHideMs ?? 2400);
    let phase: RecorderPhase = 'idle';
    let busy = false;
    let dockVisible = false;
    let steps: RecordedStepSummary[] = [];
    let entityRules: EntityRuleOption[] = [];
    let error = '';
    const form = {
        kind: 'procedure' as CheckpointKind,
        name: '',
        entityKey: '',
        mappings: {} as Record<string, string>,
        outputKind: 'none' as OutputKind,
        operation: 'any' as OperationKind,
        retryOriginal: true,
    };
    let successTimer: ReturnType<typeof setTimeout> | null = null;
    let recordingHideTimer: ReturnType<typeof setTimeout> | null = null;
    let previewGeneration = 0;
    let drag: {pointerId: number; x: number; y: number; left: number; top: number} | null = null;

    const selectedEntity = (): EntityRuleOption | undefined =>
        entityRules.find((item) => entityOptionKey(item) === form.entityKey);

    const previewSelectedEntity = async (): Promise<void> => {
        const generation = ++previewGeneration;
        const entity = selectedEntity();
        await options.onEntityRulePreview?.(entity ? {
            profileName: entity.profileName,
            businessTag: entity.businessTag,
            entityKind: entity.entityKind,
        } : null);
        if (generation !== previewGeneration) {return;}
    };

    const clearEntityPreview = async (): Promise<void> => {
        previewGeneration += 1;
        await options.onEntityRulePreview?.(null);
    };

    const setDockVisible = (visible: boolean): void => {
        dockVisible = visible;
        dock.hidden = !visible;
    };

    const scheduleRecordingAutoHide = (): void => {
        if (recordingHideTimer) {clearTimeout(recordingHideTimer);}
        recordingHideTimer = setTimeout(() => {
            recordingHideTimer = null;
            if (phase === 'recording') {setDockVisible(false);}
        }, recordingAutoHideMs);
    };

    const reset = (): void => {
        phase = 'idle';
        busy = false;
        steps = [];
        entityRules = [];
        error = '';
        form.kind = 'procedure';
        form.name = '';
        form.entityKey = '';
        form.mappings = {};
        form.outputKind = 'none';
        form.operation = 'any';
        form.retryOriginal = true;
        options.onActiveChange?.(false);
        void clearEntityPreview();
        if (recordingHideTimer) {clearTimeout(recordingHideTimer); recordingHideTimer = null;}
        launcher.textContent = '录制检查点';
        launcher.classList.remove('active');
        setDockVisible(false);
        render();
    };

    const initializeMappings = (): void => {
        const entity = selectedEntity();
        if (!entity) {form.mappings = {}; return;}
        const next: Record<string, string> = {};
        for (const step of steps) {
            if (isInputStep(step)) {
                const exactFieldKey = step.profileName === entity.profileName
                    && step.businessTag === entity.businessTag
                    ? step.fieldKey
                    : undefined;
                const normalizedHint = step.fieldHint?.trim().toLowerCase();
                const matches = entity.fields.filter((field) =>
                    field.fieldKey === exactFieldKey
                    || field.label.trim().toLowerCase() === normalizedHint
                    || field.fieldKey.trim().toLowerCase() === normalizedHint);
                const chosen = matches.at(0) ?? (entity.fields.length === 1 ? entity.fields.at(0) : undefined);
                next[step.stepId] = chosen ? `input:${chosen.fieldKey}` : 'recorded';
            } else if (isActionStep(step)) {
                const exactActionIntent = step.profileName === entity.profileName
                    && step.businessTag === entity.businessTag
                    ? step.actionHint
                    : undefined;
                const normalizedHint = step.actionHint?.trim().toLowerCase();
                if (step.actionRole === 'row'
                    && step.rowPrimaryKey
                    && entity.primaryKey?.fieldKey === step.rowPrimaryKey.fieldKey) {
                    const rowAction = entity.rowActions.find((action) =>
                        action.actionIntent === exactActionIntent
                        || action.actionIntent.trim().toLowerCase() === normalizedHint
                        || action.label.trim().toLowerCase() === normalizedHint);
                    if (rowAction) {
                        next[step.stepId] = `row_action:${rowAction.actionIntent}`;
                        continue;
                    }
                }
                const matches = entity.actions.filter((action) =>
                    action.actionIntent === exactActionIntent
                    || action.actionIntent.trim().toLowerCase() === normalizedHint
                    || action.label.trim().toLowerCase() === normalizedHint
                    || step.label.toLowerCase().includes(action.label.trim().toLowerCase()));
                const chosen = matches.at(0) ?? (entity.actions.length === 1 ? entity.actions.at(0) : undefined);
                next[step.stepId] = chosen ? `action:${chosen.actionIntent}` : 'recorded';
            }
        }
        form.mappings = next;
        if (!entity.outputs.some((output) => output.kind === form.outputKind)) {form.outputKind = 'none';}
    };

    const applyEntityRuleOptions = (action: Action): void => {
        entityRules = readEntityRules(action);
        if (!form.entityKey || !entityRules.some((item) => entityOptionKey(item) === form.entityKey)) {
            form.entityKey = entityRules[0] ? entityOptionKey(entityRules[0]) : '';
        }
    };

    const applyReview = (action: Action): void => {
        steps = readSteps(action);
        applyEntityRuleOptions(action);
        initializeMappings();
    };

    const run = async (type: string, payload?: Record<string, unknown>): Promise<Action | null> => {
        if (busy) {return null;}
        busy = true;
        error = '';
        render();
        try {
            const action = await options.sendAction(type, payload);
            if (action.type.endsWith('.failed')) {error = readFailure(action); return null;}
            return action;
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
            return null;
        } finally {
            busy = false;
            render();
        }
    };

    const openSetup = async (): Promise<void> => {
        const action = await run('checkpoint.record.get', {});
        if (!action) {setDockVisible(true); return;}
        applyEntityRuleOptions(action);
        phase = 'setup';
        options.onActiveChange?.(true);
        setDockVisible(true);
        render();
        await previewSelectedEntity();
    };

    const start = async (): Promise<void> => {
        const entity = selectedEntity();
        if (!entity) {
            error = form.kind === 'recovery'
                ? '请先选择一个已标注的错误状态'
                : '请先选择一个已标注的业务区域';
            render();
            return;
        }
        const action = await run('checkpoint.record.start', {
            kind: form.kind,
            profileName: entity.profileName,
            businessTag: entity.businessTag,
            entityKind: entity.entityKind,
        });
        if (!action) {setDockVisible(true); return;}
        phase = 'recording';
        steps = [];
        launcher.textContent = '录制中';
        launcher.classList.add('active');
        setDockVisible(false);
        render();
    };

    const stop = async (): Promise<void> => {
        if (recordingHideTimer) {clearTimeout(recordingHideTimer); recordingHideTimer = null;}
        const action = await run('checkpoint.record.stop', {});
        if (!action) {return;}
        phase = 'review';
        applyReview(action);
        await clearEntityPreview();
        launcher.textContent = '保存检查点';
        launcher.classList.remove('active');
        setDockVisible(true);
        render();
    };

    const cancel = async (): Promise<void> => {
        const action = await run('checkpoint.record.cancel', {});
        if (!action) {return;}
        reset();
    };

    const restart = async (): Promise<void> => {
        if (recordingHideTimer) {clearTimeout(recordingHideTimer); recordingHideTimer = null;}
        const canceled = await run('checkpoint.record.cancel', {});
        if (!canceled) {return;}
        phase = 'setup';
        setDockVisible(true);
        render();
        await previewSelectedEntity();
    };

    const procedurePayload = (): Record<string, unknown> | null => {
        const entity = selectedEntity();
        if (!entity) {error = '请先完成当前页面的业务标注，再选择成立条件'; return null;}
        const mappings: Array<
            | {stepId: string; kind: 'input'; fieldKey: string}
            | {stepId: string; kind: 'action'; actionIntent: string}
            | {stepId: string; kind: 'row_action'; actionIntent: string; primaryKeyFieldKey: string; inputKey: string}
        > = [];
        for (const [stepId, value] of Object.entries(form.mappings)) {
            if (value.startsWith('input:')) {
                mappings.push({stepId, kind: 'input', fieldKey: value.slice('input:'.length)});
            } else if (value.startsWith('action:')) {
                mappings.push({stepId, kind: 'action', actionIntent: value.slice('action:'.length)});
            } else if (value.startsWith('row_action:') && entity.primaryKey) {
                mappings.push({
                    stepId,
                    kind: 'row_action',
                    actionIntent: value.slice('row_action:'.length),
                    primaryKeyFieldKey: entity.primaryKey.fieldKey,
                    inputKey: entity.primaryKey.fieldKey,
                });
            }
        }
        return {
            kind: 'procedure',
            name: form.name.trim(),
            mappings,
            outputKind: form.outputKind,
        };
    };

    const recoveryPayload = (): Record<string, unknown> => ({
        kind: 'recovery',
        name: form.name.trim(),
        operation: form.operation,
        retryOriginal: form.retryOriginal,
    });

    const save = async (): Promise<void> => {
        if (!form.name.trim()) {error = '请填写检查点名称'; render(); return;}
        const payload = form.kind === 'procedure' ? procedurePayload() : recoveryPayload();
        if (!payload) {render(); return;}
        phase = 'saving';
        const action = await run('checkpoint.record.save', payload);
        if (!action) {phase = 'review'; render(); return;}
        phase = 'success';
        options.onActiveChange?.(false);
        launcher.textContent = '检查点已保存';
        launcher.classList.remove('active');
        render();
        if (successTimer) {clearTimeout(successTimer);}
        successTimer = setTimeout(reset, 3500);
    };

    const appendError = (): void => {
        if (!error) {return;}
        const errorText = document.createElement('p');
        errorText.className = 'checkpoint-error';
        errorText.textContent = error;
        body.appendChild(errorText);
    };

    const renderProcedure = (grid: HTMLElement): void => {
        const entityLabel = document.createElement('label');
        entityLabel.textContent = '成立条件';
        const entitySelect = document.createElement('select');
        entitySelect.setAttribute('data-rpa-checkpoint-field', 'entity');
        if (!entityRules.length) {
            entitySelect.append(createOption('', '当前页面没有可用的业务标注'));
            entitySelect.disabled = true;
        } else {
            for (const entity of entityRules) {
                entitySelect.append(createOption(entityOptionKey(entity), `${entity.label} 可识别时`));
            }
            entitySelect.value = form.entityKey;
        }
        entitySelect.disabled = true;
        entityLabel.appendChild(entitySelect);

        const outputLabel = document.createElement('label');
        outputLabel.textContent = '输出';
        const outputSelect = document.createElement('select');
        outputSelect.setAttribute('data-rpa-checkpoint-field', 'output');
        const entity = selectedEntity();
        for (const output of entity?.outputs ?? [{kind: 'none' as const, label: '无'}]) {
            outputSelect.append(createOption(output.kind, output.label));
        }
        outputSelect.value = form.outputKind;
        outputSelect.addEventListener('change', () => {form.outputKind = outputSelect.value as OutputKind;});
        outputLabel.appendChild(outputSelect);
        grid.append(entityLabel, outputLabel);

        const section = document.createElement('section');
        section.className = 'checkpoint-section';
        const heading = document.createElement('strong');
        heading.textContent = '输入与操作';
        section.appendChild(heading);
        if (!entity) {
            const note = document.createElement('p');
            note.className = 'checkpoint-note';
            note.textContent = '请先标注页面中的业务区域、字段和操作，再创建业务检查点。';
            section.appendChild(note);
            body.appendChild(section);
            return;
        }
        const list = document.createElement('div');
        list.className = 'checkpoint-map-list';
        for (const step of steps) {
            if (!isInputStep(step) && !isActionStep(step)) {continue;}
            const row = document.createElement('label');
            row.className = 'checkpoint-map-row';
            const copy = document.createElement('span');
            copy.className = 'checkpoint-map-copy';
            const recorded = compactValue(step.recordedValue);
            copy.textContent = step.label;
            if (recorded) {
                const sample = document.createElement('small');
                sample.textContent = `（录制值：${recorded}）`;
                copy.appendChild(sample);
            }
            if (step.actionRole === 'row' && step.rowPrimaryKey) {
                const rowSample = document.createElement('small');
                const keyLabel = entity.primaryKey?.fieldKey === step.rowPrimaryKey.fieldKey
                    ? entity.primaryKey.label
                    : step.rowPrimaryKey.fieldKey;
                rowSample.textContent = `（目标行：${keyLabel} = ${step.rowPrimaryKey.value}）`;
                copy.appendChild(rowSample);
            }
            const select = document.createElement('select');
            select.setAttribute('data-rpa-checkpoint-map', step.stepId);
            select.append(createOption('recorded', isInputStep(step) ? '保持录制值' : '保持录制定位'));
            if (isInputStep(step)) {
                for (const field of entity.fields) {select.append(createOption(`input:${field.fieldKey}`, `输入：${field.label}`));}
            } else {
                for (const action of entity.actions) {select.append(createOption(`action:${action.actionIntent}`, `业务操作：${action.label}`));}
                if (entity.primaryKey) {
                    for (const action of entity.rowActions) {
                        select.append(createOption(
                            `row_action:${action.actionIntent}`,
                            `行操作：${action.label}（按${entity.primaryKey.label}定位）`,
                        ));
                    }
                }
            }
            select.value = form.mappings[step.stepId] ?? 'recorded';
            select.addEventListener('change', () => {form.mappings[step.stepId] = select.value;});
            row.append(copy, select);
            list.appendChild(row);
        }
        if (!list.childElementCount) {
            const note = document.createElement('p');
            note.className = 'checkpoint-note';
            note.textContent = '本次录制没有需要参数化的填写或点击操作。';
            list.appendChild(note);
        }
        section.appendChild(list);
        body.appendChild(section);
    };

    const renderRecovery = (grid: HTMLElement): void => {
        const entity = selectedEntity();
        const entityLabel = document.createElement('label');
        entityLabel.textContent = '错误状态';
        const entitySelect = document.createElement('select');
        entitySelect.setAttribute('data-rpa-checkpoint-field', 'entity');
        entitySelect.disabled = true;
        entitySelect.append(createOption(form.entityKey, entity?.label ?? '未选择错误状态'));
        entityLabel.appendChild(entitySelect);

        const operationLabel = document.createElement('label');
        operationLabel.textContent = '原操作类型';
        const operationSelect = document.createElement('select');
        operationSelect.append(
            createOption('any', '任何操作'),
            createOption('click', '点击'),
            createOption('fill', '填写'),
            createOption('select', '选择'),
            createOption('assert', '检查'),
        );
        operationSelect.value = form.operation;
        operationSelect.addEventListener('change', () => {form.operation = operationSelect.value as OperationKind;});
        operationLabel.appendChild(operationSelect);
        grid.append(entityLabel, operationLabel);

        const retryLabel = document.createElement('label');
        retryLabel.className = 'checkpoint-check';
        const retryInput = document.createElement('input');
        retryInput.type = 'checkbox';
        retryInput.checked = form.retryOriginal;
        retryInput.addEventListener('change', () => {form.retryOriginal = retryInput.checked;});
        retryLabel.append(retryInput, document.createTextNode('恢复完成后重试原操作'));
        grid.appendChild(retryLabel);
    };

    const render = (): void => {
        body.replaceChildren();
        dock.classList.toggle('setup', phase === 'setup');
        title.textContent = phase === 'setup'
            ? (form.kind === 'recovery' ? '选择错误状态' : '选择业务区域')
            : phase === 'recording'
                ? '正在录制检查点'
            : phase === 'review' || phase === 'saving'
                ? '标注检查点'
                : phase === 'success'
                    ? '检查点已保存'
                    : '录制检查点';
        subtitle.textContent = phase === 'review' || phase === 'saving' ? `${String(steps.length)} 个操作` : '';
        hideButton.hidden = phase === 'idle';
        launcher.disabled = busy;

        if (phase === 'idle' && error) {
            appendError();
            const actions = document.createElement('div');
            actions.className = 'checkpoint-actions';
            const closeButton = createButton('关闭');
            const retryButton = createButton('重试', 'primary');
            closeButton.addEventListener('click', () => {error = ''; setDockVisible(false); render();});
            retryButton.addEventListener('click', () => {void start();});
            actions.append(closeButton, retryButton);
            body.appendChild(actions);
            return;
        }
        if (phase === 'setup') {
            const grid = document.createElement('div');
            grid.className = 'checkpoint-grid';
            const kindLabel = document.createElement('label');
            kindLabel.textContent = '用途';
            const kindSelect = document.createElement('select');
            kindSelect.setAttribute('data-rpa-checkpoint-field', 'kind');
            kindSelect.append(
                createOption('procedure', '业务过程'),
                createOption('recovery', '错误恢复'),
            );
            kindSelect.value = form.kind;
            kindSelect.addEventListener('change', () => {
                form.kind = kindSelect.value as CheckpointKind;
                render();
                void previewSelectedEntity();
            });
            kindLabel.appendChild(kindSelect);
            grid.appendChild(kindLabel);
            const entityLabel = document.createElement('label');
            entityLabel.textContent = form.kind === 'recovery' ? '错误状态' : '业务区域';
            const entitySelect = document.createElement('select');
            entitySelect.setAttribute('data-rpa-checkpoint-field', 'entity');
            if (!entityRules.length) {
                entitySelect.append(createOption('', '当前页面没有可用的业务标注'));
                entitySelect.disabled = true;
            } else {
                for (const entity of entityRules) {
                    entitySelect.append(createOption(entityOptionKey(entity), entity.label));
                }
                entitySelect.value = form.entityKey;
            }
            entitySelect.addEventListener('change', () => {
                form.entityKey = entitySelect.value;
                render();
                void previewSelectedEntity();
            });
            entityLabel.appendChild(entitySelect);
            grid.appendChild(entityLabel);
            body.appendChild(grid);
            const note = document.createElement('p');
            note.className = 'checkpoint-note';
            note.textContent = form.kind === 'procedure'
                ? '选中的业务区域会保持高亮。录制时可以直接点击和填写页面，高亮不会拦截操作。'
                : '选中的错误状态会保持高亮。录制恢复动作时可以直接操作页面，高亮不会拦截操作。';
            body.appendChild(note);
            appendError();
            const actions = document.createElement('div');
            actions.className = 'checkpoint-actions';
            const cancelButton = createButton('取消');
            const startButton = createButton(busy ? '处理中…' : '开始录制', 'primary');
            cancelButton.setAttribute('data-rpa-checkpoint-action', 'setup-cancel');
            startButton.setAttribute('data-rpa-checkpoint-action', 'start');
            cancelButton.disabled = busy;
            startButton.disabled = busy || !selectedEntity();
            cancelButton.addEventListener('click', () => {reset();});
            startButton.addEventListener('click', () => {void start();});
            actions.append(cancelButton, startButton);
            body.appendChild(actions);
            return;
        }
        if (phase === 'recording') {
            const status = document.createElement('div');
            status.className = 'checkpoint-status';
            const dot = document.createElement('span');
            dot.className = 'record-dot';
            const copy = document.createElement('span');
            copy.className = 'checkpoint-copy';
            copy.textContent = form.kind === 'recovery'
                ? '请在错误状态下完成恢复操作。系统会记录命中的业务字段和操作。'
                : '请在页面上完成这个业务过程，完成后回来确认输入、输出和成立条件。';
            status.append(dot, copy);
            const actions = document.createElement('div');
            actions.className = 'checkpoint-actions';
            const cancelButton = createButton('取消', 'danger');
            const stopButton = createButton(busy ? '处理中…' : '完成录制', 'primary');
            cancelButton.setAttribute('data-rpa-checkpoint-action', 'cancel');
            stopButton.setAttribute('data-rpa-checkpoint-action', 'stop');
            cancelButton.disabled = busy;
            stopButton.disabled = busy;
            cancelButton.addEventListener('click', () => {void cancel();});
            stopButton.addEventListener('click', () => {void stop();});
            actions.append(cancelButton, stopButton);
            body.append(status, actions);
            appendError();
            return;
        }
        if (phase === 'review' || phase === 'saving') {
            const summary = document.createElement('div');
            summary.className = 'checkpoint-copy';
            summary.textContent = steps.length
                ? `已录制：${steps.slice(0, 5).map((step) => step.label).join('、')}${steps.length > 5 ? '…' : ''}`
                : '没有录制到页面操作，请重新录制。';
            body.appendChild(summary);
            const commonGrid = document.createElement('div');
            commonGrid.className = 'checkpoint-grid';
            const nameLabel = document.createElement('label');
            nameLabel.textContent = '名称';
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.placeholder = '例如：查询订单';
            nameInput.maxLength = 80;
            nameInput.value = form.name;
            nameInput.setAttribute('data-rpa-checkpoint-field', 'name');
            nameInput.addEventListener('input', () => {form.name = nameInput.value;});
            nameLabel.appendChild(nameInput);
            const kindLabel = document.createElement('label');
            kindLabel.textContent = '用途';
            const kindSelect = document.createElement('select');
            kindSelect.setAttribute('data-rpa-checkpoint-field', 'kind');
            kindSelect.append(
                createOption('procedure', '业务过程'),
                createOption('recovery', '错误恢复'),
            );
            kindSelect.value = form.kind;
            kindSelect.disabled = true;
            kindLabel.appendChild(kindSelect);
            commonGrid.append(nameLabel, kindLabel);
            body.appendChild(commonGrid);

            const specificGrid = document.createElement('div');
            specificGrid.className = 'checkpoint-grid';
            if (form.kind === 'procedure') {renderProcedure(specificGrid);}
            else {renderRecovery(specificGrid);}
            body.appendChild(specificGrid);
            appendError();

            const actions = document.createElement('div');
            actions.className = 'checkpoint-actions';
            const discardButton = createButton('放弃', 'danger');
            const restartButton = createButton('重新录制');
            const saveButton = createButton(phase === 'saving' || busy ? '保存中…' : '保存检查点', 'primary');
            discardButton.setAttribute('data-rpa-checkpoint-action', 'discard');
            restartButton.setAttribute('data-rpa-checkpoint-action', 'restart');
            saveButton.setAttribute('data-rpa-checkpoint-action', 'save');
            discardButton.disabled = busy;
            restartButton.disabled = busy;
            saveButton.disabled = busy || steps.length === 0 || !selectedEntity();
            discardButton.addEventListener('click', () => {void cancel();});
            restartButton.addEventListener('click', () => {void restart();});
            saveButton.addEventListener('click', () => {void save();});
            actions.append(discardButton, restartButton, saveButton);
            body.appendChild(actions);
            return;
        }
        if (phase === 'success') {
            const message = document.createElement('span');
            message.className = 'checkpoint-success';
            message.textContent = form.kind === 'procedure'
                ? '以后可以用新的输入重复执行这个业务过程。'
                : '以后遇到相同错误时可以自动执行。';
            body.appendChild(message);
        }
    };

    const restore = async (): Promise<void> => {
        try {
            const action = await options.sendAction('checkpoint.record.get', {});
            if (action.type.endsWith('.failed')) {return;}
            const payload = isRecord(action.payload) ? action.payload : {};
            const status = payload.status;
            applyEntityRuleOptions(action);
            if (status !== 'recording' && status !== 'review') {return;}
            phase = status;
            if (payload.kind === 'recovery') {form.kind = 'recovery';}
            const entityRule = isRecord(payload.entityRule) ? payload.entityRule : null;
            const selected = entityRule
                ? entityRules.find((entity) =>
                    entity.profileName === entityRule.profileName
                    && entity.businessTag === entityRule.businessTag)
                : undefined;
            if (selected) {form.entityKey = entityOptionKey(selected);}
            if (status === 'review') {applyReview(action);} else {steps = readSteps(action);}
            options.onActiveChange?.(true);
            launcher.textContent = status === 'recording' ? '录制中' : '保存检查点';
            launcher.classList.toggle('active', status === 'recording');
            setDockVisible(true);
            render();
            if (status === 'recording') {
                await previewSelectedEntity();
                scheduleRecordingAutoHide();
            }
        } catch {
            // Explicit launcher remains available when state recovery is unavailable.
        }
    };

    launcher.addEventListener('click', () => {
        if (phase === 'idle') {void openSetup(); return;}
        setDockVisible(!dockVisible);
    });
    hideButton.addEventListener('click', (event) => {
        event.stopPropagation();
        if (phase === 'setup') {
            reset();
            return;
        }
        setDockVisible(false);
    });
    const onDocumentKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') {return;}
        if (phase === 'idle' || phase === 'saving' || phase === 'success') {return;}
        if ((phase === 'recording' || phase === 'review') && !dockVisible) {return;}
        event.preventDefault();
        event.stopImmediatePropagation();
        if (phase === 'setup') {
            reset();
            return;
        }
        setDockVisible(false);
    };
    dock.ownerDocument.addEventListener('keydown', onDocumentKeyDown, true);
    header.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target === hideButton) {return;}
        const rect = dock.getBoundingClientRect();
        dock.classList.add('dragged');
        dock.style.left = `${String(rect.left)}px`;
        dock.style.top = `${String(rect.top)}px`;
        dock.style.bottom = 'auto';
        drag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top};
        header.setPointerCapture(event.pointerId);
        event.preventDefault();
    });
    header.addEventListener('pointermove', (event) => {
        const activeDrag = drag;
        if (activeDrag?.pointerId !== event.pointerId) {return;}
        const rect = dock.getBoundingClientRect();
        const left = Math.max(8, Math.min(activeDrag.left + event.clientX - activeDrag.x, window.innerWidth - rect.width - 8));
        const top = Math.max(8, Math.min(activeDrag.top + event.clientY - activeDrag.y, window.innerHeight - rect.height - 8));
        dock.style.left = `${String(left)}px`;
        dock.style.top = `${String(top)}px`;
    });
    const endDrag = (event: PointerEvent): void => {
        if (drag?.pointerId !== event.pointerId) {return;}
        if (header.hasPointerCapture(event.pointerId)) {header.releasePointerCapture(event.pointerId);}
        drag = null;
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);

    render();
    void restore();
    return {
        setVisible: (visible) => {
            launcher.hidden = !visible;
            if (!visible) {dock.hidden = true;}
            else if (dockVisible) {dock.hidden = false;}
        },
        onPageChanged: () => {
            if (phase === 'setup') {
                reset();
            } else {
                void clearEntityPreview();
            }
        },
        unmount: () => {
            previewGeneration += 1;
            options.onActiveChange?.(false);
            void options.onEntityRulePreview?.(null);
            dock.ownerDocument.removeEventListener('keydown', onDocumentKeyDown, true);
            if (successTimer) {clearTimeout(successTimer);}
            if (recordingHideTimer) {clearTimeout(recordingHideTimer);}
            launcher.remove();
            dock.remove();
            style.remove();
        },
    };
};
