# Releasing Gatewright

`npm run preflight:ci` checks only invariants safe on every commit. It deliberately does not run the full release gate: a gate that is red by design during normal development stops being read.

1. Update README status and the command table to match `gw --help`.
2. Bump `package.json` to the intended release version.
3. Run `npm run preflight` and resolve every failure.
4. Commit the release changes and push the default branch.
5. Create and push the matching `v<version>` tag.
6. Publish with `npm publish`.
7. In a clean temporary directory, install the published registry version and run `gw --version` and `gw --help`.
8. Verify the npm package page and tarball contents.
9. Record the release task on the Gatewright board, using the registry URL as evidence.
