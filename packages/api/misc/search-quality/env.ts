export type QualityEnvName =
  | 'SEARCH_LANGUAGE_DATA_DIR'
  | 'SEARCH_QUALITY_CORPUS'
  | 'SEARCH_QUALITY_DIR'
  | 'SEARCH_QUALITY_VOCAB'
  | 'SEARCH_QUALITY_MONGO_URI';

/** A required location. A missing one fails the run, so a private check cannot pass unnoticed. */
export function requireQualityEnv(name: QualityEnvName): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}
