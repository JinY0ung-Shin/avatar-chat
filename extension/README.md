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

Noah 사용자는 **설정 → 접근/보안 → 브라우저 브릿지**에서 zip을 내려받고 안내 모달을 볼 수 있습니다.
아래는 같은 내용의 수동 절차입니다.

1. `chrome://extensions` → 개발자 모드 켜기 → **압축해제된 확장 프로그램을 로드** → 이 `extension/` 폴더
   (또는 내려받은 zip을 푼 폴더) 선택
2. 표시된 ID가 `gdaheigeedlnhagpmokpmocahgieiobc` 인지 확인합니다. 매니페스트의 `key` 필드가 ID를
   고정하므로 **어디에 설치해도 같은 ID**가 나오고, 별도 설정이 필요 없습니다.
   (다른 ID를 쓰려면 `VITE_BROWSER_EXTENSION_ID`로 덮어쓸 수 있습니다.)
3. Noah를 여는 주소가 `manifest.json`의 `externally_connectable.matches`에 있어야 합니다.
   기본값은 `https://noah.corp.local/*`와 로컬 개발 포트입니다. **경로 끝 `/*`는 필수** —
   빠뜨리면 루트 외 모든 경로에서 조용히 실패합니다.
4. 설치 확인: browser 도구 그룹이 켜진 대화의 **입력창 아래 힌트 줄**에 확장 버전 배지가
   뜹니다. 서버의 **최소 호환 버전** 이상이면 초록(서버 번들과 달라도 동작 — 툴팁이 업데이트를
   안내), 그 미만이거나 버전을 보고하지 못하는 구버전이면 주황(업데이트 필요), 확장에 연결
   자체가 안 되면 빨강입니다. 최소 호환 버전은 서버 코드의 `BROWSER_EXTENSION_MIN_COMPATIBLE`이
   선언하며, **에이전트가 쓰는 op 계약이 깨질 때만** 올립니다 — 확장 폴더를 손댔다는 이유만으로
   전 사용자를 재설치로 내몰지 않기 위해서입니다.

> **키에 대해:** 커밋된 `key`는 릴리즈 서명 키의 공개키 부분입니다. 대응하는 개인키
> (`~/.noah/browser-bridge-key.pem`)는 저장소 밖 릴리즈 머신에만 있고, 업데이트 페이로드 서명과
> 정책 채널의 `.crx` 서명에 모두 쓰입니다. **이 키를 잃어버리면 같은 ID로 서명된 업데이트를 다시
> 만들 수 없어 기존 설치본이 전부 고아가 됩니다** — 안전한 곳에 백업해 두세요.
>
> (ID는 `key`에서 유도되므로, 키를 바꾸면 ID도 바뀌고 `browserBridge.ts` 기본값·아래 정책 경로·
> 이 문서의 예시 ID를 함께 갱신한 뒤 전 사용자가 1회 재설치해야 합니다. 2026-08-07에 PoC 키에서
> 한 번 교체했습니다.)

## 업데이트 — 폴더 연결 후 원클릭

unpacked 확장의 업데이트는 "폴더 파일 교체 + 리로드"가 전부입니다. 그래서 설정 →
접근/보안에서 압축 푼 폴더를 한 번 연결해 두면(File System Access), 이후에는 **확장 원클릭
업데이트** 버튼이 서버의 현재 파일을 폴더에 다시 쓰고 `reloadExtension` 메시지로 확장을
리로드한 뒤, 실행 중인 버전을 재확인해 배지를 초록으로 되돌립니다.

- 연결 시 폴더 `manifest.json`의 `key`에서 ID를 유도해 **이 확장의 폴더인지 검증**하고,
  업데이트 후에도 실행 버전이 안 바뀌면 "사본 폴더"로 감지해 재연결을 안내합니다.
