// ESLint flat config: Node for the main process / tests / build, browser for the renderer and the web shim.
import js from '@eslint/js';
import globals from 'globals';
export default [
  { ignores: ['docs/**', 'dist/**', 'out/**', 'node_modules/**', 'src/renderer/i18n.js', 'src/renderer/fonts/**'] },
  js.configs.recommended,
  { files: ['src/main/**/*.js', 'test/**/*.js', 'web/build.mjs', 'scripts/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node, ...globals.es2021 } } },
  { files: ['src/renderer/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser } } },
  { files: ['web/src/*.js', 'web/static/sw.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.browser, ...globals.serviceworker, __VERSION__: 'readonly', __PATCH__: 'readonly', require: 'readonly', module: 'readonly' } } },
  { files: ['web/build.mjs', 'web/src/process-shim.js', 'test/*.mjs'], languageOptions: { sourceType: 'module', globals: { ...globals.node } } },
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }], 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-control-regex': 'off', 'no-misleading-character-class': 'off', 'no-prototype-builtins': 'off' } },
];
