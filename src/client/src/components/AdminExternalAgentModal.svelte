<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Modal from "./Modal.svelte";
  import RevealableInput from "./RevealableInput.svelte";
  import HashtagChipEditor from "./HashtagChipEditor.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { notify } from "../lib/state";
  import type {
    AdminExternalAgent,
    AdminExternalAgentInput,
    AdminGroupSummary,
  } from "../lib/types";

  export let agent: AdminExternalAgent | null = null;
  export let groups: AdminGroupSummary[] = [];

  const dispatch = createEventDispatcher<{ close: void; saved: void }>();
  const isEdit = Boolean(agent);
  const titleId = `external-agent-editor-${agent?.id || "new"}-title`;
  const descriptionId = `external-agent-editor-${agent?.id || "new"}-description`;
  const statusId = `external-agent-editor-${agent?.id || "new"}-status`;

  let id = agent?.id || "";
  let displayName = agent?.displayName || "";
  let alias = agent?.alias || "";
  let bio = agent?.bio || "";
  let persona = agent?.persona || "";
  let intro = agent?.intro || "";
  let hashtags = [...(agent?.hashtags || [])];
  let endpoint = agent?.endpoint || "";
  let model = agent?.model || "";
  let system = agent?.system || "";
  let enabled = agent?.enabled ?? true;
  let visibility: "public" | "group" = agent?.visibleToGroupIds?.length
    ? "group"
    : "public";
  let selectedGroupIds = [...(agent?.visibleToGroupIds || [])];
  let apiKeyMode: "keep" | "set" | "clear" = "keep";
  let apiKey = "";
  let connectTimeout = agent?.connectTimeoutSeconds?.toString() || "";
  let idleTimeout = agent?.idleTimeoutSeconds?.toString() || "";
  let totalTimeout = agent?.totalTimeoutSeconds?.toString() || "";
  let busy = false;
  let testBusy = false;
  let error = "";
  let testMessage = "";
  let testKind: "ok" | "warn" | "error" | "" = "";

  $: knownGroupIds = new Set(groups.map((group) => group.id));
  $: missingGroupIds = selectedGroupIds.filter((groupId) => !knownGroupIds.has(groupId));
  $: idReady = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id.trim());
  $: endpointReady = validEndpoint(endpoint);
  $: groupsReady = visibility === "public" || selectedGroupIds.length > 0;
  $: apiKeyReady = apiKeyMode !== "set" || Boolean(apiKey.trim());
  $: timeoutsReady = [
    [connectTimeout, 300],
    [idleTimeout, 3_600],
    [totalTimeout, 86_400],
  ].every(([value, max]) => !value || validPositiveNumber(String(value), Number(max)));
  $: formReady = Boolean(
    idReady &&
      displayName.trim() &&
      endpointReady &&
      groupsReady &&
      apiKeyReady &&
      timeoutsReady &&
      !missingGroupIds.length,
  );
  $: canSubmit = Boolean(!busy && !testBusy && formReady);
  $: status = busy
    ? "저장 중…"
    : error
      ? error
      : !idReady
        ? "ID는 영문·숫자로 시작하고 영문·숫자·_·-만 사용할 수 있습니다."
        : !displayName.trim()
          ? "표시 이름을 입력해 주세요."
          : !endpointReady
            ? "http 또는 https 형식의 Gateway endpoint를 입력해 주세요."
            : !groupsReady
              ? "그룹 공개를 선택했다면 한 개 이상의 그룹을 선택해 주세요."
              : missingGroupIds.length
                ? "삭제되었거나 알 수 없는 그룹 선택을 먼저 해제해 주세요."
                : !apiKeyReady
                  ? "교체할 Gateway API 키를 입력해 주세요."
                  : !timeoutsReady
                    ? "고급 시간 제한은 허용 범위 안의 양수여야 합니다."
                    : "저장할 준비가 됐습니다.";

  function validEndpoint(value: string): boolean {
    try {
      const url = new URL(value.trim());
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    } catch {
      return false;
    }
  }

  function validPositiveNumber(value: string, max: number): boolean {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= max;
  }

  function optionalSeconds(value: string): number | undefined {
    return value.trim() ? Number(value) : undefined;
  }

  function toggleGroup(groupId: string, checked: boolean): void {
    selectedGroupIds = checked
      ? [...new Set([...selectedGroupIds, groupId])]
      : selectedGroupIds.filter((id) => id !== groupId);
    error = "";
  }

  function onApiKeyInput(): void {
    if (apiKey.trim()) apiKeyMode = "set";
    error = "";
  }

  function formValue(): AdminExternalAgentInput {
    return {
      id: id.trim(),
      displayName: displayName.trim(),
      alias: alias.trim(),
      bio: bio.trim(),
      persona: persona.trim(),
      intro: intro.trim(),
      hashtags,
      endpoint: endpoint.trim(),
      agent: "claude",
      enabled,
      model: model.trim(),
      system: system.trim(),
      ...(visibility === "group"
        ? { visibleToGroupIds: selectedGroupIds }
        : {}),
      ...(optionalSeconds(connectTimeout) !== undefined
        ? { connectTimeoutSeconds: optionalSeconds(connectTimeout) }
        : {}),
      ...(optionalSeconds(idleTimeout) !== undefined
        ? { idleTimeoutSeconds: optionalSeconds(idleTimeout) }
        : {}),
      ...(optionalSeconds(totalTimeout) !== undefined
        ? { totalTimeoutSeconds: optionalSeconds(totalTimeout) }
        : {}),
      apiKeyMode,
      ...(apiKeyMode === "set" ? { apiKey: apiKey.trim() } : {}),
    };
  }

  async function testConnection(): Promise<void> {
    if (!canSubmit || testBusy) return;
    testBusy = true;
    error = "";
    testKind = "";
    testMessage = "Gateway 인증과 모델 목록을 확인하는 중…";
    try {
      const result = await api<{
        latencyMs: number;
        modelsCount: number;
        modelAvailable: boolean | null;
      }>("/api/admin/external-agents/test", {
        method: "POST",
        body: JSON.stringify({
          ...(agent ? { storedId: agent.id } : {}),
          agent: formValue(),
        }),
      });
      if (result.modelAvailable === false) {
        testKind = "warn";
        testMessage = `Gateway 연결은 확인했지만 입력한 모델이 Claude 모델 목록에 없습니다. (${result.latencyMs}ms)`;
      } else {
        testKind = "ok";
        testMessage = `Gateway 연결과 인증을 확인했습니다. Claude 모델 ${result.modelsCount}개 · ${result.latencyMs}ms`;
      }
    } catch (err) {
      testKind = "error";
      testMessage = `연결 확인 실패: ${(err as Error).message}`;
    } finally {
      testBusy = false;
    }
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    let confirmEndpointChange = false;
    if (
      agent &&
      agent.conversationCount > 0 &&
      agent.endpoint !== endpoint.trim()
    ) {
      confirmEndpointChange = await confirmAction(
        `Gateway 주소를 변경할까요?\n기존 대화 전체 기록이 다음 질문부터 새 Gateway로 전송될 수 있습니다.`,
      );
      if (!confirmEndpointChange) return;
    }
    busy = true;
    error = "";
    try {
      await api(
        agent
          ? `/api/admin/external-agents/${encodeURIComponent(agent.id)}`
          : "/api/admin/external-agents",
        {
          method: agent ? "PUT" : "POST",
          body: JSON.stringify({
            agent: formValue(),
            ...(confirmEndpointChange ? { confirmEndpointChange: true } : {}),
          }),
        },
      );
      notify(
        agent
          ? `외부 아바타 "${displayName.trim()}" 설정을 저장했습니다.`
          : `외부 아바타 "${displayName.trim()}"을 추가했습니다.`,
        "ok",
      );
      dispatch("saved");
      dispatch("close");
    } catch (err) {
      busy = false;
      error = `저장 실패: ${(err as Error).message}`;
    }
  }
