import fs from 'node:fs';
import path from 'node:path';

const base = process.env.RPA_TEST_PROCESS_ROOT?.trim();
if (base) {
    const root = path.join(base, String(process.pid));
    fs.mkdirSync(root, {recursive: true});
    process.env.RPA_WORKFLOW_ROOT = path.join(root, 'workflows');
    process.env.RPA_USER_DATA_DIR = path.join(root, 'user-data');
}
