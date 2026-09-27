// ESLint flat config (no plugins required).
const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', history: 'readonly',
  localStorage: 'readonly', indexedDB: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  Blob: 'readonly', File: 'readonly', FileReader: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
  AudioContext: 'readonly', OfflineAudioContext: 'readonly', AudioWorkletNode: 'readonly', MediaRecorder: 'readonly',
  MediaMetadata: 'readonly', Audio: 'readonly', Image: 'readonly', OffscreenCanvas: 'readonly', createImageBitmap: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', ResizeObserver: 'readonly', MutationObserver: 'readonly', IntersectionObserver: 'readonly',
  performance: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  queueMicrotask: 'readonly', AbortController: 'readonly', structuredClone: 'readonly', console: 'readonly', Worker: 'readonly', self: 'readonly',
  caches: 'readonly', atob: 'readonly', btoa: 'readonly', Node: 'readonly', globalThis: 'readonly', Intl: 'readonly',
  AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly',
};
const nodeGlobals = { process: 'readonly', Buffer: 'readonly', console: 'readonly', URL: 'readonly', Blob: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', globalThis: 'readonly', setTimeout: 'readonly', performance: 'readonly' };

export default [
  { ignores: ['node_modules/**', 'tests/e2e/artifacts/**', 'data/**', 'dist/**', 'desktop/webapp/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...browserGlobals, ...nodeGlobals } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
      'no-unsafe-finally': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
];
