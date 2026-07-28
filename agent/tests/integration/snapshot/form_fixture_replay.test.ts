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
    createCompactFormFixtures,
    measureFormFixture,
    validateFormFixtureTruth,
    type ObservationFixture,
} from '../../../src/snapshot';

const buildSnapshot = (capture: ObservationFixture['capture']) => {
    const observation = buildPageObservation(capture);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const controls = buildControlSnapshot({ observation, relations, locators }).controls;
    return buildFormSnapshot({ observation, relations, locators, controls });
};

test('tracked compact Stage 3 corpus replays with exact structural truth', () => {
    const fixtures = createCompactFormFixtures();
    assert.equal(fixtures.length, 4);
    for (const fixture of fixtures) {
        const snapshot = buildSnapshot(fixture.capture);
        assert.equal(snapshot.forms.validation.ok, true, fixture.id);
        assert.deepEqual(validateFormFixtureTruth(fixture, snapshot), [], fixture.id);
    }
});

test('tracked Element and Ant list captures retain exact form and utility results', async () => {
    const observationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/observation-v2');
    const cases = [
        {
            file: '09-element-plus-browser.v1.json',
            expected: {
                formCount: 1,
                fieldCount: 1,
                compositeFieldCount: 0,
                residualFieldCount: 0,
                actionCount: 4,
                ownedActionCount: 1,
                residualActionCount: 3,
                groupCount: 0,
                requiredFieldCount: 0,
                dialogHostCount: 0,
                boundaryKinds: ['explicit-form'],
            },
        },
        {
            file: '10-ant-design-browser.v1.json',
            expected: {
                formCount: 1,
                fieldCount: 2,
                compositeFieldCount: 0,
                residualFieldCount: 1,
                actionCount: 5,
                ownedActionCount: 1,
                residualActionCount: 4,
                groupCount: 0,
                requiredFieldCount: 0,
                dialogHostCount: 0,
                boundaryKinds: ['explicit-form'],
            },
        },
    ] as const;

    for (const item of cases) {
        const fixture = JSON.parse(await fs.readFile(path.join(observationDirectory, item.file), 'utf8')) as ObservationFixture;
        const snapshot = buildSnapshot(fixture.capture);
        const measurement = measureFormFixture(snapshot);
        assert.equal(snapshot.forms.validation.ok, true, fixture.id);
        for (const [key, expected] of Object.entries(item.expected)) {
            assert.deepEqual(measurement[key as keyof typeof measurement], expected, `${fixture.id}:${key}`);
        }
    }
});
