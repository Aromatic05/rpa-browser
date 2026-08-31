/**
 * Interaction cards (spec §7): the typed waiting-state union. Cards render only
 * backend-provided data and emit typed product intents; they never invent
 * unsupported actions (no fake `recompute`/`abort`, no raw ids).
 */
import type { GuidanceMode, InteractionRequest } from '../model/contracts.js';
import { validateClarificationValue } from '../model/projection.js';
import {
    button,
    card,
    cardTitle,
    detailsBlock,
    el,
    elAttrs,
    fieldLabel,
    hint,
    isMutationDisabled,
    muted,
    statusLine,
    stopButton,
    type SurfaceContext,
} from './common.js';

const renderApprovalCard = (ctx: SurfaceContext, interaction: Extract<InteractionRequest, { kind: 'approval' }>): HTMLElement => {
    const disabled = isMutationDisabled(ctx);
    const cardBody: Array<Node | string> = [
        statusLine('⚠', 'Approval needed · irreversible effect', 'waiting'),
        cardTitle(`The agent will: ${interaction.effectName}`),
        muted(interaction.risk),
    ];
    if (interaction.evidence) {
        cardBody.push(muted(`Evidence: ${interaction.evidence}`));
    }
    if (interaction.details && interaction.details.length > 0) {
        cardBody.push(detailsBlock('Details', interaction.details));
    }
    const row = el('div', 'rpa-row');
    row.append(
        button('Approve', () => { ctx.commands.approve(); }, 'primary', { disabled, dataAction: 'approve' }),
        button(
            'Deny',
            () => {
                ctx.ui.denyOpen = !ctx.ui.denyOpen;
                ctx.ui.denyError = false;
                ctx.rerender();
            },
            'ghost',
            { disabled, dataAction: 'deny' },
        ),
    );
    cardBody.push(row);
    if (ctx.ui.denyOpen) {
        const denyFields = el('div', 'rpa-block');
        denyFields.append(fieldLabel('Reason (required)'));
        const reasonInput = document.createElement('input');
        reasonInput.className = 'rpa-input';
        reasonInput.value = ctx.ui.denyReason;
        reasonInput.dataset.rpaProductField = 'deny-reason';
        reasonInput.addEventListener('input', () => {
            ctx.ui.denyReason = reasonInput.value;
            ctx.ui.denyError = false;
        });
        denyFields.append(reasonInput);
        denyFields.append(fieldLabel('Requested alternative (optional)'));
        const alternativeInput = document.createElement('input');
        alternativeInput.className = 'rpa-input';
        alternativeInput.value = ctx.ui.requestedAlternative;
        alternativeInput.dataset.rpaProductField = 'deny-alternative';
        alternativeInput.addEventListener('input', () => {
            ctx.ui.requestedAlternative = alternativeInput.value;
        });
        denyFields.append(alternativeInput);
        if (ctx.ui.denyError) {
            denyFields.append(elAttrs('div', 'rpa-error-strip', { 'data-rpa-product-error': 'deny' }, ['Reason is required.']));
        }
        denyFields.append(
            button(
                'Submit Denial',
                () => {
                    const reason = ctx.ui.denyReason.trim();
                    if (reason.length === 0) {
                        ctx.ui.denyError = true;
                        ctx.rerender();
                        return;
                    }
                    const alternative = ctx.ui.requestedAlternative.trim();
                    ctx.commands.deny(reason, alternative.length > 0 ? alternative : undefined);
                },
                'ghost',
                { disabled, dataAction: 'submit-denial' },
            ),
        );
        cardBody.push(denyFields);
    }
    const cardNode = cardBase('approval', cardBody);
    cardNode.append(stopButton(ctx));
    return cardNode;
};

