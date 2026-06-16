---
name: confluence
description: Use when you need to search, read, create, or update internal Confluence pages and their attached images / draw.io assets. Uses the app-wide MCP tools `mcp__confluence__*`; the host comes from the server env var `CONFLUENCE_URL` and auth from the owner secret `CONFLUENCE_PAT`.
---

# Confluence

This app registers app-wide Confluence MCP tools. For any Confluence-related request, do not reach
for Bash or an external Python script — use the tools below directly.

## Check configuration

First, if needed, check status with `mcp__confluence__describe_config`.

- `CONFLUENCE_URL` is a server env var.
- `CONFLUENCE_PAT` is a Personal Access Token stored in the avatar owner's secrets tab.
- You cannot see the values and must not print them.

## Read operations

- List spaces: `mcp__confluence__list_spaces`
- CQL search: `mcp__confluence__search`
- Get a page: `mcp__confluence__get_page`
- List a page's attachments: `mcp__confluence__list_attachments`
- Download an attachment: `mcp__confluence__get_attachment`
- Extract image / draw.io references from a page body: `mcp__confluence__extract_page_assets`

For search, use raw CQL or combine the `space`, `title`, `text`, and `label` conditions. If you have
a page URL or ID, resolve the ID and read it with `get_page`.

When you need an image or draw.io diagram, first use `extract_page_assets` to find the `ac:image`,
`ri:attachment`, and `ac:structured-macro ac:name="drawio"` references in the page storage body, then
fetch the needed attachments with `get_attachment`. PNG/JPEG/GIF/WebP attachments may be returned as
image blocks. When a draw.io diagram is stored only as `.drawio` XML, you can read the XML to
understand its structure, but without a separate renderer you cannot convert it into a new image.

## Write operations

Only create or update pages when you have owner or trusted-user permission.

- New page: `mcp__confluence__create_page`
- Update an existing page: `mcp__confluence__update_page`

`body_storage` must be Confluence storage XHTML. Write simple documents as safe storage HTML —
`<p>...</p>` for paragraphs, `<ul><li>...</li></ul>` for lists, `<h1>...</h1>` for headings.
