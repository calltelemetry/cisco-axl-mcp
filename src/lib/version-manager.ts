export const SUPPORTED_CUCM_VERSIONS = ['11.0', '11.5', '12.0', '12.5', '14.0', '15.0'] as const;
export type SupportedCucmVersion = (typeof SUPPORTED_CUCM_VERSIONS)[number];

export function isSupportedCucmVersion(version: string): version is SupportedCucmVersion {
  return (SUPPORTED_CUCM_VERSIONS as readonly string[]).includes(version);
}

