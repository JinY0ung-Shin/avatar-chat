---
name: drawio
description: Use when the user asks for an editable diagram — architecture, flowchart, sequence, network, org chart (다이어그램, 순서도, 구성도, 아키텍처) — or wants to view/edit a .drawio file (e.g. a Confluence attachment). Covers authoring mxfile XML by hand and delivery with mcp__file_output__share_file (the chat renders the diagram interactively).
---

# draw.io diagrams (.drawio)

Core workflow is just **write XML → share**. A `.drawio` file is plain XML you author
directly — no library, no rendering toolchain, nothing to install. Diagram labels follow
the user's language (default Korean).

## 1. Author the mxfile XML

Write the file with `Write`. Always produce an **UNCOMPRESSED** mxfile — readable XML
keeps the file editable on later turns and renders in the chat preview:

```xml
<mxfile host="app">
  <diagram id="page-1" name="Page-1">
    <mxGraphModel dx="800" dy="600" grid="0" page="1" pageWidth="1100" pageHeight="850">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="2" value="Server" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="80" y="80" width="160" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="3" value="DB" style="shape=cylinder3;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="360" y="200" width="120" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="4" value="query" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="2" target="3">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

Rules that keep the file valid and the preview faithful:

- Every cell needs a unique `id`; `0` and `1` are reserved roots — real cells use `parent="1"`
  (or a container/lane cell). Vertices carry `vertex="1"` + an `mxGeometry` with absolute
  `x/y/width/height`; edges carry `edge="1"` + `source`/`target` ids + `<mxGeometry relative="1"/>`.
- There is NO auto-layout: you place every box. Keep coordinates positive, leave ~40px gaps,
  and route long edges with `edgeStyle=orthogonalEdgeStyle`. XML-escape `&`, `<`, `>` in values.
- **Shape styles that render everywhere**: built-ins need no `shape=` (rectangle default,
  `rounded=1`, `ellipse`, `rhombus`, `triangle`, `hexagon`, `parallelogram`, `cloud`,
  `cylinder3`, `swimlane` for containers, `text` for labels) — plus the offline stencil sets
  `shape=mxgraph.basic.*`, `mxgraph.arrows.*`, `mxgraph.flowchart.*`, `mxgraph.bpmn.*`.
- **Avoid big vendor icon sets** (`mxgraph.aws4.*`, `mxgraph.azure.*`, `mxgraph.gcp*`,
  `mxgraph.cisco*`, …) unless the user explicitly wants them: the chat preview shows those as
  labeled placeholder boxes (the icon packs are not bundled offline). Represent cloud services
  as labeled rounded rectangles instead.
- Multi-page diagrams = several `<diagram>` elements in one mxfile; the preview panel gets a
  page switcher.

## 2. Edit an existing .drawio

Read the file and edit the XML directly. If a `<diagram>` element contains base64 instead of
`<mxGraphModel …>`, that page is deflate-compressed — decode it with Bash python3:

```bash
python3 -c 'import sys,base64,zlib,urllib.parse; print(urllib.parse.unquote(zlib.decompress(base64.b64decode(sys.argv[1]), -15).decode()))' '<BASE64>'
```

Re-save the result as uncompressed XML (drop-in replacement for the base64 text). Never
re-compress on save.

## 3. Deliver — the preview is automatic

Call `mcp__file_output__share_file` with the `.drawio` path. That is ALL delivery takes:

- The user gets a download card; clicking it opens a side panel where the chat UI renders the
  diagram **interactively** (zoom/pan, layers, pages) — client-side, no server toolchain.
- Do NOT export the diagram to PNG/SVG for delivery, do not paste mxfile XML into the chat,
  and never paste local paths / `file://` URLs — there is no Bash workaround for delivering files.
- Limits: 3 files per turn, 30 MB per file. Give the download a clear name in the user's
  language when appropriate (e.g. `name: "시스템 구성도.drawio"`).
- The user can keep editing the file in any draw.io app (desktop, VS Code extension,
  Confluence plugin) — mention that when you hand it over.

## 4. Iterate

Apply requested changes to the SAME .drawio file and `share_file` it again on the next turn —
never share a version you haven't re-saved. For a quick self-check before delivering, re-Read
your XML and verify ids are unique and every edge's `source`/`target` exists.
