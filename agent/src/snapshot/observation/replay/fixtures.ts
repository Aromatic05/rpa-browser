/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Observation fixtures are untrusted JSON; runtime schema checks intentionally repeat static constraints. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ObservationFixture } from './contracts';

export const loadObservationFixtures = async (
    fixtureDirectory: string,
): Promise<ObservationFixture[]> => {
    const entries = await fs.readdir(fixtureDirectory, { withFileTypes: true });
    const fixturePaths = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => path.join(fixtureDirectory, entry.name))
        .sort();
    const fixtures: ObservationFixture[] = [];
    for (const fixturePath of fixturePaths) {
        const parsed = JSON.parse(await fs.readFile(fixturePath, 'utf8')) as ObservationFixture;
        validateObservationFixture(parsed, fixturePath);
        fixtures.push(parsed);
    }
    return fixtures;
};

export const validateObservationFixture = (
    fixture: ObservationFixture,
    source = fixture.id,
): void => {
    if (fixture.fixtureVersion !== 1) {
        throw new Error(`unsupported fixture version in ${source}`);
    }
    if (!fixture.id || !fixture.category || !fixture.source?.frameworkVersion) {
        throw new Error(`incomplete fixture metadata in ${source}`);
    }
    if (fixture.capture.metadata.schemaVersion !== 1) {
        throw new Error(`unsupported raw capture schema in ${source}`);
    }
};
