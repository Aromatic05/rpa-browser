import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    buildTableSnapshot,
} from '../../src/automation/snapshot';
import type { PageSnapshotSessionEntry } from '../../src/automation/snapshot';
import type { RuntimeStateRecord } from '../../src/automation/snapshot/observation/model/contracts';
import type { WorldView, WorldViewSource } from '../../src/agent/worldview/contracts';
import type { AgentEvalFixtureSpec } from '../../src/agent/execution/eval/world';
import type { AgentFaultWorld } from '../../src/agent/execution/eval/faults/contracts';

/**
 * Fabricated Snapshot V2 WorldView over the committed fault world port. The
 * agent logic is the production Program-first / react-baseline runner; the
 * browser port is the fault world. This helper renders the fixture state as a
 * valid PageSnapshotSessionEntry so the production DSL debug session, effect
 * journal, compensation planner and world diff all run unchanged.
 */

const active = (): {
    hiddenByStyle: boolean;
    inert: boolean;
    selfHasBox: boolean;
    rendered: boolean;
} => ({
    hiddenByStyle: false,
    inert: false,
    selfHasBox: true,
    rendered: true,
});

type RawNode = {
    captureId: string;
    scopeId: string;
    parentCaptureId?: string;
    childCaptureIds: string[];
    tag: string;
    attributes: Record<string, string>;
    ownText?: string;
    backendNodeId?: string;
    runtimeStateToken?: string;
    activity: ReturnType<typeof active>;
};

const node = (
    captureId: string,
    tag: string,
    parent: string | undefined,
    children: readonly string[],
    attributes: Record<string, string> = {},
    ownText?: string,
    token?: string,
): RawNode => ({
    captureId,
    scopeId: 'main',
    parentCaptureId: parent,
    childCaptureIds: [...children],
    tag,
    attributes,
    ownText,
    backendNodeId: captureId,
    ...(token ? { runtimeStateToken: token } : {}),
    activity: active(),
});

const completeness = {
    dom: 'complete',
    a11y: 'complete',
    runtime: 'complete',
    geometry: 'complete',
} as const;

const buildRaw = (
    spec: AgentEvalFixtureSpec,
    values: Readonly<Record<string, string>>,
    epoch: number,
    revision: number,
): {
    raw: Parameters<typeof buildPageObservation>[0];
    fieldInputId: Readonly<Record<string, string>>;
    buttonId: Readonly<Record<string, string>>;
} => {
    const fieldInputId: Record<string, string> = {};
    const buttonId: Record<string, string> = {};
    const nodes: RawNode[] = [
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form']),
    ];
    const formChildren: string[] = ['form-label'];
    nodes.push(node('form-label', 'label', 'form', [], { for: 'FaultName' }, 'Name'));
    for (const [key] of Object.entries(spec.fields)) {
        const inputId = `input-${key}`;
        fieldInputId[key] = inputId;
        formChildren.push(inputId);
        nodes.push(node(inputId, 'input', 'form', [], { id: key, name: key }, undefined, key));
    }
    for (const button of spec.buttons ?? []) {
        const id = `button-${button}`;
        buttonId[button] = id;
        formChildren.push(id);
        nodes.push(
            node(id, 'button', 'form', [], { id: button, type: 'button' }, capitalize(button)),
        );
    }
    nodes.push(node('form', 'form', 'body', formChildren, { id: 'FaultForm' }));

    const runtimeState: Record<string, RuntimeStateRecord | undefined> = {};
    for (const key of Object.keys(spec.fields)) {
        runtimeState[key] = { stateId: key, value: values[key] ?? '' };
    }

    return {
        raw: {
            identity: { pageEpoch: `epoch-${epoch}`, captureRevision: revision },
            metadata: {
                schemaVersion: 1 as const,
                source: 'fixed-fixture' as const,
                capturedAt: '2026-01-01T00:00:00.000Z',
            },
            completeness,
            scopes: [
                {
                    id: 'main',
                    kind: 'document',
                    rootCaptureId: 'html',
                    status: 'captured',
                    completeness,
                },
            ],
            nodes,
            accessibility: [],
            runtimeState,
            diagnostics: [],
        },
        fieldInputId,
        buttonId,
    };
};

