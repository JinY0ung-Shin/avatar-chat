<script lang="ts">
  import type { AvatarApiKey } from "../../../shared/avatarTasks";
  import { api } from "../lib/api";
  import { copyText } from "../lib/dom";
  import { notify } from "../lib/state";

  export let active = false;
  let keys: AvatarApiKey[] = [];
  let loaded = false;
  let busy = false;
  let error = "";
  let name = "";
  let token = "";
  let newKeyId = "";
  $: if (active && !loaded && !busy) void load();
  $: if (!active) token = "";

  async function load() {
    busy = true;
    loaded = true;
    error = "";
    try { keys = (await api<{ keys: AvatarApiKey[] }>("/api/me/avatar-api-keys")).keys; }
    catch (err) { error = (err as Error).message; }
    finally { busy = false; }
  }
  async function create() {
    if (busy || !name.trim()) return;
    busy = true; error = ""; token = "";
    try {
      const result = await api<{ key: AvatarApiKey; token: string }>("/api/me/avatar-api-keys", {
        method: "POST", body: JSON.stringify({ name: name.trim() }),
      });
      keys = [result.key, ...keys]; newKeyId = result.key.id; token = active ? result.token : ""; name = "";
    } catch (err) { error = (err as Error).message; }
    finally { busy = false; }
  }
  async function revoke(id: string) {
    if (busy) return;
    busy = true; error = "";
    try {
      await api(`/api/me/avatar-api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      keys = keys.filter(key => key.id !== id);
      if (id === newKeyId) token = "";
      notify("API 키를 폐기했습니다.", "ok");
    } catch (err) { error = (err as Error).message; }
    finally { busy = false; }
  }
  async function copyToken() {
    try { await copyText(token); notify("API 키를 복사했습니다.", "ok"); }
    catch { error = "복사하지 못했습니다. API 키를 직접 선택해 복사해 주세요."; }
  }
</script>

{#if active}
  <section class="settings-card">
    <div class="panel-section-head">
      <strong>외부 작업 API</strong>
      <p class="muted">외부 시스템에서 내 아바타에게 자유롭게 지시할 수 있습니다. 이 키로 내 아바타의 도구를 사용하고 작업 결과를 조회할 수 있습니다.</p>
    </div>
    <form class="settings-form" on:submit|preventDefault={create}>
      <label class="field"><span>API 키 이름</span><input bind:value={name} maxlength="80" placeholder="예: 장애 모니터링" required disabled={busy} /></label>
      <button class="primary" type="submit" disabled={busy || !name.trim() || keys.length >= 10}>{busy ? "처리 중…" : "API 키 발급"}</button>
    </form>
    {#if token}
      <div class="key-reveal">
        <label class="field"><span>발급된 키 — 지금 한 번만 표시됩니다</span><input readonly value={token} aria-label="발급된 API 키" autocomplete="off" spellcheck="false" /></label>
        <button type="button" class="btn" on:click={copyToken}>키 복사</button>
        <button type="button" class="linkish" on:click={() => token = ""}>닫기</button>
      </div>
    {/if}
    {#if error}<div class="warn-box" role="alert">{error} <button class="linkish" type="button" disabled={busy} on:click={load}>목록 다시 불러오기</button></div>{/if}
    <div class="secret-list">
      {#each keys as key (key.id)}
        <div class="secret-row">
          <strong>{key.name}</strong><code>{key.prefix}…</code>
          <span class="muted">{key.lastUsedAt ? `최근 사용: ${new Date(key.lastUsedAt).toLocaleString("ko-KR")}` : "사용 이력 없음"}</span>
          <button class="linkish small" type="button" disabled={busy} aria-label={`API 키 폐기: ${key.name}`} on:click={() => revoke(key.id)}>폐기</button>
        </div>
      {:else}
        <p class="muted">{busy ? "불러오는 중…" : "발급된 API 키가 없습니다."}</p>
      {/each}
    </div>
    <details>
      <summary>호출 방법</summary>
      <p class="muted">아래 경로로 JSON을 전송하세요. 조건과 지시 내용은 외부 시스템에서 정합니다.</p>
      <pre>POST /api/v1/avatar/tasks
Authorization: Bearer &lt;발급된 API 키&gt;
Content-Type: application/json

{JSON.stringify({ message: "서비스 A의 오류 로그를 확인하고 원인을 분석해 줘" }, null, 2)}</pre>
      <p class="muted">접수 응답의 task.id로 GET /api/v1/avatar/tasks/:id를 호출하면 상태와 결과를 확인할 수 있습니다. conversationId를 함께 보내면 기존 내 아바타 대화에 이어집니다. 결과와 추가 질문은 Noah의 해당 대화에서도 확인하세요.</p>
      <p class="muted">키 폐기 시 새 요청과 대기 중인 작업이 차단됩니다. 이미 실행 중인 작업은 대화에서 중지할 수 있습니다.</p>
    </details>
  </section>
{/if}

<style>
  .key-reveal { margin-block: var(--s-3); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--t-xs); }
</style>
