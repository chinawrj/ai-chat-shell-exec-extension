# Third-Party Notices

Original AI Chat Shell Exec code is distributed under the MIT License in
`LICENSE`. Bundled third-party components remain under their own licenses; the
project MIT License does not relicense those files.

## draw.io viewer

The Chrome extension bundles an unmodified copy of draw.io's static viewer:

- Component: `extension/vendor/drawio/viewer-static.min.js`
- Upstream project: <https://github.com/jgraph/drawio>
- Upstream tag: `v31.1.5`
- Upstream tag commit: `a318b4c1f82daab96d1b067169704d11ca118275`
- Source: <https://github.com/jgraph/drawio/blob/v31.1.5/src/main/webapp/js/viewer-static.min.js>
- SHA-256: `13f6a01d141f8edd23213242f2472c7a3eb7637c76144bf7917c76858477c251`
- License: Apache License 2.0; see `extension/vendor/drawio/LICENSE`

The upstream tag does not contain a root `NOTICE` file. License notices already
embedded in the minified viewer, including notices for bundled dependencies, are
preserved. More detailed attribution and upstream asset terms travel with the
extension at `extension/vendor/drawio/ATTRIBUTION.md`.

draw.io and diagrams.net names and logos are trademarks of their respective
owners. AI Chat Shell Exec is an independent project and is not affiliated with,
endorsed by, or sponsored by draw.io, diagrams.net, JGraph, or their owners. It
does not use their logos or the hosted diagrams.net application.

The extension uses the viewer as a pinned, self-hosted software component. Its
sandbox Content Security Policy disallows runtime network connections and remote
renderer assets. Diagrams created by users remain the users' content.
