/**
 * The private quality suite: never in public CI (FR-045). It takes its data from
 * the environment, and `src/search/languages/__tests__` covers what public CI can.
 *
 *   npm run test:search-quality
 *
 * The script sets `--experimental-vm-modules`, because a Jest config cannot set
 * Node flags for its own process and the `is` pack imports an ESM-only library.
 *
 * Preset-env excludes the dynamic-import transform, so `import()` stays `import()`
 * as it does in the built package, instead of becoming a `require` of a file URL.
 */
export default {
  rootDir: '../..',
  testMatch: ['<rootDir>/misc/search-quality/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  transform: {
    '\\.[jt]sx?$': [
      'babel-jest',
      {
        presets: [
          [
            '@babel/preset-env',
            { targets: { node: 'current' }, exclude: ['transform-dynamic-import'] },
          ],
          '@babel/preset-typescript',
        ],
      },
    ],
  },
  moduleNameMapper: {
    '^@src/(.*)$': '<rootDir>/src/$1',
    '^~/(.*)$': '<rootDir>/src/$1',
  },
  setupFiles: ['<rootDir>/jest.setup.cjs', '<rootDir>/../../config/jest.setup.logging.cjs'],
  restoreMocks: true,
  testTimeout: 120000,
};
