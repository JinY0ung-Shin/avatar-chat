---
name: pptx
description: Use when the user asks for a PowerPoint / PPT / slide deck / presentation (발표자료, 슬라이드) — creating a .pptx or editing one already in the workspace. Covers authoring with python-pptx, rendering slide previews (soffice → pdftoppm), showing them in the canvas side panel, and delivering the file with mcp__file_output__share_file.
---

# PowerPoint decks (.pptx)

Full workflow: **generate → render → preview → deliver**. The deck's text follows the user's
language (default Korean); slide content should be concise — headlines and short bullets, not prose.

## 0. Preflight

- `mcp__system__describe_system` reports **"Document deck generation (PPTX)"**. If it says
  UNAVAILABLE, stop and tell the user a system administrator must rebuild the server image —
  do NOT try to install LibreOffice/python-pptx yourself.
- Preview target: if the `mcp__canvas__show` tool is available in this conversation, preview in
  the canvas side panel (section 3a). Otherwise fall back to inline images (section 3b).

## 1. Generate / edit with python-pptx

`python3` with the `python-pptx` library is preinstalled system-wide — write a script and run it
with Bash. Do not `pip install` anything.

Rules that keep the preview faithful and the file portable:

- **Fonts: use "NanumGothic"** (installed in this image, so previews render Korean correctly).
  Do not use 맑은 고딕/Malgun Gothic — it does not exist in this container, so previews would
  silently substitute. Set the font on every run: `run.font.name = "NanumGothic"`.
- **16:9**: `prs.slide_width = Inches(13.333)`, `prs.slide_height = Inches(7.5)`.
- Prevent overflow: keep titles ≤ 2 lines and body bullets ≤ 6 per slide; if a text frame looks
  tight, check `len(text)` against the shape's width/height (EMU) before rendering.
- To EDIT an existing deck (from a git repo, SSH download, etc.), open it with
  `Presentation("path.pptx")`, modify shapes/text, and save — the same render/preview/deliver
  steps below apply unchanged.

## 2. Render slide PNGs

Use the script bundled next to this skill file (its directory is shown when this skill loads):

```bash
bash <skill-dir>/scripts/render_deck.sh deck.pptx slides/
```

It runs `soffice --headless` (pptx→pdf, isolated profile so parallel runs don't clash) and then
`pdftoppm -png` (pdf→`slides/slide-N.png`, one per slide). If the script is unreachable, the
equivalent inline pipeline is:

```bash
profile="$(mktemp -d)" && timeout 120 soffice --headless --norestore "-env:UserInstallation=file://$profile" \
  --convert-to pdf --outdir slides deck.pptx && timeout 120 pdftoppm -png -r 120 slides/deck.pdf slides/slide
```

Never use `soffice --convert-to png` directly on a pptx — it renders only the FIRST slide.

## 3a. Preview in the canvas side panel (preferred)

1. Publish each slide PNG quietly: `mcp__file_output__show_file` with `hidden: true`. Each result
   returns a same-origin URL like `/api/conversations/<id>/images/<attachment-id>`. Up to 30
   hidden publishes per turn.
2. Show ONE canvas artifact (`mcp__canvas__show`, contentType `markdown`) that embeds those URLs:

   ```markdown
   # <Deck title>
   ## 1. <Slide 1 title>
   ![Slide 1](/api/conversations/<id>/images/<attachment-id-1>)
   ## 2. <Slide 2 title>
   ![Slide 2](/api/conversations/<id>/images/<attachment-id-2>)
   ```

   Embed the returned URLs EXACTLY — only same-origin URLs render (external images are blocked).
3. When you revise slides, re-render, publish the new PNGs (hidden), and call `mcp__canvas__show`
   again with the SAME `canvasId` so the deck updates in place instead of stacking a new tab.

## 3b. Preview inline (canvas unavailable)

Show the most important slides directly with `mcp__file_output__show_file` (no `hidden`), at most
6 images per turn — for longer decks show title + key slides and offer the rest on request.

## 4. Deliver the file

Finish with `mcp__file_output__share_file` on the .pptx — the user gets a download card in the
chat. Do not paste local paths or `file://` URLs; there is no Bash workaround for delivering
files. Limits: 3 files per turn, 30 MB per file. Give the download a clear Korean name when the
conversation is in Korean (e.g. `name: "주간보고.pptx"`).

## 5. Verify before you deliver

- If image input is supported (check the "Image input (vision)" line in `describe_system`),
  Read one or two rendered slide PNGs to eyeball layout. On text-only deployments that Read is
  BLOCKED — do not retry it; rely on the overflow checks from section 1 instead (the USER still
  sees the real slides through the canvas/inline preview).
- Re-render after every edit; never share a .pptx whose current version you haven't rendered.
