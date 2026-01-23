import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import type { ActionHandler } from '../execute';
import type { ElementSetFilesCommand, ElementSetFilesFromPathCommand } from '../commands';
import { resolveTarget } from '../../runtime/target_resolver';

const writeTempFile = async (name: string, base64: string) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-upload-'));
  const filePath = path.join(tmpDir, name);
  const buffer = Buffer.from(base64, 'base64');
  await fs.writeFile(filePath, buffer);
  return { filePath, tmpDir };
};

export const fileUploadHandlers: Record<string, ActionHandler> = {
  'element.setFilesFromPath': async (ctx, command) => {
    const args = (command as ElementSetFilesFromPathCommand).args;
    const { locator } = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.target,
      pageRegistry: ctx.pageRegistry
    });
    await locator.setInputFiles(args.paths);
    return { ok: true, tabToken: ctx.tabToken, data: { count: args.paths.length } };
  },
  'element.setFiles': async (ctx, command) => {
    const args = (command as ElementSetFilesCommand).args;
    const { locator } = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.target,
      pageRegistry: ctx.pageRegistry
    });
    const tempDirs: string[] = [];
    const paths = [];
    for (const file of args.files) {
      const { filePath, tmpDir } = await writeTempFile(file.name, file.base64);
      tempDirs.push(tmpDir);
      paths.push(filePath);
    }
    try {
      await locator.setInputFiles(paths);
    } finally {
      await Promise.all(
        tempDirs.map(async (dir) => {
          try {
            await fs.rm(dir, { recursive: true, force: true });
          } catch {
            // ignore cleanup errors
          }
        })
      );
    }
    return { ok: true, tabToken: ctx.tabToken, data: { count: args.files.length } };
  }
};
