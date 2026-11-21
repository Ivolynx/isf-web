// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'public/js/editor.bundle.js',
      'src/client/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Allow explicit any in some cases (external API responses)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow empty catch blocks (used for graceful degradation)
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