const capitalize = (key: string): string => key.charAt(0).toUpperCase() + key.slice(1);

/**
 * Deterministic observation node ids for a fixture spec. The production DSL
 * targets nodes by observation nodeId; this maps a spec key back to the field
 * key the fault world port uses.
 */
export type AgentEvalRealFixtureTargets = Readonly<{
    /** field key -> observation nodeId */
    field: Readonly<Record<string, string>>;
    /** button key -> observation nodeId */
    button: Readonly<Record<string, string>>;
    /** observation nodeId -> field/button key */
    keyForNode: Readonly<Record<string, string>>;
}>;

export const fixtureNodeTargets = (spec: AgentEvalFixtureSpec): AgentEvalRealFixtureTargets => {
    const { raw, fieldInputId, buttonId } = buildRaw(spec, spec.fields, 1, 1);
    const observation = buildPageObservation(raw);
    const field: Record<string, string> = {};
    for (const [key, inputId] of Object.entries(fieldInputId)) {
        const nodeId = observation.captureIdToNodeId[inputId];
        if (nodeId) {
            field[key] = nodeId;
        }
    }
    const button: Record<string, string> = {};
    for (const [key, id] of Object.entries(buttonId)) {
        const nodeId = observation.captureIdToNodeId[id];
        if (nodeId) {
            button[key] = nodeId;
        }
    }
    const keyForNode: Record<string, string> = {};
    for (const [key, nodeId] of Object.entries({ ...field, ...button })) {
        keyForNode[nodeId] = key;
    }
    return Object.freeze({
        field: Object.freeze(field),
        button: Object.freeze(button),
        keyForNode: Object.freeze(keyForNode),
    }) as unknown as AgentEvalRealFixtureTargets;
};

const buildEntry = (
    spec: AgentEvalFixtureSpec,
    values: Readonly<Record<string, string>>,
    epoch: number,
    revision: number,
): PageSnapshotSessionEntry => {
    const { raw } = buildRaw(spec, values, epoch, revision);
    const observation = buildPageObservation(raw);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const control = buildControlSnapshot({ observation, relations, locators });
    const form = buildFormSnapshot({
        observation,
        relations,
        locators,
        controls: control.controls,
    });
    const table = buildTableSnapshot({
        observation,
        relations,
        locators,
        controls: control.controls,
    });
    return Object.freeze({
        pageUrl: `fixture://${spec.page}`,
        identity: raw.identity,
        refreshReason: 'explicit',
        capture: Object.freeze({ control, form, table }),
        semanticBindingsByProfile: Object.freeze({}),
        semanticSuggestionsByProfile: Object.freeze({}),
    });
};

/**
 * Read the live fixture values through the fault world port (the external
 * verifier's ground truth). `result` and buttons are addressable through the
 * port as the real DOM is.
 */
export const readFixtureValues = async (
    world: AgentFaultWorld,
    spec: AgentEvalFixtureSpec,
): Promise<Record<string, string>> => {
    const values: Record<string, string> = {};
    for (const key of [...Object.keys(spec.fields), 'result']) {
        try {
            values[key] = (await world.read(world.field(key))) ?? '';
        } catch {
            values[key] = '';
        }
    }
    return values;
};

/**
 * WorldViewSource for the production DSL debug session: revisions are the
 * fault world port's own revision/epoch so the event log and the retained
 * effect journal share one revision space.
 */
export const createFixtureWorldViewSource = (
    world: AgentFaultWorld,
    spec: AgentEvalFixtureSpec,
): WorldViewSource => ({
    pin: async (): Promise<WorldView> => {
        const values = await readFixtureValues(world, spec);
        const epoch = world.epoch();
        const revision = world.revision();
        const entry = buildEntry(spec, values, epoch, revision);
        return Object.freeze({
            workspaceName: 'agent-eval-real',
            tabName: 'main',
            pageUrl: `fixture://${spec.page}`,
            revision: Object.freeze({ pageEpoch: `epoch-${epoch}`, captureRevision: revision }),
            entry,
        });
    },
});
