---
name: confluence
description: 사내 Confluence 문서와 첨부 이미지/draw.io 자산을 검색, 조회, 생성, 업데이트해야 할 때 사용한다. 앱 공용 MCP 도구 `mcp__confluence__*`를 사용하며, host는 서버 환경변수 `CONFLUENCE_URL`, 인증은 소유자 시크릿 `CONFLUENCE_PAT`로 제공된다.
---

# Confluence

이 앱에는 공용 Confluence MCP 도구가 등록되어 있다. Confluence 관련 요청에서는 Bash나 외부 Python 스크립트를 찾지 말고 아래 도구를 직접 사용한다.

## 설정 확인

먼저 필요하면 `mcp__confluence__describe_config`로 상태를 확인한다.

- `CONFLUENCE_URL`은 서버 환경변수다.
- `CONFLUENCE_PAT`은 아바타 소유자의 시크릿 탭에 저장되는 Personal Access Token이다.
- 값 자체는 볼 수 없고 출력하지 않는다.

## 읽기 작업

- space 목록: `mcp__confluence__list_spaces`
- CQL 검색: `mcp__confluence__search`
- 페이지 조회: `mcp__confluence__get_page`
- 페이지 첨부 목록: `mcp__confluence__list_attachments`
- 첨부 다운로드: `mcp__confluence__get_attachment`
- 페이지 본문에서 이미지/draw.io 참조 추출: `mcp__confluence__extract_page_assets`

검색은 raw CQL을 쓰거나 `space`, `title`, `text`, `label` 조건을 조합한다. 페이지 URL이나 ID가 있으면 ID를 확인해 `get_page`로 읽는다.

이미지나 draw.io 그래프가 필요하면 먼저 `extract_page_assets`로 페이지 storage body의 `ac:image`, `ri:attachment`, `ac:structured-macro ac:name="drawio"` 참조를 확인하고, 필요한 첨부를 `get_attachment`로 가져온다. PNG/JPEG/GIF/WebP 첨부는 이미지 블록으로 반환될 수 있다. draw.io가 `.drawio` XML로만 저장된 경우에는 XML 내용을 읽어 구조를 파악할 수 있지만, 별도 렌더러 없이 새 이미지로 변환하지는 않는다.

## 쓰기 작업

페이지 생성/수정은 소유자 또는 신뢰 사용자 권한이 있을 때만 수행한다.

- 새 페이지: `mcp__confluence__create_page`
- 기존 페이지 수정: `mcp__confluence__update_page`

`body_storage`는 Confluence storage XHTML 형식이어야 한다. 간단한 문서는 `<p>...</p>`, 목록은 `<ul><li>...</li></ul>`, 제목은 `<h1>...</h1>`처럼 안전한 storage HTML로 작성한다.
