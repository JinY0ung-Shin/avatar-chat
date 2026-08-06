# Noah Almighty 브라우저 브릿지 (PoC)

아바타가 **사용자 본인의 브라우저**를 조작하도록 하는 MV3 확장입니다. 서버 안의 headless
브라우저가 아니라, 이미 로그인된 실제 프로필의 탭을 씁니다.

## 동작 경로

```
아바타 run (서버)  →  SSE  →  Noah 탭  →  확장 메시지  →  확장 SW  →  CDP  →  대상 탭
                  ←──────  POST /api/chat/respond  ←──────────────────┘
```

새 인바운드 포트도 새 인증 체계도 없습니다. 인가는 **이미 로그인된 Noah 탭 세션**이 담당하고,
확장은 `externally_connectable`에 선언된 Noah origin에서 온 메시지만 받습니다.

## 설치

Noah 관리자는 **설정 → 접근/보안 → 브라우저 브릿지**에서 zip을 내려받고 안내 모달을 볼 수 있습니다.
아래는 같은 내용의 수동 절차입니다.

1. `chrome://extensions` → 개발자 모드 켜기 → **압축해제된 확장 프로그램을 로드** → 이 `extension/` 폴더
   (또는 내려받은 zip을 푼 폴더) 선택
2. 표시된 ID가 `fbohmmepjdncddcieglnblnlfiblbhbo` 인지 확인합니다. 매니페스트의 `key` 필드가 ID를
   고정하므로 **어디에 설치해도 같은 ID**가 나오고, 별도 설정이 필요 없습니다.
   (다른 ID를 쓰려면 `VITE_BROWSER_EXTENSION_ID`로 덮어쓸 수 있습니다.)
3. Noah를 여는 주소가 `manifest.json`의 `externally_connectable.matches`에 있어야 합니다.
   기본값은 `https://noah.corp.local/*`와 로컬 개발 포트입니다. **경로 끝 `/*`는 필수** —
   빠뜨리면 루트 외 모든 경로에서 조용히 실패합니다.

> **키에 대해:** 커밋된 `key`는 PoC용으로 생성한 것이고 대응하는 개인키는 보관하지 않았습니다.
> 서명된 `.crx`를 배포하거나 웹스토어에 올릴 계획이라면 **새 키페어를 만들고 `.pem`을 보관**하세요
> (`openssl genrsa 2048`). ID가 바뀌므로 `browserBridge.ts`의 기본값도 함께 갱신해야 합니다.

## 허용 사이트 설정 — 기본은 전면 거부

아무것도 설정하지 않으면 **모든 사이트가 거부됩니다.** 의도된 기본값입니다
(nanobrowser의 "켜짐 + 빈 목록 = 전체 허용"은 따라가지 않았습니다).

출처는 두 곳이고, **관리자 정책이 있으면 그것이 전부**입니다 — 로컬 목록은 무시되므로
관리 대상 단말의 사용자가 허용 범위를 넓힐 수 없습니다.

### 1. 관리자 정책 (운영 환경)

`chrome.storage.managed`로 배포합니다. 스키마는 `policy-schema.json`이고 키는 `allowedOrigins`입니다.

Windows 레지스트리 예:

```
HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\<확장ID>\policy
  allowedOrigins = ["intra.example.com", "*.corp.local"]
```

Linux (`/etc/opt/chrome/policies/managed/noah-bridge.json`):

```json
{
  "3rdparty": {
    "extensions": {
      "<확장ID>": { "allowedOrigins": ["intra.example.com", "*.corp.local"] }
    }
  }
}
```

정책을 바꾸면 확장 재설치 없이 다음 조작부터 반영됩니다.

### 2. 로컬 목록 (개발용)

`chrome://extensions` → 이 확장의 **세부정보 → 확장 프로그램 옵션**에서 한 줄에 하나씩
입력합니다. 관리자 정책이 있으면 이 화면은 읽기 전용으로 잠기고 정책 내용을 보여줍니다.

### 패턴 규칙

- `intra.example.com` — 정확히 그 호스트
- `*.corp.local` — 하위 도메인만. **`corp.local` 자체에는 적용되지 않습니다**
- `*` — 전부 허용. 그 순간 아바타는 사용자가 로그인한 **모든** 사이트에 닿습니다

검사는 세 번 일어납니다: 조작 대상 탭의 현재 주소, `navigate`로 요청된 주소, 그리고
**이동이 실제로 착지한 주소**(리다이렉트로 허용되지 않은 곳에 도달할 수 있고, 로그인된
페이지를 읽는 것 자체가 유출 경로이므로).

## 탭 연결 = 탭 그룹

조작 대상은 **`Noah`라는 이름의 탭 그룹에 든 탭들**입니다. 그룹 안에서 현재 대상 탭 하나가 정해지고,
아바타가 `select_tab`으로 바꿀 수 있습니다.