- 손으로 추가한 `externally_connectable.matches` 항목은 교체 시 **병합되어 유지**됩니다.
- 0.5.0 이전 설치는 `reloadExtension`을 몰라서 **첫 전환 때만** `chrome://extensions`
  리로드(↻) 한 번이 필요합니다. 그 뒤로는 버튼 한 번입니다.
- `reloadExtension`은 권한을 부여하지도 데이터를 읽지도 않는 무해한 op라
  `externally_connectable`에 선언된 Noah 페이지면 보낼 수 있습니다.

## 확장 아이콘 업데이트 버튼 — GitHub에서 직접 (0.7.0)

회사 정책이 Noah **웹 페이지**의 File System Access를 막아 위의 원클릭이 안 되는 환경을
위한 자급 경로입니다. 툴바에 고정한 확장 아이콘을 클릭하면 업데이트 페이지(`updater.html`)가
열리고, 거기서 **버튼 한 번**으로 GitHub 최신 릴리스를 받아 갱신합니다.

동작 순서 (확장은 자기 파일을 스스로 고칠 수 없다는 제약은 그대로라, 폴더 지정이 한 번 필요합니다):

1. **최초 1회 — 폴더 연결**: 압축 풀어 로드한 그 폴더를 지정. 폴더의 manifest `key`가 이
   확장과 같은지 검증해 엉뚱한 폴더에 쓰는 일을 막고, 핸들은 IndexedDB에 저장됩니다.
2. **업데이트 클릭**: `releases/latest/download/noah-bridge-update.json`(+`.sig`)을 받아
   → 이 확장 manifest의 `key`(공개키)로 **RSA 서명 검증** → 통과한 경우에만 파일을 쓰고
   → 확장을 스스로 리로드합니다. 손으로 추가한 `externally_connectable.matches`는
   원클릭과 동일하게 **병합 유지**됩니다.

**사내 DLP가 파일 선택 창을 가로채면 이 버튼은 쓸 수 없습니다.** "허용된 업로드 URL이
아니다" 류의 메시지는 확장이 아니라 보안 에이전트가 낸 것이고, 코드로 우회할 수 없습니다
(우회해서도 안 됩니다). 그 경우 업데이트 페이지가 **파일 선택 창이 없는 수동 경로**를
자동으로 펼쳐 보여줍니다 — zip 내려받기 → 탐색기에서 폴더에 덮어쓰기 → `chrome://extensions`
새로고침(↻). 압축 해제는 브라우저 밖에서 일어나고 ↻는 선택 창을 열지 않으므로 정책과
무관합니다. 근본 해결은 아래 **정책 설치 채널**입니다.

전제와 한계:

- **서명 키 부트스트랩이 선행돼야 합니다.** 커밋된 기존 `key`는 개인키가 없으므로, 새
  키페어 생성 후 `npm run build:extension-update`를 실행하면 어디를 새 key/id로 바꿔야
  하는지 스크립트가 정확히 출력합니다. id가 바뀌므로 **기존 설치는 새 zip으로 1회 재설치**
  해야 하고(이 재설치가 곧 버튼이 생기는 0.7.0 설치입니다), `VITE_BROWSER_EXTENSION_ID`
  기본값과 allowedOrigins 정책의 레지스트리 경로도 새 id를 씁니다.
- 채널이 켜진 뒤에는 **모든 릴리스에 두 에셋이 첨부**돼야 합니다 (`releases/latest`가
  항상 최신 릴리스를 보므로 — `/release` 워크플로가 강제합니다).
- 서명은 공개 레포이기 때문에 더 필요합니다: 개인키는 릴리즈 머신에만 있어, GitHub 계정이
  탈취되거나 사내 TLS 프록시가 응답을 바꿔치기해도 확장이 받아들이지 않습니다.
- `host_permissions`에 `github.com`/`objects.githubusercontent.com`이 추가된 이유가 이
  fetch입니다 (쿠키 없이 릴리스 에셋만 받습니다). 사내망에서 github.com이 막혀 있으면
  이 경로는 쓸 수 없습니다.
