import test from 'node:test';
import assert from 'node:assert/strict';
import {buildControlSlots} from '../../../src/automation/snapshot/components/table/assembly/control_slots';
import type {ControlIndex} from '../../../src/automation/snapshot/components/control/model/contracts';
import type {PageObservation} from '../../../src/automation/snapshot/observation/model/contracts';
import type {TableCell, TableRow} from '../../../src/automation/snapshot/components/table/model/contracts';

const control = (id: string, nodeId: string) => ({
    id,
    ref: id,
    kind: 'link' as const,
    status: 'complete' as const,
    scopeId: 'document',
    rootNodeId: nodeId,
    optionNodeIds: [],
    memberNodeIds: [],
    capabilities: ['click' as const],
    state: {disabled: false, readonly: false, focused: false, selectedValues: [], selectedLabels: []},
    options: [],
    inheritedCompleteness: 'complete' as const,
    locatorIds: [],
    evidence: [],
    diagnostics: [],
});

test('table control slots separate homogeneous row actions by accessible label', () => {
    const rows = [
        {id: 'r1', nodeId: 'row1', cellIds: ['c1'], key: 'SO-001', diagnostics: []},
        {id: 'r2', nodeId: 'row2', cellIds: ['c2'], key: 'SO-002', diagnostics: []},
        {id: 'r3', nodeId: 'row3', cellIds: ['c3'], key: 'SO-003', diagnostics: []},
    ] as unknown as TableRow[];
    const cells = {
        c1: {id: 'c1', columnId: 'actions', nodeId: 'cell1', controlIds: ['edit1', 'ship1']},
        c2: {id: 'c2', columnId: 'actions', nodeId: 'cell2', controlIds: ['edit2', 'ship2']},
        c3: {id: 'c3', columnId: 'actions', nodeId: 'cell3', controlIds: ['edit3', 'shipped3']},
    } as unknown as Record<string, TableCell>;
    const controls = {
        controls: {
            edit1: control('edit1', 'edit-node-1'),
            ship1: control('ship1', 'ship-node-1'),
            edit2: control('edit2', 'edit-node-2'),
            ship2: control('ship2', 'ship-node-2'),
            edit3: control('edit3', 'edit-node-3'),
            shipped3: control('shipped3', 'shipped-node-3'),
        },
        byNodeId: {},
        byRef: {},
        diagnostics: [],
        validation: {ok: true, diagnostics: []},
    } as unknown as ControlIndex;
    const labels = {
        'edit-node-1': '编辑',
        'edit-node-2': '编辑',
        'edit-node-3': '编辑',
        'ship-node-1': '确认发货',
        'ship-node-2': '确认发货',
        'shipped-node-3': '已发货',
    };
    const observation = {
        accessibility: Object.fromEntries(Object.entries(labels).map(([nodeId, name]) => [nodeId, {name}])),
        text: {},
        attributes: Object.fromEntries(Object.keys(labels).map((nodeId) => [nodeId, {}])),
    } as unknown as PageObservation;

    const result = buildControlSlots('orders', rows, cells, controls, observation);

    assert.deepEqual(result.slots.map((slot) => ({
        label: slot.label,
        position: slot.structuralPosition,
        occurrences: slot.occurrenceCount,
    })), [
        {label: '编辑', position: 0, occurrences: 3},
        {label: '确认发货', position: 1, occurrences: 2},
    ]);
    assert.equal(result.slots.some((slot) => slot.label === '已发货'), false);
    assert.deepEqual(result.rowExceptions.map((exception) => exception.controlIds), [['shipped3']]);
});

test('table control slots prefer aria labels when icon controls share the same visible text', () => {
    const rows = [
        {id: 'r1', nodeId: 'row1', cellIds: ['c1'], key: 'SO-001', diagnostics: []},
        {id: 'r2', nodeId: 'row2', cellIds: ['c2'], key: 'SO-002', diagnostics: []},
        {id: 'r3', nodeId: 'row3', cellIds: ['c3'], key: 'SO-003', diagnostics: []},
        {id: 'r4', nodeId: 'row4', cellIds: ['c4'], key: 'SO-004', diagnostics: []},
    ] as unknown as TableRow[];
    const cells = Object.fromEntries(rows.map((row, index) => [row.cellIds[0], {
        id: row.cellIds[0],
        columnId: 'actions',
        nodeId: `cell${index + 1}`,
        controlIds: [`action${index + 1}`],
    }])) as unknown as Record<string, TableCell>;
    const controls = {
        controls: Object.fromEntries(rows.map((_, index) => [
            `action${index + 1}`,
            control(`action${index + 1}`, `action-node-${index + 1}`),
        ])),
        byNodeId: {},
        byRef: {},
        diagnostics: [],
        validation: {ok: true, diagnostics: []},
    } as unknown as ControlIndex;
    const observation = {
        accessibility: {},
        text: Object.fromEntries(rows.map((_, index) => [`action-node-${index + 1}`, '…'])),
        attributes: {
            'action-node-1': {'aria-label': '确认发货'},
            'action-node-2': {'aria-label': '确认发货'},
            'action-node-3': {'aria-label': '取消发货'},
            'action-node-4': {'aria-label': '取消发货'},
        },
    } as unknown as PageObservation;

    const result = buildControlSlots('orders', rows, cells, controls, observation);

    assert.deepEqual(result.slots.map((slot) => ({label: slot.label, occurrences: slot.occurrenceCount})), [
        {label: '确认发货', occurrences: 2},
        {label: '取消发货', occurrences: 2},
    ]);
});
