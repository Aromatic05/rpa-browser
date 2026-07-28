import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FormFixture } from './contracts';

export const loadFormFixtures = async (directory: string): Promise<FormFixture[]> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const fixtures: FormFixture[] = [];
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
        const fixturePath = path.join(directory, entry.name);
        const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8')) as FormFixture;
        if (fixture.fixtureVersion !== 1 || !fixture.id || !fixture.capture) {
            throw new Error(`invalid form fixture: ${fixturePath}`);
        }
        fixtures.push(fixture);
    }
    return fixtures;
};
