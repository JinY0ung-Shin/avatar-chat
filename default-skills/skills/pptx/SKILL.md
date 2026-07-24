---
name: pptx
description: Use when the user asks for a PowerPoint / PPT / slide deck / presentation (발표자료, 슬라이드) — creating a .pptx or editing one already in the workspace. Covers authoring with python-pptx and delivery with mcp__file_output__share_file (slide previews render automatically), plus optional canvas-based iterative review.
---

# PowerPoint decks (.pptx)

Core workflow is just **generate → share**. The deck's text follows the user's language (default
Korean); slide content should be concise — headlines and short bullets, not prose.

## 0. Preflight

- `mcp__system__describe_system` reports **"Document deck generation (PPTX)"**. If it says
  UNAVAILABLE, stop and tell the user a system administrator must rebuild the server image —
  do NOT try to install LibreOffice/python-pptx yourself.

## 1. Generate / edit with python-pptx

`python3` with the `python-pptx` library is preinstalled system-wide — write a script and run it
with Bash. Do not `pip install` anything.

Rules that keep the preview faithful and the file portable:

- **Fonts: use "NanumGothic"** (installed in this image, so previews render Korean correctly).
  Do not use 맑은 고딕/Malgun Gothic — it does not exist in this container, so rendering would
  silently substitute. Set the font on every run: `run.font.name = "NanumGothic"`.
- **16:9**: `prs.slide_width = Inches(13.333)`, `prs.slide_height = Inches(7.5)`.
- Prevent overflow: keep titles ≤ 2 lines and body bullets ≤ 6 per slide; if a text frame looks
  tight, check `len(text)` against the shape's width/height (EMU) before delivering.
- To EDIT an existing deck (from a git repo, SSH download, etc.), open it with
  `Presentation("path.pptx")`, modify shapes/text, and save — everything else is identical.

## 2. Deliver — previews are automatic

Call `mcp__file_output__share_file` with the .pptx path. That is ALL delivery takes:

- The user gets a download card in the chat; clicking it opens a side panel with **slide
  previews the SERVER rendered automatically** and a download button.
- Do NOT rasterize or publish slide images yourself for delivery, and do not paste local
  paths / `file://` URLs — there is no Bash workaround for delivering files.
- Limits: 3 files per turn, 30 MB per file. Give the download a clear Korean name when the
  conversation is in Korean (e.g. `name: "주간보고.pptx"`).

## 3. Optional: render slides yourself (mid-work only)

Two situations justify manual rendering with the bundled script
(`bash <skill-dir>/scripts/render_deck.sh deck.pptx slides/` — soffice pptx→pdf with an
isolated profile, then pdftoppm pdf→`slides/slide-N.png`; never `soffice --convert-to png`
directly, it renders only the FIRST slide):

- **Self-check before delivering**: if image input is supported (see the "Image input
  (vision)" line in `describe_system`), Read one or two rendered PNGs to eyeball layout. On
  text-only deployments that Read is blocked — rely on the overflow rules from section 1.
- **Interactive design review**: to iterate on the deck WITH the user before delivery,
  publish each slide PNG via `mcp__file_output__show_file` with `hidden: true` (each result
  returns a same-origin URL) and embed those URLs in ONE `mcp__canvas__show` markdown
  artifact (`![Slide 1](<url>)` …). Re-render + re-show with the SAME `canvasId` as you
  revise. Without the canvas tool, show key slides inline with `show_file` (≤6 per turn).

## 4. Finish

Re-generate after every accepted change and `share_file` the final .pptx — never share a
version you haven't rebuilt. Briefly tell the user the file is ready; the preview panel and
download button are already on the card.
