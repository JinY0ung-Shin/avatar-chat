<script lang="ts">
  import AvatarImage from "./AvatarImage.svelte";
  import Icon from "./Icon.svelte";
  import HashtagChipEditor from "./HashtagChipEditor.svelte";
  import { api, refreshMe } from "../lib/api";
  import { appState, notify, readState, replaceState } from "../lib/state";
  import type { AvatarVisibility, User } from "../lib/types";

  export let active = false;

  const VISIBILITY_OPTIONS: { value: AvatarVisibility; label: string; desc: string }[] = [
    { value: "public", label: "모두 공개", desc: "모든 사용자가 탐색에서 찾아 대화할 수 있어요." },
    { value: "group", label: "그룹 공개", desc: "같은 그룹 멤버만 탐색에서 찾아 대화할 수 있어요." },
    { value: "private", label: "비공개", desc: "나만 볼 수 있어요." },
  ];

  $: user = $appState.user;

  // profile form
  const u0 = readState().user;
  let displayName = u0?.displayName || "";
  let alias = u0?.alias || "";
  let bio = u0?.bio || "";
  let intro = u0?.intro || "";
  let persona = u0?.persona || "";
  let hashtags: string[] = [...(u0?.hashtags || [])];
  let profileSaving = false;
  let introGenBusy = false;
  let tagGenBusy = false;
  let picBusy = false;
  let fileInput: HTMLInputElement;

  // visibility
  let visibility: AvatarVisibility = u0?.visibility || "group";
  let visSaving = false;

  async function saveProfile(): Promise<void> {
    profileSaving = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ displayName, alias, bio, intro, persona, hashtags }),
      });
      replaceState({ user: next });
      notify("프로필을 저장했습니다.", "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      profileSaving = false;
    }
  }

  async function generateIntro(): Promise<void> {
    introGenBusy = true;
    try {
      const { intro: next } = await api<{ intro: string }>("/api/me/intro/generate", { method: "POST" });
      if (next) {
        intro = next;
        notify("자기소개 초안이 채워졌습니다. 저장하려면 프로필 저장을 누르세요.", "info");
      } else {
        notify("생성된 자기소개가 없습니다. 페르소나나 스킬을 먼저 보강해 보세요.", "info");
      }
    } catch (err) {
      notify(`자기소개 생성 실패: ${(err as Error).message}`, "warn");
    } finally {
      introGenBusy = false;
    }
  }

  async function generateTags(): Promise<void> {
    tagGenBusy = true;
    try {
      const { hashtags: next } = await api<{ hashtags: string[] }>("/api/me/hashtags/generate", { method: "POST" });
      if (next?.length) {
        hashtags = [...next];
        notify("해시태그 초안이 채워졌습니다. 저장하려면 프로필 저장을 누르세요.", "info");
      } else {
        notify("생성된 해시태그가 없습니다. 스킬이나 플러그인을 먼저 연결해 보세요.", "info");
      }
    } catch (err) {
      notify(`해시태그 생성 실패: ${(err as Error).message}`, "warn");
    } finally {
      tagGenBusy = false;
    }
  }

  // ---- visibility ----
  async function chooseVisibility(val: AvatarVisibility): Promise<void> {
    if (visSaving || val === visibility) return;
    const prev = visibility;
    visibility = val;
    visSaving = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me", { method: "PATCH", body: JSON.stringify({ visibility: val }) });
      replaceState({ user: next });
      if (next.visibility !== val) {
        visibility = next.visibility;
        const label = VISIBILITY_OPTIONS.find((o) => o.value === next.visibility)?.label || next.visibility;
        notify(`공개 범위가 서버에서 ${label}(으)로 저장되었습니다.`, "warn");
      } else {
        const label = VISIBILITY_OPTIONS.find((o) => o.value === val)?.label || val;
        notify(`공개 범위를 ${label}(으)로 변경했습니다.`, "ok");
      }
    } catch (err) {
      visibility = prev;
      notify(`공개 범위 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      visSaving = false;
    }
  }

  // ---- avatar image ----
  async function uploadImage(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    picBusy = true;
    try {
      const image = await resizeImage(file, 256);
      await api("/api/me/avatar-image", { method: "PUT", body: JSON.stringify({ image }) });
      await refreshMe();
      notify("아바타 사진을 변경했습니다.", "ok");
    } catch (err) {
      notify(`사진 업로드 실패: ${(err as Error).message}`, "warn");
    } finally {
      input.value = "";
      picBusy = false;
    }
  }

  async function deleteImage(): Promise<void> {
    if (!window.confirm("아바타 사진을 삭제할까요?")) return;
    picBusy = true;
    try {
      await api("/api/me/avatar-image", { method: "DELETE" });
      await refreshMe();
      notify("아바타 사진을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`사진 삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      picBusy = false;
    }
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function resizeImage(file: File, max: number): Promise<string> {
    // Load via a `data:` URL, NOT `URL.createObjectURL`: a `blob:` URL is blocked
    // by the production CSP (`img-src 'self' data:`), which would fail the load.
    const sourceDataUrl = await readFileAsDataUrl(file);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL(file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/webp" ? "image/webp" : "image/png", 0.9));
      };
      img.onerror = reject;
      img.src = sourceDataUrl;
    });
  }