- 회사 정책이 File System Access를 **확장 페이지에서도** 막으면(전역 차단) 이 버튼도
  같은 이유로 동작하지 않습니다 — 그 경우 남는 건 수동 zip 교체뿐이고, 업데이트 페이지가
  그 상황을 감지해 안내합니다.

## 정책 설치 채널 — 사용자 조작 0회 자동 갱신 (0.8.0)

파일 선택 창이 정책으로 막힌 환경의 **근본 해결책**입니다. Chrome이 확장을 자동 설치·갱신해
주는 경로는 웹스토어 아니면 **관리자 정책이 지정한 `update_url`** 뿐이고, 손으로 로드한
unpacked 확장은 영원히 자동 갱신 대상이 아닙니다. 이 채널은 Chrome이 직접 내려받아 설치하므로
파일 선택 창이 등장하지 않습니다.

1. **키 생성 (1회, .pem 영구 보관):**
   `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ~/.noah/browser-bridge-key.pem`
   이어서 `npm run build:extension-update`를 실행하면 manifest `key`/클라이언트 기본 id 등
   **어디를 새 값으로 바꿔야 하는지 스크립트가 정확히 출력**합니다. id가 바뀌므로 기존 설치는
   새 zip으로 1회 재설치해야 하고, allowedOrigins 정책의 레지스트리 경로도 새 id를 씁니다.
2. **빌드:** `BROWSER_EXTENSION_KEY_FILE=~/.noah/browser-bridge-key.pem npm run build:extension-update -- --tag v1.3.0 --origin "https://noah.사내주소/*"`
   → `dist/extension/`에 4개 파일(업데이터용 json/sig + 정책용 crx/updates.xml). `/release`
   워크플로가 릴리즈 에셋으로 첨부합니다.
3. **IT에 정책 1회 등록** (빌드 스크립트가 그대로 출력합니다):

   ```json
   {
     "ExtensionSettings": {
       "<확장ID>": {
         "installation_mode": "force_installed",
         "update_url": "https://github.com/JinY0ung-Shin/noah-almighty/releases/latest/download/updates.xml"
       }
     }
   }
   ```

   등록은 "최신"을 가리키는 고정 주소를 넣는 것이라 **이후 릴리즈마다 IT가 다시 할 일은
   없습니다.** 사용자가 확장을 지울 수 있게 하려면 `normal_installed`로 바꿔도 자동 갱신은
   동일하게 동작합니다.

반드시 알아둘 것:

- **`--origin`으로 실제 Noah 주소를 반드시 구우세요.** 정책 설치본은 사용자가 매니페스트를
  손댈 수 없어서, `externally_connectable`에 주소가 없으면 **모든 단말에서 브릿지가 조용히
  실패**합니다(페이지에 `chrome.runtime`이 아예 없어 오류조차 안 납니다).
- **GitHub 릴리즈 에셋은 공개입니다.** 위처럼 사내 호스트명을 구우면 외부에 노출됩니다.
  곤란하면 crx를 Noah 서버에서 서빙하고 `--crx-url`로 그 주소를 지정하세요 (updates.xml의
  `codebase`만 바뀝니다).
- **사내 단말의 Chrome이 `update_url`에 닿아야 합니다.** GitHub이 막혀 있으면 두 파일을
  Noah 서버가 서빙하고 정책의 `update_url`도 사내 주소로 바꾸면 됩니다.
- 정책 설치는 "디버깅 중" 배너를 없앱니다. 배너의 취소 버튼이라는 중단 수단이 사라지므로,
  **탭을 Noah 그룹 밖으로 끌어내는 것이 즉시 회수 수단**임을 사용자에게 안내해야 합니다.
