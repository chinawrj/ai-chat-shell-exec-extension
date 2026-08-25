# Packaged draw.io viewer

This directory vendors the read-only draw.io `viewer-static.min.js` bundle from the official `jgraph/drawio` repository.

- Upstream: <https://github.com/jgraph/drawio>
- Version/tag: `v31.1.5`
- Tag commit: `a318b4c1f82daab96d1b067169704d11ca118275`
- Source path: `src/main/webapp/js/viewer-static.min.js`
- SHA-256: `13f6a01d141f8edd23213242f2472c7a3eb7637c76144bf7917c76858477c251`
- License: Apache License 2.0; see `LICENSE` in this directory.

The bundle was copied without modification and retains its embedded third-party
license notices. The upstream tag has no root `NOTICE` file. See
`ATTRIBUTION.md` for asset terms, trademark attribution, and the project's
independence statement.

The extension loads this pinned local copy only inside `drawio/viewer.html`,
which is declared as an unprivileged sandbox page. Its Content Security Policy
blocks network connections and remote renderer assets at runtime.
