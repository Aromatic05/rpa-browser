import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    loadFormFixtures,
    type FormFixture,
    type ObservationFixture,
} from '../../../src/snapshot';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/form-v2');

test('versioned Stage 3 form fixtures replay with frozen structural truth', async () => {
    const fixtures = await loadFormFixtures(directory);
    assert.equal(fixtures.length, 4);
    for (const fixture of fixtures) {
        const observation = buildPageObservation(fixture.capture);
        const relations = buildRelationIndex(observation);
        const locators = buildLocatorIndex(observation);
        const controls = buildControlSnapshot({ observation, relations, locators }).controls;
        const snapshot = buildFormSnapshot({ observation, relations, locators, controls });
        const forms = Object.values(snapshot.forms.forms);
        const fields = Object.values(snapshot.forms.fields);
        assert.equal(snapshot.forms.validation.ok, true, fixture.id);
        assert.equal(forms.length >= fixture.truth.minimumFormCount, true, fixture.id);
        assert.equal(fields.length >= fixture.truth.minimumFieldCount, true, fixture.id);
        assert.equal(
            fields.filter((field) => field.controlIds.length > 1).length >= (fixture.truth.minimumCompositeFieldCount ?? 0),
            true,
            fixture.id,
        );
        assert.equal(snapshot.forms.residualFieldIds.length >= (fixture.truth.minimumResidualFieldCount ?? 0), true, fixture.id);
        for (const boundaryKind of fixture.truth.expectedBoundaryKinds ?? []) {
            assert.equal(forms.some((form) => form.boundaryKind === boundaryKind), true, `${fixture.id}:${boundaryKind}`);
        }
        if (fixture.truth.requireDialogHost) {
            assert.equal(forms.some((form) => Boolean(form.location.hostNodeId)), true, fixture.id);
        }
        if (fixture.source.framework === 'datatables') {
            const residual = new Set(snapshot.forms.residualFieldIds);
            const utilityControls = Object.values(controls.controls).filter((control) => {
                if (control.kind !== 'input' && control.kind !== 'native_select') {return false;}
                const nodeId = control.controlNodeId ?? control.rootNodeId;
                const ancestors: string[] = [];
                let cursor: string | undefined = nodeId;
                while (cursor) {
                    ancestors.push(cursor);
                    cursor = observation.parents[cursor];
                }
                return ancestors.some((ancestorId) => {
                    const tokens = (observation.attributes[ancestorId]?.class ?? '').split(/\s+/);
                    return tokens.includes('dt-search') || tokens.includes('dt-length');
                });
            });
            assert.equal(utilityControls.length >= 2, true, fixture.id);
            for (const control of utilityControls) {
                const fieldId = Object.values(snapshot.forms.fields)
                    .find((field) => field.controlIds.includes(control.id))?.id;
                assert.ok(fieldId, `${fixture.id}:${control.id}`);
                assert.equal(residual.has(fieldId), true, `${fixture.id}:${control.id}`);
            }
        }
    }
});


test('existing real Element and Ant list pages retain filter forms while table utilities stay residual', async () => {
    const observationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/observation-v2');
    const cases: Array<{ file: string; minimumFields: number; minimumResidual: number }> = [
        { file: '09-element-plus-browser.v1.json', minimumFields: 1, minimumResidual: 0 },
        { file: '10-ant-design-browser.v1.json', minimumFields: 1, minimumResidual: 1 },
    ];
    for (const item of cases) {
        const fixture = JSON.parse(await fs.readFile(path.join(observationDirectory, item.file), 'utf8')) as ObservationFixture;
        const observation = buildPageObservation(fixture.capture);
        const relations = buildRelationIndex(observation);
        const locators = buildLocatorIndex(observation);
        const controls = buildControlSnapshot({ observation, relations, locators }).controls;
        const snapshot = buildFormSnapshot({ observation, relations, locators, controls });
        const forms = Object.values(snapshot.forms.forms);
        assert.equal(snapshot.forms.validation.ok, true, fixture.id);
        assert.equal(forms.length, 1, fixture.id);
        assert.equal(forms[0].fields.length >= item.minimumFields, true, fixture.id);
        assert.equal(snapshot.forms.residualFieldIds.length >= item.minimumResidual, true, fixture.id);
        assert.equal(forms[0].boundaryKind, 'explicit-form', fixture.id);
        assert.equal(forms[0].evidence.some((evidence) => evidence.source === 'adapter'), true, fixture.id);
    }
});
