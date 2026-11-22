/* ESLint config for the kernel (KER-001). Kernel purity: no console in production code. */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { es2020: true, node: true },
  rules: {
    'no-console': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': 'error',
  },
  overrides: [
    {
      // Tests and demos may use console.
      files: ['tests/**/*.ts', 'testing/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
};
