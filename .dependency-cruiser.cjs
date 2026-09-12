/**
 * The module graph, as a failing rule.
 *
 * Direction: contract <- identity <- providers <- api|worker, and nothing depends on apps/.
 * This is the analogue of the Android app's Konsist `ModuleBoundaryTest`: a boundary that is only
 * described in a README is a boundary that is already broken somewhere.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A cycle means neither module can be reasoned about, or tested, alone.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'nothing-depends-on-apps',
      severity: 'error',
      comment:
        'apps/ are compositions. A package importing one inverts the graph and makes the ' +
        'package untestable without booting a server.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'contract-has-no-deps',
      severity: 'error',
      comment:
        'packages/contract must stay dependency-free apart from zod: it is the one thing every ' +
        'consumer and the published schema are generated from.',
      from: { path: '^packages/contract/src' },
      to: { path: '^(packages/(?!contract)|apps/)' },
    },
    {
      name: 'identity-is-pure',
      severity: 'error',
      comment:
        'packages/identity is pure: no I/O, no clock, no env. It is ported from Kotlin and ' +
        'asserted against shared golden vectors, which only works if it has no ambient state.',
      from: { path: '^packages/identity/src' },
      to: { path: '^(fs|node:fs|http|node:http|pg|dotenv)$', dependencyTypes: ['core', 'npm'] },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', 'emit-schema', '(^|/)index\\.ts$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '(^|/)(dist|coverage|test)/' },
  },
};