- 같은 키를 쓰는 한 정책 설치와 unpacked 설치는 **같은 id**입니다(동시 설치는 불가 — 정책
  설치가 이깁니다). 개발 장비의 unpacked 설치는 그대로 두어도 됩니다.

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
- 조작 명령(`navigate`/`click`/`type`/`fill_form`/`select_option`/`new_tab` 등)과 의도적 읽기
  (`screenshot`/`read_text`)는 서버에서 감사 로그로 남습니다. `snapshot`/`wait_for`는 매 단계
  사이에 끼어 너무 잦아 제외했고, URL은 userinfo와 쿼리스트링을 제거해 기록합니다.

## 미검증 항목

PoC에서 실측할 것들입니다. 아키텍처를 바꾸지는 않습니다.

- 교차 프로세스 `backendNodeId`를 부모 세션에 보냈을 때 명확히 실패하는지, 조용히 엉뚱하게 풀리는지
- 부모 세션 트리에 동일 출처 iframe 내용이 이미 포함되어 중복 집계되는지
- 의미 단위 명령 18개로 실제 사내 업무가 커버되는지 (부족하면 명령을 추가하되, 임의 JS 탈출구는 열지 않습니다)
- 접힌 네이티브 `<select>`의 옵션이 접근성 트리에 노출되는지 — 안 되면 `select_option`은
  DOM(`DOM.describeNode`) 폴백으로 옵션을 찾습니다. macOS에서는 방향키가 네이티브 팝업을
  열어버릴 수 있는데, 이 경우 값 검증이 실패를 잡아 정직한 오류로 보고됩니다
- Chrome 122+의 File System Access 영구 권한("모든 방문에서 허용")이 사내 관리 프로필에서도
  노출되는지 (막혀 있으면 원클릭 업데이트마다 권한 1클릭이 추가됩니다)
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

## 폼 일괄 입력·드롭다운·본문 읽기·스크린샷 (0.6.0)

- `fill_form` — 여러 필드를 **한 호출**로 순서대로 채우고 스냅샷은 마지막에 한 번만
  반환합니다(필드당 type 호출 대비 왕복·토큰 절감). 필드별 `clear: true`면 사람이 하듯
  전체 선택(Ctrl+A/⌘A) 후 덮어씁니다. 제출은 하지 않습니다 — 제출 버튼 클릭은 별도입니다.
- `select_option` — 보이는 옵션은 실제 클릭으로, 접힌 네이티브 드롭다운은 방향키 이동으로
  선택합니다. JS 실행 없이 구현했고(위 불변식 유지), 방향키 경로는 이동 후 값을 **다시
  읽어 검증**해 조용한 실패를 만들지 않습니다.
- `read_text` — 접근성 트리를 uid 없는 순수 텍스트로 렌더링해 긴 문서를 `offset` 단위로
  나눠 읽습니다. 스냅샷의 uid를 무효화하지 않습니다.
- `screenshot` — `Page.captureScreenshot`(JPEG)으로 뷰포트·요소(`uid`)·전체 페이지
  (`fullPage`, 높이 제한)를 캡처합니다. 픽셀도 텍스트와 같은 유출 경로라서 동일한 origin
  allowlist 검사와 감사 로그를 타며, 대화의 모델이 이미지를 받을 수 있을 때만 서버가
  도구를 엽니다.

## JS 대화상자 (alert/confirm/prompt)

대화상자는 렌더러를 얼립니다 — 스냅샷 순회는 물론, 대화상자를 유발한 입력 이벤트의 ack조차
멈춥니다. 그래서 입력 명령은 `javascriptDialogOpening` 이벤트와 race로 실행되고, 대화상자가
열려 있으면 스냅샷 대신 대화상자 정보(`dialog` 필드)를 반환합니다. 아바타는
`handle_dialog`(accept/promptText)로 응답하고, 사용자가 네이티브 대화상자를 직접 눌러도
`javascriptDialogClosed`로 동일하게 정리됩니다.
