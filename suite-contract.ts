/**
 * The ONE source of truth for this repo's test suite wiring.
 *
 * `scripts.test` in package.json, `test-waves.ts` and the packaging-manifest
 * tests all derive from this list, so adding/removing a suite is a one-line
 * change instead of a three-way copy-paste that silently drifts.
 */

export const TEST_SUITE_COMMANDS: readonly string[] = [
	"node ./test.ts",
	"node ./test-regressions.ts",
	"node ./test-waves.ts",
	"node ./test-packaging-manifest.ts",
	"node ./test-packaging-docs.ts",
	"node ./test-primitives.ts",
];