- 연결: 탭을 그룹에 끌어다 넣기
- 해제: 그룹 밖으로 끌어내기 (즉시 반영)

아바타가 `new_tab`으로 직접 탭을 열 수도 있습니다. 그렇게 열린 탭도 같은 그룹에 들어가므로
사용자 눈에 보이고 똑같이 회수됩니다. 그룹이 아직 없으면 **확장이 확인 팝업을 띄우고, 허용할
때만** 그룹을 만듭니다 — 그룹 생성은 곧 브라우저 조작을 켜는 일이라 조용한 부수효과로 두지
않았습니다. 거부하거나 20초 안에 응답하지 않으면 탭도 그룹도 만들지 않습니다. (팝업은 확장
자체 UI라 페이지·서버가 위조하거나 대신 클릭할 수 없습니다.)
`list_tabs`/`select_tab`/`close_tab`으로 그룹 안에서만 이동할 수 있으며,
**그룹 밖 탭은 조회조차 되지 않습니다.**

권한 범위가 사용자가 이미 아는 UI에 그대로 보이고, 별도 설정 화면 없이 회수됩니다.

## 알아둘 점

- **사용자의 세션이 전부 그대로 쓰입니다.** 새 탭을 열어도 같은 프로필이라 마찬가지입니다.
  범위를 실제로 좁히려면 도메인 allowlist를 쓰거나, 필요한 사이트에만 로그인해 둔
  **전용 Chrome 프로필**에 이 확장을 설치하세요.
- **JS 실행 경로가 없습니다.** `CDP_ALLOWLIST`는 기본 거부이고 `Runtime.*`·`Network.*`·
  `Storage.*`가 없습니다. 요소는 접근성 트리의 `backendNodeId`로만 지목합니다.
  이 allowlist가 자격증명 도달 범위를 묶는 실질적 장치입니다 — 권한 매니페스트가 아니라.
- **Chrome이 "디버깅 중" 배너를 띄웁니다.** 개발 설치에서는 정상이며, 배너의 취소 버튼이
  곧 사용자의 중단 수단입니다. (정책 강제설치로 배포하면 배너가 사라지는데, 그러면 이 중단
  수단도 함께 사라지므로 별도 중단 UI가 필요합니다.)
- 조작 명령(`navigate`/`click`/`type`/`new_tab` 등)은 서버에서 감사 로그로 남습니다. `snapshot`은 너무
  잦아 제외했고, URL은 userinfo와 쿼리스트링을 제거해 기록합니다.

## 미검증 항목

PoC에서 실측할 것들입니다. 아키텍처를 바꾸지는 않습니다.

- 교차 프로세스 `backendNodeId`를 부모 세션에 보냈을 때 명확히 실패하는지, 조용히 엉뚱하게 풀리는지
- 부모 세션 트리에 동일 출처 iframe 내용이 이미 포함되어 중복 집계되는지
- 의미 단위 명령 14개로 실제 사내 업무가 커버되는지 (부족하면 명령을 추가하되, 임의 JS 탈출구는 열지 않습니다)
- OOPIF 안에서 뜬 JS 대화상자가 자식 세션의 `javascriptDialogOpening`으로 실제 잡히는지

## 텍스트 입력 경로

`type`은 문자열 전체를 **한 번에** 넣습니다. 세 갈래로 갈립니다:

- 기본: `Input.insertText` — 표준 입력/에디터에 가장 빠른 경로
- 비ASCII(한글 등) 포함: `Input.imeSetComposition` → `insertText` 커밋 — 실제 IME처럼
  composition 이벤트(compositionstart/update/end)를 발생시켜, compositionend에서만 상태를
  동기화하는 한글 인식 에디터에서도 입력이 반영됩니다
- `keystrokes: true`: 글자별 실제 키 이벤트 재생(한 번의 브릿지 호출 안에서 루프, 서버에서
  300자 제한) — `input` 이벤트를 무시하고 keydown만 듣는 에디터용. 한글 글자는 실제 IME처럼
  `Process`(vk 229) keydown + composition으로 재생됩니다

`press_key`는 특수키·단축키용이고 `repeat`(최대 50)로 같은 키 연타를 한 호출에 담습니다.
텍스트를 press_key로 한 글자씩 넣는 것은 안티패턴입니다 (호출당 스냅샷 왕복 비용).

## JS 대화상자 (alert/confirm/prompt)

대화상자는 렌더러를 얼립니다 — 스냅샷 순회는 물론, 대화상자를 유발한 입력 이벤트의 ack조차
멈춥니다. 그래서 입력 명령은 `javascriptDialogOpening` 이벤트와 race로 실행되고, 대화상자가
열려 있으면 스냅샷 대신 대화상자 정보(`dialog` 필드)를 반환합니다. 아바타는
`handle_dialog`(accept/promptText)로 응답하고, 사용자가 네이티브 대화상자를 직접 눌러도
`javascriptDialogClosed`로 동일하게 정리됩니다.
