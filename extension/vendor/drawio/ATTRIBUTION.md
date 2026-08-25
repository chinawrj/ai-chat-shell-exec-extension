# draw.io Viewer Attribution

AI Chat Shell Exec includes an unmodified copy of the draw.io static viewer for
local, read-only diagram rendering.

- Upstream project: <https://github.com/jgraph/drawio>
- Upstream tag: `v31.1.5`
- Upstream tag commit: `a318b4c1f82daab96d1b067169704d11ca118275`
- Source path: `src/main/webapp/js/viewer-static.min.js`
- Source URL: <https://github.com/jgraph/drawio/blob/v31.1.5/src/main/webapp/js/viewer-static.min.js>
- SHA-256: `13f6a01d141f8edd23213242f2472c7a3eb7637c76144bf7917c76858477c251`
- License: Apache License 2.0; the complete license is in `LICENSE` beside this file.

The upstream tag does not contain a root `NOTICE` file. The minified viewer is
copied without modification, and its embedded third-party license notices are
retained. Those embedded notices include, among others, DOMPurify and pako; the
upstream project states that included third-party JavaScript licenses are
compatible with Apache License 2.0.

## Asset terms

The draw.io upstream project separately states that its included icon sets,
stencil libraries, and derivatives may not be used as software assets in,
distributed for use with, or incorporated into Atlassian products or products
distributed through Atlassian's marketplace or plugin ecosystem without explicit
written permission. The upstream restriction says it does not apply to end-user
diagram output. See the licensing section of the upstream README for the
authoritative terms:
<https://github.com/jgraph/drawio/blob/v31.1.5/README.md#licensing>

## Trademarks and independence

draw.io and diagrams.net names and logos are trademarks of their respective
owners. AI Chat Shell Exec is an independent project and is not affiliated with,
endorsed by, or sponsored by draw.io, diagrams.net, JGraph, or their owners. No
draw.io or diagrams.net logo is used to brand this extension.

The viewer is bundled and self-hosted. The extension does not embed or call the
official hosted diagrams.net application, and its sandbox Content Security Policy
blocks runtime network connections and remote renderer assets.