</script>

<Modal
  cardClass="external-agent-modal-card"
  ariaLabelledby={titleId}
  ariaDescribedby={descriptionId}
  closeDisabled={busy || testBusy}
  on:close={() => dispatch("close")}
>
  <div class="external-agent-modal-head">
    <div>
      <h2 id={titleId}>{agent ? "외부 아바타 편집" : "외부 아바타 추가"}</h2>
      <p class="muted" id={descriptionId}>
        Noah가 stateless `/v1/agents/messages` Gateway를 통해 호출할 아바타를 설정합니다.
      </p>
    </div>
    <label class="external-agent-enabled">
      <input type="checkbox" bind:checked={enabled} disabled={busy || testBusy} />
      <span>{enabled ? "활성" : "비활성"}</span>
    </label>
  </div>

  <form class="external-agent-form" on:submit|preventDefault={submit}>
    <fieldset class="external-agent-section" disabled={busy || testBusy}>
      <legend>프로필</legend>
      <div class="external-agent-fields two-columns">
        <label class="field">
          <span>ID</span>
          <input bind:value={id} disabled={isEdit || busy || testBusy} placeholder="research-agent" autocomplete="off" aria-describedby={statusId} />
          <small class="field-hint">생성 후 변경할 수 없으며 공개 ID는 external:{id || "…"}입니다.</small>
        </label>
        <label class="field">
          <span>표시 이름</span>
          <input bind:value={displayName} placeholder="Research Agent" autocomplete="off" aria-describedby={statusId} />
        </label>
        <label class="field">
          <span>별칭</span>
          <input bind:value={alias} placeholder="대화에서 사용할 이름 (선택)" autocomplete="off" />
        </label>
        <label class="field">
          <span>짧은 소개</span>
          <input bind:value={bio} placeholder="탐색 카드에 표시할 설명" autocomplete="off" />
        </label>
      </div>
      <label class="field">
        <span>페르소나</span>
        <textarea bind:value={persona} rows="3" placeholder="아바타의 공개 페르소나"></textarea>
        <small class="field-hint">별도 시스템 지침을 비우면 이 페르소나가 Gateway 요청의 system으로 전달됩니다.</small>
      </label>
      <label class="field">
        <span>첫 인사</span>
        <textarea bind:value={intro} rows="2" placeholder="대화 화면에 표시할 소개"></textarea>
      </label>
      <div class="field">
        <span>역량 해시태그</span>
        <HashtagChipEditor bind:tags={hashtags} disabled={busy || testBusy} />
      </div>
    </fieldset>

    <fieldset class="external-agent-section" disabled={busy || testBusy}>
      <legend>Gateway</legend>
      <label class="field">
        <span>메시지 endpoint</span>
        <input bind:value={endpoint} type="url" placeholder="https://gateway.example/v1/agents/messages" autocomplete="url" aria-describedby={statusId} />
        <small class="field-hint">리디렉션은 허용하지 않으며 API 키는 Authorization: Bearer 헤더로만 전송됩니다.</small>
      </label>
      <div class="external-agent-fields two-columns">
        <label class="field">
          <span>Agent</span>
          <input value="claude" disabled />
          <small class="field-hint">v1 계약은 Claude agent만 지원합니다.</small>
        </label>
        <label class="field">
          <span>모델</span>
          <input bind:value={model} placeholder="비우면 Gateway 기본값" autocomplete="off" />
        </label>
      </div>
      <label class="field">
        <span>추가 시스템 지침</span>
        <textarea bind:value={system} rows="5" placeholder="Gateway 기본 시스템 프롬프트 뒤에 추가할 지침 (선택)"></textarea>
        <small class="field-hint">Gateway의 기본 정책을 대체하지 않고 뒤에 추가되며, 다음 대화 턴부터 적용됩니다.</small>
      </label>

      <div class="field">
        <span>Gateway API 키</span>
        <div class="external-agent-key-modes" role="radiogroup" aria-label="Gateway API 키 처리">
          {#if agent?.apiKeySet}
            <label><input type="radio" bind:group={apiKeyMode} value="keep" /> 기존 키 유지</label>
          {:else}
            <label><input type="radio" bind:group={apiKeyMode} value="keep" /> 키 없이 사용</label>
          {/if}
          <label><input type="radio" bind:group={apiKeyMode} value="set" /> 새 키 등록</label>
          {#if agent?.apiKeySet}
            <label><input type="radio" bind:group={apiKeyMode} value="clear" /> 저장된 키 삭제</label>
          {/if}
        </div>
        {#if apiKeyMode === "set"}
          <RevealableInput
            bind:value={apiKey}
            name="gatewayApiKey"
            placeholder="Gateway bearer token"
            ariaLabel="Gateway API 키"
            ariaDescribedby={statusId}
            ariaInvalid={!apiKeyReady}
            revealLabel="API 키"
            disabled={busy || testBusy}
            onInput={onApiKeyInput}
          />
        {/if}
        <small class="field-hint">값은 암호화해 저장하고, 저장 후에는 다시 표시하지 않습니다.</small>
      </div>

      <details class="external-agent-advanced">
        <summary>고급 시간 제한</summary>
        <div class="external-agent-fields three-columns">
          <label class="field">
            <span>연결 (초)</span>
            <input bind:value={connectTimeout} type="number" min="1" max="300" placeholder="15" inputmode="numeric" />
          </label>
          <label class="field">
            <span>스트림 무응답 (초)</span>
            <input bind:value={idleTimeout} type="number" min="1" max="3600" placeholder="120" inputmode="numeric" />
          </label>
          <label class="field">
            <span>전체 실행 (초)</span>
            <input bind:value={totalTimeout} type="number" min="1" max="86400" placeholder="1800" inputmode="numeric" />
          </label>
        </div>
      </details>
    </fieldset>

    <fieldset class="external-agent-section" disabled={busy || testBusy}>
      <legend>공개 범위</legend>
      <div class="radio-cards compact" role="radiogroup" aria-label="외부 아바타 공개 범위">
        <label class="radio-card">
          <input type="radio" bind:group={visibility} value="public" />
          <div class="radio-card-body"><strong>모든 사용자</strong><div class="muted">로그인한 모든 Noah 사용자에게 표시</div></div>
        </label>
        <label class="radio-card">
          <input type="radio" bind:group={visibility} value="group" />
          <div class="radio-card-body"><strong>지정 그룹</strong><div class="muted">선택한 그룹의 현재 구성원에게만 표시</div></div>
        </label>
      </div>
      {#if visibility === "group"}
        <div class="external-agent-group-picker" role="group" aria-label="허용 그룹">
          {#if !groups.length && !missingGroupIds.length}
            <div class="empty-note">먼저 관리자 ▸ 그룹에서 그룹을 만들어 주세요.</div>
          {:else}
            {#each groups as group (group.id)}
              <label class="external-agent-group-option">
                <input
                  type="checkbox"
                  checked={selectedGroupIds.includes(group.id)}
                  on:change={(event) => toggleGroup(group.id, event.currentTarget.checked)}
                />
                <span><strong>{group.name}</strong><small class="muted">그룹원 {group.memberCount}명</small></span>
              </label>
            {/each}
            {#each missingGroupIds as groupId (groupId)}
              <label class="external-agent-group-option invalid">
                <input type="checkbox" checked on:change={(event) => toggleGroup(groupId, event.currentTarget.checked)} />
                <span><strong>알 수 없는 그룹</strong><small class="muted mono">{groupId}</small></span>
              </label>
            {/each}
          {/if}
        </div>
        <p class="muted external-agent-acl-note">이 설정은 Noah에서의 노출만 제한하며 Gateway 도구 권한이나 신뢰 권한을 부여하지 않습니다.</p>
      {/if}
    </fieldset>

    <div
      id={statusId}
      class="routine-form-status"
      class:invalid={Boolean(error || !formReady)}
      class:dirty={formReady && !busy && !testBusy}
      class:pending={busy}
      role="status"
      aria-live="polite"
    >{status}</div>
    {#if testMessage}
      <div class="external-agent-test-result {testKind}" role="status" aria-live="polite">{testMessage}</div>
    {/if}

    <div class="routine-modal-actions">
      <div class="routine-modal-actions-left">
        <button class="ghost-sm" type="button" disabled={!canSubmit || testBusy} on:click={testConnection}>
          {testBusy ? "확인 중…" : "Gateway 연결 확인"}
        </button>
      </div>
      <div class="routine-modal-actions-right">
        <button class="ghost-sm" type="button" disabled={busy || testBusy} on:click={() => dispatch("close")}>취소</button>
        <button class="primary" type="submit" disabled={!canSubmit}>{busy ? "저장 중…" : agent ? "변경 저장" : "아바타 추가"}</button>
      </div>
    </div>
  </form>
</Modal>
