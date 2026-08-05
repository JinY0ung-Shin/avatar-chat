<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import { copyText } from "../lib/dom";

  export let extensionId: string | null = null;
  export let origins: string[] = [];
  export let downloading = false;

  const dispatch = createEventDispatcher<{ close: void; download: void }>();
</script>

<Modal cardClass="browser-guide-card" ariaLabelledby="browser-guide-title" on:close={() => dispatch("close")}>
  <div class="panel-section-head">
    <div>
      <h3 id="browser-guide-title">브라우저 브릿지 설치</h3>
      <p class="muted">
        설치하면 아바타가 <strong>이 브라우저의 탭</strong>을 직접 조작할 수 있습니다. 서버에 있는 별도
        브라우저가 아니라, 지금 로그인해 둔 세션 그대로예요.
      </p>
    </div>
  </div>

  <ol class="guide-steps">
    <li>
      <div class="guide-step-title">확장 프로그램 내려받기</div>
      <p class="muted">zip을 받아 원하는 폴더에 <strong>압축을 풉니다.</strong> 이 폴더는 지우면 안 됩니다 — Chrome이 계속 참조해요.</p>
      <button type="button" class="btn primary" disabled={downloading} on:click={() => dispatch("download")}>
        <Icon name="file" />
        <span>{downloading ? "준비 중…" : "zip 다운로드"}</span>
      </button>
    </li>

    <li>
      <div class="guide-step-title">Chrome에 불러오기</div>
      <p class="muted">
        주소창에 <code>chrome://extensions</code> 를 열고 → 오른쪽 위 <strong>개발자 모드</strong>를 켠 뒤 →
        <strong>압축해제된 확장 프로그램을 로드</strong>에서 압축을 푼 폴더를 선택합니다.
      </p>
      <p class="muted guide-note">
        Chrome은 웹페이지에서 받은 확장의 바로 설치를 막아두기 때문에 이 과정이 필요합니다.
      </p>
    </li>

    <li>
      <div class="guide-step-title">설치 확인</div>
      {#if extensionId}
        <p class="muted">목록에 나타난 ID가 아래와 같아야 Noah와 연결됩니다.</p>
        <div class="guide-id">
          <code>{extensionId}</code>
          <button type="button" class="btn ghost btn-sm" on:click={() => copyText(extensionId ?? "")}>복사</button>
        </div>
      {:else}
        <p class="muted">서버에서 확장 ID를 읽지 못했습니다. 관리자에게 문의하세요.</p>
      {/if}
      {#if origins.length}
        <p class="muted guide-note">
          이 확장은 다음 주소의 Noah에서만 동작합니다. 지금 쓰는 주소가 목록에 없으면 연결되지 않아요.
        </p>
        <ul class="guide-origins">
          {#each origins as origin (origin)}
            <li><code>{origin}</code></li>
          {/each}
        </ul>
      {/if}
    </li>

    <li>
      <div class="guide-step-title">허용 사이트 정하기</div>
      <p class="muted">
        <strong>아무것도 설정하지 않으면 모든 사이트가 거부됩니다.</strong> 확장의
        <strong>세부정보 → 확장 프로그램 옵션</strong>에서 조작을 허용할 주소를 한 줄에 하나씩 넣으세요.
        회사에서 정책을 배포한 경우에는 그 목록이 우선하며 이 화면은 잠깁니다.
      </p>
    </li>

    <li>
      <div class="guide-step-title">조작할 탭 지정</div>
      <p class="muted">
        아바타가 건드릴 탭을 <strong><code>Noah</code> 라는 이름의 탭 그룹</strong>에 넣습니다. 그룹 밖으로
        빼면 즉시 권한이 회수돼요. 그다음 채팅 입력창의 도구 목록에서 <strong>브라우저 조작</strong>을 켜면 됩니다.
      </p>
    </li>
  </ol>

  <div class="guide-warn">
    <Icon name="shield" />
    <div>
      <strong>알아두세요.</strong>
      아바타는 이 브라우저에 <strong>이미 로그인된 권한 그대로</strong> 사이트를 열고 클릭합니다. 허용 사이트를
      넓히는 것은 그 사이트에서의 내 권한을 아바타에게 주는 일과 같아요. 범위를 확실히 좁히려면 필요한 곳에만
      로그인해 둔 <strong>별도 Chrome 프로필</strong>에 설치하는 방법이 있습니다.
    </div>
  </div>

  <div class="modal-actions">
    <button type="button" class="btn" on:click={() => dispatch("close")}>닫기</button>
  </div>
</Modal>
