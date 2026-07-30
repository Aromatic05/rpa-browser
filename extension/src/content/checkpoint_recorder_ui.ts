import type {Action} from '../shared/types.js';

type RecordedStepSummary = {index: number; label: string};
type RecorderPhase = 'idle' | 'recording' | 'review' | 'saving' | 'success';
type TriggerKind = 'not_found' | 'text_visible' | 'url_includes';
type OperationKind = 'any' | 'click' | 'fill' | 'select' | 'assert';

export type CheckpointRecorderUIOptions = {
    launchers: HTMLElement;
    surface: HTMLElement;
    before?: Node | null;
    sendAction: (type: string, payload?: Record<string, unknown>) => Promise<Action>;
    onActiveChange?: (active: boolean) => void;
    recordingAutoHideMs?: number;
};

export type CheckpointRecorderUIHandle = {
    setVisible: (visible: boolean) => void;
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
        if (!isRecord(item) || typeof item.index !== 'number' || typeof item.label !== 'string') {return [];}
        return [{index: item.index, label: item.label}];
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

export const mountCheckpointRecorderUI = (options: CheckpointRecorderUIOptions): CheckpointRecorderUIHandle => {
    const style = document.createElement('style');
    style.textContent = `
      .checkpoint-launch { height:38px; padding:0 13px; border:none; border-radius:999px; background:#fff7ed; color:#9a3412; font-size:12px; font-weight:750; cursor:pointer; box-shadow:0 8px 20px rgba(154,52,18,.16); }
      .checkpoint-launch:hover { background:#ffedd5; }
      .checkpoint-launch.active { background:#c2410c; color:#fff; }
      .checkpoint-recorder { position:fixed; left:50%; bottom:14px; z-index:2147483647; width:min(560px,calc(100vw - 24px)); transform:translateX(-50%); border:1px solid rgba(148,163,184,.42); border-radius:14px; background:rgba(255,255,255,.98); color:#0f172a; box-shadow:0 18px 50px rgba(15,23,42,.28); pointer-events:auto; }
      .checkpoint-recorder[hidden] { display:none; }
      .checkpoint-recorder.dragged { transform:none; }
      .checkpoint-recorder header { min-height:38px; display:flex; align-items:center; gap:8px; padding:7px 8px 7px 12px; border-bottom:1px solid #e2e8f0; cursor:move; user-select:none; touch-action:none; }
      .checkpoint-recorder header strong { flex:1; min-width:0; overflow:hidden; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
      .checkpoint-recorder header small { color:#64748b; font-size:10px; }
      .checkpoint-recorder header button { width:28px; height:28px; padding:0; border:0; border-radius:8px; background:transparent; color:#64748b; font-size:16px; }
      .checkpoint-recorder header button:hover { background:#f1f5f9; }
      .checkpoint-recorder .checkpoint-body { display:grid; gap:9px; padding:11px 12px 12px; }
      .checkpoint-recorder .checkpoint-status { display:flex; align-items:center; gap:9px; }
      .checkpoint-recorder .record-dot { width:9px; height:9px; border-radius:50%; background:#dc2626; box-shadow:0 0 0 4px #fee2e2; animation:checkpoint-pulse 1.4s infinite; }
      .checkpoint-recorder .checkpoint-copy { flex:1; min-width:0; color:#334155; font-size:11px; line-height:1.4; }
      .checkpoint-recorder .checkpoint-actions { display:flex; justify-content:flex-end; gap:7px; }
      .checkpoint-recorder button { min-height:32px; border:1px solid #cbd5e1; border-radius:9px; padding:0 10px; background:#fff; color:#334155; font-size:11px; font-weight:700; cursor:pointer; }
      .checkpoint-recorder button:hover:not(:disabled) { background:#f8fafc; }
      .checkpoint-recorder button.primary { border-color:#c2410c; background:#c2410c; color:#fff; }
      .checkpoint-recorder button.danger { border-color:#fecaca; background:#fff1f2; color:#b91c1c; }
      .checkpoint-recorder button:disabled { opacity:.45; cursor:default; }
      .checkpoint-recorder label { display:grid; gap:4px; color:#475569; font-size:10px; font-weight:700; }
      .checkpoint-recorder input[type="text"], .checkpoint-recorder select { width:100%; height:34px; box-sizing:border-box; border:1px solid #cbd5e1; border-radius:9px; padding:0 9px; background:#fff; color:#0f172a; font-size:11px; }
      .checkpoint-recorder input:focus-visible, .checkpoint-recorder select:focus-visible, .checkpoint-recorder button:focus-visible, .checkpoint-launch:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
      .checkpoint-recorder .checkpoint-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .checkpoint-recorder .checkpoint-check { display:flex; grid-column:1/-1; align-items:center; gap:7px; font-size:11px; font-weight:600; }
      .checkpoint-recorder .checkpoint-check input { width:15px; height:15px; margin:0; }
      .checkpoint-recorder .checkpoint-error { margin:0; color:#b91c1c; font-size:11px; }
      .checkpoint-recorder .checkpoint-success { color:#047857; font-size:11px; font-weight:700; }
      @keyframes checkpoint-pulse { 0%,100% { opacity:1; } 50% { opacity:.45; } }
      @media (max-width:620px) { .checkpoint-recorder .checkpoint-grid { grid-template-columns:1fr; } .checkpoint-recorder .checkpoint-check { grid-column:auto; } }
    `;
    options.surface.getRootNode().appendChild(style);

    const launcher = createButton('录制恢复', 'checkpoint-launch');
    launcher.setAttribute('aria-label', '录制页面失败后的恢复步骤');
    launcher.setAttribute('data-rpa-checkpoint-action', 'launch');
    options.launchers.insertBefore(launcher, options.before ?? null);

    const dock = document.createElement('section');
    dock.className = 'checkpoint-recorder';
    dock.hidden = true;
    dock.setAttribute('role', 'dialog');
    dock.setAttribute('aria-label', '录制恢复步骤');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    const subtitle = document.createElement('small');
    const hideButton = createButton('×');
    hideButton.setAttribute('aria-label', '收起恢复步骤面板');
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
    let error = '';
    const form = {
        name: '',
        triggerKind: 'not_found' as TriggerKind,
        triggerValue: '',
        operation: 'any' as OperationKind,
        retryOriginal: true,
    };
    let successTimer: ReturnType<typeof setTimeout> | null = null;
    let recordingHideTimer: ReturnType<typeof setTimeout> | null = null;
    let drag: {pointerId: number; x: number; y: number; left: number; top: number} | null = null;

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
        error = '';
        form.name = '';
        form.triggerKind = 'not_found';
        form.triggerValue = '';
        form.operation = 'any';
        form.retryOriginal = true;
        options.onActiveChange?.(false);
        if (recordingHideTimer) {clearTimeout(recordingHideTimer); recordingHideTimer = null;}
        launcher.textContent = '录制恢复';
        launcher.classList.remove('active');
        setDockVisible(false);
        render();
    };

    const run = async (type: string, payload?: Record<string, unknown>): Promise<Action | null> => {
        if (busy) {return null;}
        busy = true;
        error = '';
        render();
        try {
            const reply = await options.sendAction(type, payload);
            if (reply.type.endsWith('.failed')) {
                error = readFailure(reply);
                return null;
            }
            return reply;
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
            return null;
        } finally {
            busy = false;
            render();
        }
    };

    const start = async (): Promise<void> => {
        const reply = await run('checkpoint.record.start', {});
        if (!reply) {setDockVisible(true); return;}
        phase = 'recording';
        steps = [];
        options.onActiveChange?.(true);
        launcher.textContent = '录制中';
        launcher.classList.add('active');
        setDockVisible(true);
        render();
        scheduleRecordingAutoHide();
    };

    const stop = async (): Promise<void> => {
        if (recordingHideTimer) {clearTimeout(recordingHideTimer); recordingHideTimer = null;}
        const reply = await run('checkpoint.record.stop', {});
        if (!reply) {return;}
        phase = 'review';
        steps = readSteps(reply);
        launcher.textContent = '保存恢复步骤';
        launcher.classList.remove('active');
        render();
    };

    const cancel = async (): Promise<void> => {
        const reply = await run('checkpoint.record.cancel', {});
        if (!reply) {return;}
        reset();
    };

    const restart = async (): Promise<void> => {
        if (recordingHideTimer) {clearTimeout(recordingHideTimer); recordingHideTimer = null;}
        const canceled = await run('checkpoint.record.cancel', {});
        if (!canceled) {return;}
        phase = 'idle';
        await start();
    };

    const save = async (): Promise<void> => {
        if (!form.name.trim()) {error = '请填写恢复步骤名称'; render(); return;}
        if (form.triggerKind !== 'not_found' && !form.triggerValue.trim()) {
            error = form.triggerKind === 'text_visible' ? '请填写页面文字' : '请填写地址内容';
            render();
            return;
        }
        phase = 'saving';
        const reply = await run('checkpoint.record.save', {
            name: form.name.trim(),
            triggerKind: form.triggerKind,
            triggerValue: form.triggerValue.trim(),
            operation: form.operation,
            retryOriginal: form.retryOriginal,
        });
        if (!reply) {phase = 'review'; render(); return;}
        phase = 'success';
        options.onActiveChange?.(false);
        launcher.textContent = '已保存恢复步骤';
        launcher.classList.remove('active');
        render();
        if (successTimer) {clearTimeout(successTimer);}
        successTimer = setTimeout(reset, 3500);
    };

    const render = (): void => {
        body.replaceChildren();
        title.textContent = phase === 'recording'
            ? '正在录制恢复步骤'
            : phase === 'review' || phase === 'saving'
                ? '标注恢复步骤'
                : phase === 'success'
                    ? '恢复步骤已保存'
                    : '录制恢复步骤';
        subtitle.textContent = phase === 'review' || phase === 'saving' ? `${String(steps.length)} 个操作` : '';
        hideButton.hidden = phase === 'idle';
        launcher.disabled = busy;

        if (phase === 'idle' && error) {
            const errorText = document.createElement('p');
            errorText.className = 'checkpoint-error';
            errorText.textContent = error;
            const actions = document.createElement('div');
            actions.className = 'checkpoint-actions';
            const closeButton = createButton('关闭');
            const retryButton = createButton('重试', 'primary');
            closeButton.addEventListener('click', () => {error = ''; setDockVisible(false); render();});
            retryButton.addEventListener('click', () => {void start();});
            actions.append(closeButton, retryButton);
            body.append(errorText, actions);
        } else if (phase === 'recording') {
            const status = document.createElement('div');
            status.className = 'checkpoint-status';
            const dot = document.createElement('span');
            dot.className = 'record-dot';
            const copy = document.createElement('span');
            copy.className = 'checkpoint-copy';
            copy.textContent = '请在页面上完成处理异常所需的操作。';
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
        } else if (phase === 'review' || phase === 'saving') {
            const summary = document.createElement('div');
            summary.className = 'checkpoint-copy';
            summary.textContent = steps.length
                ? `已录制：${steps.slice(0, 5).map((step) => step.label).join('、')}${steps.length > 5 ? '…' : ''}`
                : '没有录制到页面操作，请重新录制。';
            const nameLabel = document.createElement('label');
            nameLabel.textContent = '名称';
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.placeholder = '例如：关闭登录失效提示';
            nameInput.maxLength = 80;
            nameInput.value = form.name;
            nameInput.addEventListener('input', () => {form.name = nameInput.value;});
            nameLabel.appendChild(nameInput);
            const grid = document.createElement('div');
            grid.className = 'checkpoint-grid';
            const triggerLabel = document.createElement('label');
            triggerLabel.textContent = '操作失败时，如果';
            const triggerSelect = document.createElement('select');
            triggerSelect.append(
                createOption('not_found', '找不到要操作的内容'),
                createOption('text_visible', '页面出现指定文字'),
                createOption('url_includes', '页面地址包含指定内容'),
            );
            triggerSelect.value = form.triggerKind;
            triggerSelect.addEventListener('change', () => {form.triggerKind = triggerSelect.value as TriggerKind;});
            triggerLabel.appendChild(triggerSelect);
            const operationLabel = document.createElement('label');
            operationLabel.textContent = '失败的操作';
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
            const triggerValueLabel = document.createElement('label');
            triggerValueLabel.hidden = true;
            const triggerValueCaption = document.createElement('span');
            const triggerValueInput = document.createElement('input');
            triggerValueInput.type = 'text';
            triggerValueInput.maxLength = 160;
            triggerValueInput.value = form.triggerValue;
            triggerValueInput.addEventListener('input', () => {form.triggerValue = triggerValueInput.value;});
            triggerValueLabel.append(triggerValueCaption, triggerValueInput);
            const updateTriggerInput = (): void => {
                const kind = triggerSelect.value as TriggerKind;
                triggerValueLabel.hidden = kind === 'not_found';
                triggerValueCaption.textContent = kind === 'text_visible' ? '页面文字' : '地址包含';
                triggerValueInput.placeholder = kind === 'text_visible' ? '例如：登录已失效' : '例如：/login';
            };
            triggerSelect.addEventListener('change', updateTriggerInput);
            updateTriggerInput();
            const retryLabel = document.createElement('label');
            retryLabel.className = 'checkpoint-check';
            const retryInput = document.createElement('input');
            retryInput.type = 'checkbox';
            retryInput.checked = form.retryOriginal;
            retryInput.addEventListener('change', () => {form.retryOriginal = retryInput.checked;});
            retryLabel.append(retryInput, document.createTextNode('处理完成后重试原操作'));
            grid.append(triggerLabel, operationLabel, triggerValueLabel, retryLabel);
            const actions = document.createElement('div');
            actions.className = 'checkpoint-actions';
            const discardButton = createButton('放弃', 'danger');
            const restartButton = createButton('重新录制');
            const saveButton = createButton(phase === 'saving' || busy ? '保存中…' : '保存恢复步骤', 'primary');
            discardButton.setAttribute('data-rpa-checkpoint-action', 'discard');
            restartButton.setAttribute('data-rpa-checkpoint-action', 'restart');
            saveButton.setAttribute('data-rpa-checkpoint-action', 'save');
            discardButton.disabled = busy;
            restartButton.disabled = busy;
            saveButton.disabled = busy || steps.length === 0;
            discardButton.addEventListener('click', () => {void cancel();});
            restartButton.addEventListener('click', () => {void restart();});
            saveButton.addEventListener('click', () => {void save();});
            actions.append(discardButton, restartButton, saveButton);
            body.append(summary, nameLabel, grid);
            if (error) {
                const errorText = document.createElement('p');
                errorText.className = 'checkpoint-error';
                errorText.textContent = error;
                body.appendChild(errorText);
            }
            body.appendChild(actions);
        } else if (phase === 'success') {
            const message = document.createElement('span');
            message.className = 'checkpoint-success';
            message.textContent = '以后遇到相同情况时可以自动执行。';
            body.appendChild(message);
        }
        if (error && phase === 'recording') {
            const errorText = document.createElement('p');
            errorText.className = 'checkpoint-error';
            errorText.textContent = error;
            body.prepend(errorText);
        }
    };

    const restore = async (): Promise<void> => {
        try {
            const reply = await options.sendAction('checkpoint.record.get', {});
            if (reply.type.endsWith('.failed')) {return;}
            const payload = isRecord(reply.payload) ? reply.payload : {};
            const status = payload.status;
            if (status !== 'recording' && status !== 'review') {return;}
            steps = readSteps(reply);
            phase = status;
            options.onActiveChange?.(true);
            launcher.textContent = status === 'recording' ? '录制中' : '保存恢复步骤';
            launcher.classList.toggle('active', status === 'recording');
            setDockVisible(true);
            render();
            if (status === 'recording') {scheduleRecordingAutoHide();}
        } catch {
            // Recovery is opportunistic. The explicit launcher remains available.
        }
    };

    launcher.addEventListener('click', () => {
        if (phase === 'idle') {void start(); return;}
        setDockVisible(!dockVisible);
    });
    hideButton.addEventListener('click', (event) => {
        event.stopPropagation();
        setDockVisible(false);
    });
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
        unmount: () => {
            options.onActiveChange?.(false);
            if (successTimer) {clearTimeout(successTimer);}
            if (recordingHideTimer) {clearTimeout(recordingHideTimer);}
            launcher.remove();
            dock.remove();
            style.remove();
        },
    };
};
