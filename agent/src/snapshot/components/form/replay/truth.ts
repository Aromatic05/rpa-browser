/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Replay truth files are untrusted JSON; runtime schema checks intentionally repeat static constraints. */
import type { FormSnapshot } from '../model/contracts';
import type { FormFixture, FormFixtureExactTruth } from './contracts';

export type FormFixtureMeasurement = FormFixtureExactTruth;

const sorted = (values: readonly string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));

const captureIdForNode = (snapshot: FormSnapshot, nodeId: string): string =>
    snapshot.observation.domIdentity[nodeId]?.captureId ?? nodeId;

export const measureFormFixture = (snapshot: FormSnapshot): FormFixtureMeasurement => {
    const forms = Object.values(snapshot.forms.forms);
    const fields = Object.values(snapshot.forms.fields);
    return {
        formCount: forms.length,
        fieldCount: fields.length,
        compositeFieldCount: fields.filter((field) => field.controlIds.length > 1).length,
        residualFieldCount: snapshot.forms.residualFieldIds.length,
        actionCount: Object.keys(snapshot.forms.actions).length,
        ownedActionCount: forms.reduce((sum, form) => sum + form.actions.length, 0),
        residualActionCount: snapshot.forms.residualActionIds.length,
        groupCount: Object.keys(snapshot.forms.groups).length,
        requiredFieldCount: fields.filter((field) => field.required).length,
        dialogHostCount: forms.filter((form) => Boolean(form.location.hostNodeId)).length,
        boundaryKinds: sorted(forms.map((form) => form.boundaryKind)) as FormFixtureMeasurement['boundaryKinds'],
        structuralRootCaptureIds: sorted(forms.map((form) =>
            captureIdForNode(snapshot, form.location.structuralRootNodeId))),
        residualFieldAnchorCaptureIds: sorted(snapshot.forms.residualFieldIds
            .map((fieldId) => snapshot.forms.fields[fieldId])
            .filter(Boolean)
            .map((field) => captureIdForNode(snapshot, field.anchorNodeId))),
    };
};

export const validateFormFixtureTruth = (
    fixture: FormFixture,
    snapshot: FormSnapshot,
): string[] => {
    const actual = measureFormFixture(snapshot);
    const expected = fixture.truth.expected;
    if (expected) {
        const errors: string[] = [];
        for (const key of [
            'formCount',
            'fieldCount',
            'compositeFieldCount',
            'residualFieldCount',
            'actionCount',
            'ownedActionCount',
            'residualActionCount',
            'groupCount',
            'requiredFieldCount',
            'dialogHostCount',
        ] as const) {
            if (actual[key] !== expected[key]) {
                errors.push(`${key}:expected=${expected[key]}:actual=${actual[key]}`);
            }
        }
        for (const key of [
            'boundaryKinds',
            'structuralRootCaptureIds',
            'residualFieldAnchorCaptureIds',
        ] as const) {
            const actualValue = sorted(actual[key]);
            const expectedValue = sorted(expected[key]);
            if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
                errors.push(`${key}:expected=${JSON.stringify(expectedValue)}:actual=${JSON.stringify(actualValue)}`);
            }
        }
        return errors;
    }

    const errors: string[] = [];
    const forms = Object.values(snapshot.forms.forms);
    const fields = Object.values(snapshot.forms.fields);
    if (fixture.truth.minimumFormCount !== undefined && forms.length < fixture.truth.minimumFormCount) {
        errors.push(`formCount:${forms.length}`);
    }
    if (fixture.truth.minimumFieldCount !== undefined && fields.length < fixture.truth.minimumFieldCount) {
        errors.push(`fieldCount:${fields.length}`);
    }
    if (fields.filter((field) => field.controlIds.length > 1).length < (fixture.truth.minimumCompositeFieldCount ?? 0)) {
        errors.push(`compositeFieldCount:${actual.compositeFieldCount}`);
    }
    if (snapshot.forms.residualFieldIds.length < (fixture.truth.minimumResidualFieldCount ?? 0)) {
        errors.push(`residualFieldCount:${snapshot.forms.residualFieldIds.length}`);
    }
    for (const kind of fixture.truth.expectedBoundaryKinds ?? []) {
        if (!forms.some((form) => form.boundaryKind === kind)) {errors.push(`boundaryKind:${kind}`);}
    }
    if (fixture.truth.requireDialogHost && actual.dialogHostCount === 0) {errors.push('dialogHost:missing');}
    return errors;
};
