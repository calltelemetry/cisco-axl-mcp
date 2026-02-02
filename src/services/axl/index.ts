import type { CucmCredentials } from '../../types/credentials';
import type { ExecuteOperationOptions } from '../../lib/axl-client';
import { getAxlClient } from '../../lib/axl-client';

export class AxlAPIService {
  async executeOperation(
    credentials: CucmCredentials,
    operation: string,
    tags: unknown,
    opts?: ExecuteOperationOptions
  ): Promise<unknown> {
    return getAxlClient(credentials).executeOperation(operation, tags, opts);
  }
}
