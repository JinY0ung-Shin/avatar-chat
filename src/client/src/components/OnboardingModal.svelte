<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import RevealableInput from "./RevealableInput.svelte";
  import { api } from "../lib/api";
  import { copyText } from "../lib/dom";
  import { goView } from "../lib/nav";
  import { notify, replaceState } from "../lib/state";
  import type { SettingsTab, User } from "../lib/types";

  export let user: User;
  export let confluenceConfigured = false;
  export let githubHost = "github.com";

  const dispatch = createEventDispatcher<{ close: void }>();

  const STARTER_PROMPTS = [
    "내가 자주 맡기는 배포 점검 절차를 스킬로 정리하고 다음부터 그대로 수행해줘.",
    "민수님의 아바타에게 이번 장애 원인과 재발 방지 체크리스트를 물어봐.",
  ];

  let gitToken = "";
  let confluencePat = "";
  let error = "";
  let busy = false;
  let sshBusy = false;

  $: tokensHost = (githubHost || "github.com").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  $: sshPublicKey = (user.sshPublicKey || "").trim();
  $: sshConfigured = Boolean(sshPublicKey) || user.secretNames?.includes("SSH_PRIVATE_KEY");
  $: profileReady = Boolean(user.alias || user.bio || user.intro || user.hashtags?.length);
  $: knowledgeReady = Boolean(user.knowledgeRepo);
  $: accessReady = Boolean(user.gitTokenSet || sshConfigured || user.secretNames?.includes("CONFLUENCE_PAT"));
  $: saveLabel = sshBusy
    ? "SSH 생성 중…"
    : busy
      ? (gitToken.trim() || confluencePat.trim() ? "저장 중…" : "시작 중…")
      : gitToken.trim() || confluencePat.trim()
        ? "저장하고 시작"
        : "시작하기";

  function done() {
    dispatch("close");
  }

  function jumpToSettings(tab: SettingsTab) {
    if (busy || sshBusy) return;
    done();
    window.setTimeout(() => goView("settings", tab), 0);
  }

  function startExplore() {
    if (busy || sshBusy) return;
    done();
    window.setTimeout(() => goView("explore"), 0);
  }

  async function generateSsh() {
    if (busy || sshBusy || sshConfigured) return;
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
    if (busy || sshBusy) return;
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

<Modal cardClass="onboard-card" ariaLabelledby="onboarding-title" closeDisabled={busy || sshBusy} on:close={done}>
  <img class="login-mark" src="/icon-192.png" alt="" aria-hidden="true" width="48" height="48" />
  <h2 id="onboarding-title">아바타 사용 준비하기</h2>
  <p class="muted">먼저 프로필과 지식 저장소만 잡아두면 탐색과 대화에서 바로 쓰기 좋습니다.</p>

  <div class="onboard-quick" aria-label="초기 설정 상태">
    <button class="onboard-step" class:done={profileReady} type="button" disabled={busy || sshBusy} on:click={() => jumpToSettings("profile")}>
      <span class="onboard-step-icon"><Icon name={profileReady ? "check" : "user"} /></span>
      <span class="onboard-step-copy">
        <strong>프로필</strong>
        <span>{profileReady ? "기본 소개가 준비됨" : "이름·소개·역량 해시태그"}</span>
      </span>
    </button>
    <button class="onboard-step" class:done={knowledgeReady} type="button" disabled={busy || sshBusy} on:click={() => jumpToSettings("knowledge")}>
      <span class="onboard-step-icon"><Icon name={knowledgeReady ? "check" : "book"} /></span>
      <span class="onboard-step-copy">
        <strong>지식 저장소</strong>
        <span>{knowledgeReady ? "저장소 연결됨" : "업무 기억을 쌓을 저장소"}</span>
      </span>
    </button>
    <button class="onboard-step" class:done={accessReady} type="button" disabled={busy || sshBusy} on:click={() => jumpToSettings("access")}>
      <span class="onboard-step-icon"><Icon name={accessReady ? "check" : "key"} /></span>
      <span class="onboard-step-copy">
        <strong>권한 연결</strong>
        <span>{accessReady ? "작업 자격증명 일부 설정됨" : "Git, SSH, 문서 토큰"}</span>
      </span>
    </button>
    <button class="onboard-step primary-step" type="button" disabled={busy || sshBusy} on:click={startExplore}>
      <span class="onboard-step-icon"><Icon name="chat" /></span>
      <span class="onboard-step-copy">
        <strong>대화 시작</strong>
        <span>탐색으로 이동</span>
      </span>
    </button>
  </div>

  <div class="onboard-highlight">
    <strong>처음 맡겨볼 일</strong>
    <p>{STARTER_PROMPTS[0]}</p>
    <span class="onboard-highlight-note">{STARTER_PROMPTS[1]}</span>
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
            <RevealableInput bind:value={gitToken} name="token" placeholder="사내 GitHub PAT (GIT_TOKEN)" ariaLabel="사내 Git 토큰 GIT_TOKEN" revealLabel="토큰" disabled={busy} />
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
            <button class="primary" type="button" disabled={busy || sshConfigured || sshBusy} on:click={generateSsh}>
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
              <RevealableInput bind:value={confluencePat} name="confluence" placeholder="Confluence PAT (CONFLUENCE_PAT)" ariaLabel="Confluence Personal Access Token CONFLUENCE_PAT" revealLabel="토큰" disabled={busy} />
            </label>
          </div>
        </details>
      {/if}
    </div>

    {#if error}<div class="error" role="alert">{error}</div>{/if}

    <div class="onboard-actions">
      <button class="linkish" type="button" disabled={busy || sshBusy} on:click={done}>건너뛰기</button>
      <button class="primary" type="submit" disabled={busy || sshBusy}>{saveLabel}</button>
    </div>
  </form>
</Modal>
