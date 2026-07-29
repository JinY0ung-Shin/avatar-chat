<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Modal from "./Modal.svelte";
  import { releaseDateLabel, type ReleaseNote } from "../../../server/releaseNotes";

  /** Unseen release entries, newest first (App computes via unseenReleases). */
  export let releases: ReleaseNote[];

  const dispatch = createEventDispatcher<{ close: void }>();

  function done() {
    dispatch("close");
  }
</script>

<!-- One-time "what's new" notice after a deploy. Every dismissal path (button,
     backdrop, Esc, mobile swipe) funnels through `close`, and App marks the
     release seen server-side — so it can never nag on the next load. -->
<Modal cardClass="whats-new-card" ariaLabelledby="whats-new-title" on:close={done}>
  <h2 id="whats-new-title">새로워진 기능</h2>
  <p class="muted">최근 업데이트로 달라진 점을 소개해요.</p>

  {#each releases as release (release.id)}
    <section class="whats-new-release" aria-label={`${releaseDateLabel(release.id)} 업데이트`}>
      <h3>{releaseDateLabel(release.id)}</h3>
      <ul class="whats-new-list">
        {#each release.items as item (item.title)}
          <li>
            <strong>{item.title}</strong>
            <span>{item.body}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  <div class="whats-new-actions">
    <button class="primary" type="button" data-modal-autofocus on:click={done}>확인</button>
  </div>
</Modal>
