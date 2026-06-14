<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Modal from "./Modal.svelte";
  import RevealableInput from "./RevealableInput.svelte";
  import { api } from "../lib/api";
  import { copyText } from "../lib/dom";
  import { notify, replaceState } from "../lib/state";
  import type { User } from "../lib/types";

  export let user: User;
  export let confluenceConfigured = false;
  export let githubHost = "github.com";

  const dispatch = createEventDispatcher<{ close: void }>();

  const FEATURES = [
    { title: "아바타 찾기", desc: "탐색에서 공개 아바타를 검색하고 바로 대화를 시작합니다." },
    { title: "내 아바타 키우기", desc: "프로필, 페르소나, 자기소개, 역량 태그를 설정해 업무 맥락을 드러냅니다." },
    { title: "지식 저장소 연결", desc: "반복 업무와 프로젝트 규칙을 저장소와 스킬로 쌓아 다음 대화에 재사용합니다." },
    { title: "동료에게 요청", desc: "동료가 공개한 지식과 스킬을 바탕으로 조사, 검토, 정리를 요청합니다." },
    { title: "루틴 자동 실행", desc: "매일·매주 반복되는 확인 작업을 예약하고 결과를 대화에 쌓습니다." },
    { title: "도구 확장", desc: "Git 토큰, 플러그인, SSH, Confluence 연결로 작업 범위를 넓힙니다." },
  ];
  const EXAMPLES = [
    "내가 자주 맡기는 배포 점검 절차를 스킬로 정리하고 다음부터 그대로 수행해줘.",
    "민수님의 아바타에게 이번 장애 원인과 재발 방지 체크리스트를 물어봐.",
    "내 지식 저장소에 이 프로젝트 운영 절차를 스킬로 정리해줘.",
    "접근 가능한 서버에 SSH로 접속해서 서비스 로그와 디스크 사용량을 점검해줘.",
  ];

  let gitToken = "";
  let confluencePat = "";
  let error = "";
  let busy = false;
  let sshBusy = false;

  $: tokensHost = (githubHost || "github.com").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  $: sshPublicKey = (user.sshPublicKey || "").trim();
  $: sshConfigured = Boolean(sshPublicKey) || user.secretNames?.includes("SSH_PRIVATE_KEY");
  $: saveLabel = busy ? (gitToken.trim() || confluencePat.trim() ? "저장 중…" : "시작 중…") : gitToken.trim() || confluencePat.trim() ? "저장하고 시작" : "시작하기";

  function done() {
    dispatch("close");
  }

  async function generateSsh() {
    sshBusy = true;
    error = "";
    try {
      const { user: next } = await api<{ user: User }>("/api/me/ssh-key", { method: "POST" });
      replaceState({ user: next });
      user = next;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      sshBusy = false;
    }
  }

  async function submit() {
    busy = true;
    error = "";
    try {
      const token = gitToken.trim();
      const pat = confluencePat.trim();
      if (token) {
        const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
        replaceState({ user: next });
      }
      if (pat) {
        const { user: next } = await api<{ user: User }>("/api/me/secrets/CONFLUENCE_PAT", { method: "PUT", body: JSON.stringify({ value: pat }) });
        replaceState({ user: next });
      }
      if (token || pat) notify("설정을 저장했습니다.", "ok");
      done();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal cardClass="onboard-card" ariaLabelledby="onboarding-title" on:close={done}>
  <img class="login-mark" src="/icon-192.png" alt="" aria-hidden="true" width="48" height="48" />
  <h2 id="onboarding-title">아바타 사용 준비하기</h2>
  <p class="muted">업무 방식과 반복 절차를 아바타에 쌓고, 동료 아바타에게도 질문·요청할 수 있습니다.</p>

  <div class="onboard-guide">
    <section class="onboard-section">
      <h3>이 앱에서 할 수 있는 일</h3>
      <div class="onboard-feature-list">
        {#each FEATURES as feature}
          <div class="onboard-feature">
            <strong>{feature.title}</strong>
            <p>{feature.desc}</p>
          </div>
        {/each}
      </div>
    </section>
    <section class="onboard-section">
      <h3>처음 대화할 때 이렇게 시켜볼 수 있어요</h3>
      <ul class="onboard-examples">
        {#each EXAMPLES as example}
          <li>{example}</li>
        {/each}
      </ul>
    </section>
    <p class="onboard-note">
      권한은 대화 상대에 따라 달라집니다. 내 아바타와 신뢰한 사용자는 작업 도구를 쓸 수 있고, 일반 사용자가 다른 아바타와 대화할 때는 읽기 전용으로 실행됩니다.
    </p>
  </div>

  <div class="onboard-connect">
    <h3>선택 설정</h3>
    <p class="muted">지금 건너뛰어도 됩니다. 필요한 연결은 내 아바타 설정에서 언제든 다시 추가할 수 있습니다.</p>
  </div>

  <form class="form-stack" on:submit|preventDefault={submit} aria-busy={busy ? "true" : "false"}>
    <div class="onboard-setup-list">
      <details class="onboard-setup-item">
        <summary><strong>Git 토큰</strong><span>비공개 저장소 읽기와 지식 저장소 커밋·푸시에 사용합니다.</span></summary>
        <div class="onboard-setup-body">
          <label class="field">
            <span>
              사내 Git 토큰 (GIT_TOKEN, 선택)
              <a class="linkish" href={`https://${tokensHost}/settings/tokens`} target="_blank" rel="noopener noreferrer">토큰 만들러 가기 ↗</a>
            </span>
            <RevealableInput bind:value={gitToken} name="token" placeholder="사내 GitHub PAT (GIT_TOKEN)" ariaLabel="사내 Git 토큰 GIT_TOKEN" revealLabel="토큰" />
          </label>
        </div>
      </details>

      <details class="onboard-setup-item">
        <summary><strong>SSH 키</strong><span>서버 로그 확인, 파일 점검, 원격 명령 같은 작업에 사용합니다.</span></summary>
        <div class="onboard-setup-body">
          <p class="muted">개인키는 암호화되어 저장되고 도구 실행 시에만 주입됩니다. 공개키만 접속 대상 서버에 등록하면 됩니다.</p>
          <div class="git-token-status muted">
            {#if sshPublicKey}
              <span class="token-set">● SSH_PRIVATE_KEY 생성됨</span>
            {:else if sshConfigured}
              <span class="token-set">● SSH_PRIVATE_KEY 설정됨</span>
            {:else}
              <span>SSH_PRIVATE_KEY 미설정</span>
            {/if}
          </div>
          <div class="git-token-actions">
            <button class="primary" type="button" disabled={sshConfigured || sshBusy} on:click={generateSsh}>
              {sshConfigured ? (sshPublicKey ? "SSH 키 생성됨" : "SSH 키 설정됨") : sshBusy ? "생성 중…" : "SSH 키 생성"}
            </button>
          </div>
          {#if sshPublicKey}
            <div class="ssh-public-key-box">
              <label class="field">
                <span>공개키 (서버 authorized_keys에 등록)</span>
                <div class="password-field">
                  <input readonly value={sshPublicKey} aria-label="SSH 공개키" />
                  <button class="password-toggle" type="button" aria-label="공개키 복사" title="공개키 복사" on:click={(event) => copyText(sshPublicKey, event.currentTarget)}>복사</button>
                </div>
              </label>
            </div>
          {/if}
        </div>
      </details>

      {#if confluenceConfigured}
        <details class="onboard-setup-item">
          <summary><strong>Confluence 연결</strong><span>문서를 검색·조회하고 페이지 작성·수정 작업을 맡길 수 있습니다.</span></summary>
          <div class="onboard-setup-body">
            <label class="field">
              <span>Confluence PAT (CONFLUENCE_PAT, 선택)</span>
              <RevealableInput bind:value={confluencePat} name="confluence" placeholder="Confluence PAT (CONFLUENCE_PAT)" ariaLabel="Confluence Personal Access Token CONFLUENCE_PAT" revealLabel="토큰" />
            </label>
          </div>
        </details>
      {/if}
    </div>

    {#if error}<div class="error" role="alert">{error}</div>{/if}

    <div class="onboard-actions">
      <button class="linkish" type="button" on:click={done}>건너뛰기</button>
      <button class="primary" type="submit" disabled={busy}>{saveLabel}</button>
    </div>
  </form>
</Modal>
