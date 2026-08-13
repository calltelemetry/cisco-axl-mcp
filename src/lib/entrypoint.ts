import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isDirectExecution(moduleUrl: string, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return fileURLToPath(moduleUrl) === argvPath;
  }
}
