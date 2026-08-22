/** A dependency-free policy error safe for bootstrap-time configuration validation. */
export class AxlPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AxlPolicyError';
  }
}