const renderClarificationControl = (ctx: SurfaceContext, interaction: Extract<InteractionRequest, { kind: 'clarification' }>): HTMLElement => {
    const schema = interaction.schema;
    if (schema.type === 'select') {
        const select = document.createElement('select');
        select.className = 'rpa-select';
        select.dataset.rpaProductField = 'clarification';
        for (const option of schema.allowed ?? []) {
            const opt = el('option', undefined, [option.label]);
            opt.setAttribute('value', option.value);
            select.append(opt);
        }
        select.value = ctx.ui.clarificationValue;
        select.addEventListener('change', () => {
            ctx.ui.clarificationValue = select.value;
            ctx.ui.clarificationError = null;
        });
        return select;
    }
    const input = document.createElement('input');
    input.className = 'rpa-input';
    input.dataset.rpaProductField = 'clarification';
    input.type = schema.type === 'date' ? 'date' : schema.type === 'number' ? 'number' : 'text';
    if (schema.maxLength !== undefined) {
        input.maxLength = schema.maxLength;
    }
    input.value = ctx.ui.clarificationValue;
    input.addEventListener('input', () => {
        ctx.ui.clarificationValue = input.value;
        ctx.ui.clarificationError = null;
    });
    return input;
};

const renderClarificationCard = (ctx: SurfaceContext, interaction: Extract<InteractionRequest, { kind: 'clarification' }>): HTMLElement => {
    const disabled = isMutationDisabled(ctx);
    if (ctx.ui.clarificationToken !== interaction.interactionToken) {
        ctx.ui.clarificationToken = interaction.interactionToken;
        ctx.ui.clarificationValue = interaction.schema.default ?? '';
        ctx.ui.clarificationError = null;
    }
    const cardBody: Array<Node | string> = [
        statusLine('❓', 'Question', 'waiting'),
        cardTitle(interaction.question),
        fieldLabel(interaction.schema.field),
        renderClarificationControl(ctx, interaction),
    ];
    if (ctx.ui.clarificationError) {
        cardBody.push(
            elAttrs('div', 'rpa-error-strip', { 'data-rpa-product-error': 'clarification' }, [ctx.ui.clarificationError]),
        );
    }
    cardBody.push(
        button(
            'Submit Answer',
            () => {
                const error = validateClarificationValue(ctx.ui.clarificationValue, interaction.schema);
                if (error) {
                    ctx.ui.clarificationError = error;
                    ctx.rerender();
                    return;
                }
                ctx.commands.answerClarification(ctx.ui.clarificationValue);
            },
            'primary',
            { disabled, dataAction: 'submit-answer' },
        ),
    );
    const cardNode = cardBase('clarification', cardBody);
    cardNode.append(stopButton(ctx));
    return cardNode;
};

const renderRecoveryOptions = (ctx: SurfaceContext, interaction: Extract<InteractionRequest, { kind: 'recovery_decision' }>): HTMLElement => {
    const options = el('div', 'rpa-options');
    const eligibleIds = interaction.options.filter((option) => option.eligible).map((option) => option.id);
    if (ctx.ui.selectedRecovery === null || !eligibleIds.includes(ctx.ui.selectedRecovery)) {
        ctx.ui.selectedRecovery = interaction.recommendedOptionId ?? (eligibleIds.length > 0 ? eligibleIds[0] : null);
    }
    for (const option of interaction.options) {
        const optionRow = el('label', 'rpa-option');
        if (option.id === interaction.recommendedOptionId) {
            optionRow.classList.add('rpa-option--recommended');
        }
        if (!option.eligible) {
            optionRow.classList.add('rpa-option--disabled');
        }
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'rpa-recovery-option';
        radio.value = option.id;
        radio.checked = ctx.ui.selectedRecovery === option.id;
        radio.disabled = !option.eligible;
        radio.dataset.rpaProductField = 'recovery-option';
        radio.addEventListener('change', () => {
            if (radio.checked) {
                ctx.ui.selectedRecovery = option.id;
            }
        });
        const text = option.kind === 'terminate' ? 'End task as failed' : option.label;
        const body = el('span', undefined, [text]);
        if (!option.eligible && option.block) {
            body.append(hint(`Blocked: ${option.block}`));
        }
        optionRow.append(radio, body);
        options.append(optionRow);
    }
    return options;
};

