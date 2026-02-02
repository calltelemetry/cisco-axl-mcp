import CiscoAxlService from 'cisco-axl';
import type { CucmCredentials } from '../types/credentials';

export interface ExecuteOperationOptions {
  clean?: boolean;
  dataContainerIdentifierTails?: string;
  removeAttributes?: boolean;
}

export interface AxlClient {
  executeOperation(operation: string, tags: unknown, opts?: ExecuteOperationOptions): Promise<unknown>;
  testAuthentication(): Promise<boolean>;
}

const clientCache = new Map<string, AxlClient>();

function cacheKey(creds: CucmCredentials): string {
  return `${creds.host}::${creds.username}::${creds.password}::${creds.version}`;
}

export function getAxlClient(creds: CucmCredentials): AxlClient {
  const key = cacheKey(creds);
  const cached = clientCache.get(key);
  if (cached) return cached;

  const client = new CiscoAxlService(creds.host, creds.username, creds.password, creds.version) as AxlClient;
  clientCache.set(key, client);
  return client;
}

