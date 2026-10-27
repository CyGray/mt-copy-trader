module.exports = {
  extends: ['next/core-web-vitals'],
  overrides: [
    {
      // The root .eslintrc.cjs (root: true, eslint:recommended, node env) applies to web too.
      // For TypeScript sources, turn off the base rules that mis-handle TS (type members,
      // function-type parameter names, DOM type names) and use the TypeScript-aware unused check.
      // The TypeScript compiler (next build / tsc) already covers undefined identifiers.
      files: ['*.ts', '*.tsx'],
      plugins: ['@typescript-eslint'],
      rules: {
        'no-unused-vars': 'off',
        'no-undef': 'off',
        '@typescript-eslint/no-unused-vars': 'error',
      },
    },
  ],
};