const renderRecoveryCard = (ctx: SurfaceContext, interaction: Extract<InteractionRequest, { kind: 'recovery_decision' }>): HTMLElement => {
    const disabled = isMutationDisabled(ctx);
    const cardBody: Array<Node | string> = [
        statusLine('↻', 'Recovery decision', 'waiting'),
        muted('A step failed.'),
        muted(interaction.failureSummary),
    ];
    if (interaction.evidence) {
        cardBody.push(muted(`Evidence: ${interaction.evidence}`));
    }
    if (interaction.details && interaction.details.length > 0) {
        cardBody.push(detailsBlock('Details', interaction.details));
    }
    cardBody.push(renderRecoveryOptions(ctx, interaction));
    cardBody.push(
        button(
            'Choose Recovery',
            () => {
                if (ctx.ui.selectedRecovery) {
                    ctx.commands.chooseRecovery(ctx.ui.selectedRecovery);
                }
            },
            'primary',
            { disabled: disabled || !ctx.ui.selectedRecovery, dataAction: 'choose-recovery' },
        ),
    );
    const cardNode = cardBase('recovery_decision', cardBody);
    cardNode.append(stopButton(ctx));
    return cardNode;
};

const GUIDANCE_LABELS: Record<GuidanceMode, string> = {
    manual: 'Take Over',
    teach: 'Teach by example',
    annotate: 'Annotate page',
};

const renderTakeoverCard = (ctx: SurfaceContext, interaction: Extract<InteractionRequest, { kind: 'takeover' }>): HTMLElement => {
    const disabled = isMutationDisabled(ctx);
    const scopeCopy = interaction.scope === 'tab' ? 'this tab' : 'this workspace';
    const cardBody: Array<Node | string> = [
        statusLine('✋', 'Manual control needed', 'waiting'),
        cardTitle('You can operate the page yourself'),
        muted(`${interaction.reason} Scope: ${scopeCopy}.`),
    ];
    const modesRow = el('div', 'rpa-row');
    for (const mode of interaction.guidanceModes) {
        modesRow.append(
            button(
                GUIDANCE_LABELS[mode],
                () => {
                    ctx.commands.beginHumanGuidance(mode);
                },
                mode === 'manual' ? 'primary' : 'ghost',
                { disabled, dataAction: `guidance-${mode}` },
            ),
        );
    }
    cardBody.push(modesRow);
    const activeMode = interaction.activeMode ?? (interaction.stage === 'active' ? 'manual' : undefined);
    if (activeMode) {
        cardBody.push(renderTakeoverActive(ctx, activeMode));
    }
    const cardNode = cardBase('takeover', cardBody);
    cardNode.append(stopButton(ctx));
    return cardNode;
};

/** Spec §8: persistent banner while the human is in control. */
const renderTakeoverActive = (ctx: SurfaceContext, mode: GuidanceMode): HTMLElement => {
    const modeCopy = mode === 'manual' ? 'manual' : mode === 'teach' ? 'teaching' : 'annotation';
    const banner = el('div', 'rpa-human-control-banner');
    banner.append(
        statusLine('⚑', 'You are in control', 'waiting'),
        muted(`The agent has paused its actions. ${modeCopy} is active.`),
    );
    const row = el('div', 'rpa-row');
    row.append(
        button(
            'Return Control',
            () => {
                ctx.commands.returnControl();
            },
            'primary',
            { disabled: isMutationDisabled(ctx), dataAction: 'return-control' },
        ),
    );
    banner.append(row);
    return banner;
};

const cardBase = (kind: InteractionRequest['kind'], children: Array<Node | string>): HTMLElement => {
    const node = card(children);
    node.dataset.rpaProductCard = kind;
    return node;
};

export const renderInteractionCard = (root: HTMLElement, ctx: SurfaceContext, interaction: InteractionRequest): void => {
    switch (interaction.kind) {
        case 'approval':
            root.append(renderApprovalCard(ctx, interaction));
            break;
        case 'clarification':
            root.append(renderClarificationCard(ctx, interaction));
            break;
        case 'recovery_decision':
            root.append(renderRecoveryCard(ctx, interaction));
            break;
        case 'takeover':
            root.append(renderTakeoverCard(ctx, interaction));
            break;
    }
};