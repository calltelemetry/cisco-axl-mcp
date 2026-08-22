import { PACKAGE_VERSION } from '../lib/package-version';

export type MetadataFlag = 'help' | 'version';

export function metadataFlag(argv: readonly string[]): MetadataFlag | undefined {
  if (argv.length !== 1) return undefined;
  if (argv[0] === '--help' || argv[0] === '-h') return 'help';
  if (argv[0] === '--version' || argv[0] === '-V') return 'version';
  return undefined;
}

/** Writes direct-executable metadata without importing a runtime dependency. */
export function writeMetadata(
  argv: readonly string[],
  help: string,
  stdout: Pick<NodeJS.WriteStream, 'write'> = process.stdout
): boolean {
  const flag = metadataFlag(argv);
  if (flag === 'help') {
    stdout.write(help);
    return true;
  }
  if (flag === 'version') {
    stdout.write(`${PACKAGE_VERSION}\n`);
    return true;
  }
  return false;
}