</script>

{#if active && user}
  <section class="settings-card">
    <div class="settings-head">
      <div class="pic-edit">
        <AvatarImage {user} size={96} alt="내 아바타 사진" />
        <button class="pic-cam" type="button" aria-label="사진 변경" title="사진 변경" disabled={picBusy} on:click={() => fileInput?.click()}>
          <Icon name="camera" />
        </button>
        <input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden on:change={uploadImage} />
        {#if user.hasImage}
          <button class="linkish small" type="button" disabled={picBusy} on:click={deleteImage}>사진 삭제</button>
        {/if}
      </div>
      <div class="settings-id">
        <h3>{user.displayName}</h3>
        <div class="muted">@{user.username}</div>
      </div>
    </div>

    <form class="settings-form" on:submit|preventDefault={saveProfile}>
      <label class="field"><span>표시 이름</span><input bind:value={displayName} required /></label>
      <label class="field"><span>별칭 (아바타가 스스로를 부르는 이름)</span><input bind:value={alias} placeholder="비우면 표시 이름을 사용합니다" /></label>
      <label class="field"><span>소개 (한 줄)</span><input bind:value={bio} placeholder="어떤 아바타인지 소개하세요" /></label>
      <div class="field">
        <div class="field-row">
          <span>자기소개 (대화 패널 상단에 표시)</span>
          <button class="ghost-sm" type="button" disabled={introGenBusy} on:click={generateIntro}>{introGenBusy ? "생성 중…" : "아바타가 자동 생성"}</button>
        </div>
        <textarea rows="4" bind:value={intro} placeholder="대화 상대에게 보여줄 자기소개. 직접 쓰거나 위의 '아바타가 자동 생성' 버튼으로 만들 수 있어요."></textarea>
      </div>
      <div class="field">
        <div class="field-row">
          <span>역량 해시태그 (탐색에서 검색됨)</span>
          <button class="ghost-sm" type="button" disabled={tagGenBusy} on:click={generateTags}>{tagGenBusy ? "생성 중…" : "아바타가 자동 생성"}</button>
        </div>
        <HashtagChipEditor bind:tags={hashtags} />
      </div>
      <label class="field"><span>페르소나 (행동 지침)</span><textarea rows="4" bind:value={persona} placeholder="이 아바타가 어떻게 행동해야 하는지 (선택)"></textarea></label>
      <button class="primary" type="submit" disabled={profileSaving}>{profileSaving ? "저장 중…" : "프로필 저장"}</button>
    </form>
  </section>

  <section class="settings-card">
    <h3>공개 설정</h3>
    <div class="visibility-row">
      <div class="seg-control" role="radiogroup" aria-label="아바타 공개 범위" aria-busy={visSaving}>
        {#each VISIBILITY_OPTIONS as opt}
          <button
            type="button"
            class="seg-btn"
            class:active={visibility === opt.value}
            role="radio"
            aria-checked={visibility === opt.value}
            tabindex={visibility === opt.value ? 0 : -1}
            disabled={visSaving}
            on:click={() => chooseVisibility(opt.value)}
          >
            {opt.label}
          </button>
        {/each}
      </div>
      <p class="muted">
        {VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.desc || ""}{visSaving ? " 저장 중…" : ""}
      </p>
    </div>
  </section>
{/if}
