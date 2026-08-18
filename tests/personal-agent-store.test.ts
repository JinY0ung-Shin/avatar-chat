import path from "node:path";
import { describe, expect, it } from "vitest";
import { createServices } from "../src/server/app.js";
import { MAX_PERSONAL_AGENTS } from "../src/server/store.js";
import {
  findChattablePersonalAgent,
  listPersonalAgentAvatarSummaries,
  parsePersonalAgentRef,
  personalAgentAvatarDetail,
  personalAgentAvatarId,
  personalAgentAvatarSummary,
  personalAgentWorkspaceParent,
} from "../src/server/personalAgents.js";
import { workspaceDirFor } from "../src/server/workspace.js";
import { withTempDir } from "./helpers.js";

const tempDir = withTempDir("personal-agent-store");

function services(dir: string) {
  return createServices({
    dataDir: path.join(tempDir(), dir),
    agentRuntime: "local",
    sessionSecret: "t",
  });
}

/** The FIRST account of a fresh store is auto-admin (createUser); later ones are members. */
function makeUser(
  store: ReturnType<typeof services>["store"],
  username: string,
  opts: { admin?: boolean } = {},
) {
  const user = store.createUser({ username, displayName: username, password: "password123" });
  if (opts.admin) store.setRole(user.id, "admin", true);
  return user;
}

describe("store personal agents", () => {
  it("creates/updates bots, normalizing hashtags and keeping unspecified fields", () => {
    const { store } = services("crud");
    const owner = makeUser(store, "owner");
    expect(store.listPersonalAgents(owner.id)).toEqual([]);

    const created = store.createPersonalAgent(owner.id, {
      displayName: "  회의록 봇  ",
      alias: "  록이  ",
      hashtags: ["#Notes", "notes", "회의록"],
    });
    expect(created.id).toBeTruthy();
    expect(created.ownerUserId).toBe(owner.id);
    expect(created.displayName).toBe("회의록 봇");
    expect(created.alias).toBe("록이");
    expect(created.enabled).toBe(true); // default
    expect(created.hasImage).toBe(false);
    expect(created.persona).toBe("");
    expect(created.defaultModel).toBeNull();
    expect(created.createdAt).toBeTruthy();
    // normalizeHashtags strips "#" and dedupes case-insensitively (first wins).
    expect(created.hashtags).toEqual(["Notes", "회의록"]);

    // A SECOND bot for the same owner, listed by display name.
    const second = store.createPersonalAgent(owner.id, { displayName: "배포 봇" });
    expect(second.id).not.toBe(created.id);
    expect(store.listPersonalAgents(owner.id).map((a) => a.displayName)).toEqual([
      "배포 봇",
      "회의록 봇",
    ]);

    // Update merges: unspecified fields carry over, created_at is insert-only.
    const updated = store.updatePersonalAgent(created.id, { persona: "간결하게" })!;
    expect(updated.persona).toBe("간결하게");
    expect(updated.alias).toBe("록이");
    expect(updated.hashtags).toEqual(["Notes", "회의록"]);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeTruthy();
    expect(store.updatePersonalAgent("ghost", { enabled: false })).toBeNull();

    // Disabling one bot leaves the sibling alone.
    expect(store.updatePersonalAgent(created.id, { enabled: false })?.enabled).toBe(false);
    expect(store.getPersonalAgentById(second.id)?.enabled).toBe(true);
  });

  it("distinguishes defaultModel keep (undefined) from clear (null)", () => {
    const { store } = services("default-model");
    const owner = makeUser(store, "owner");
    const bot = store.createPersonalAgent(owner.id, {
      displayName: "모델 봇",
      defaultModel: "sonnet",
    });
    expect(bot.defaultModel).toBe("sonnet");

    // Omitted → keep.
    expect(store.updatePersonalAgent(bot.id, { bio: "메모" })?.defaultModel).toBe("sonnet");
    // Explicit null → clear.
    expect(store.updatePersonalAgent(bot.id, { defaultModel: null })?.defaultModel).toBeNull();
    // Re-set.
    expect(store.updatePersonalAgent(bot.id, { defaultModel: "haiku" })?.defaultModel).toBe("haiku");
  });

  it("throws INVALID_PERSONAL_AGENT_NAME on an empty trimmed name (create + update)", () => {
    const { store } = services("bad-name");
    const owner = makeUser(store, "owner");
    expect(() => store.createPersonalAgent(owner.id, { displayName: "   " })).toThrow(
      "INVALID_PERSONAL_AGENT_NAME",
    );
    const bot = store.createPersonalAgent(owner.id, { displayName: "봇" });
    expect(() => store.updatePersonalAgent(bot.id, { displayName: " " })).toThrow(
      "INVALID_PERSONAL_AGENT_NAME",
    );
    // The failed patch changed nothing.
    expect(store.getPersonalAgentById(bot.id)?.displayName).toBe("봇");
  });

  it("counts DISABLED bots against the cap and throws PERSONAL_AGENT_LIMIT at the ceiling", () => {
    const { store } = services("cap");
    const owner = makeUser(store, "owner");
    const other = makeUser(store, "other");
    for (let i = 0; i < MAX_PERSONAL_AGENTS; i += 1) {
      store.createPersonalAgent(owner.id, {
        displayName: `봇-${i}`,
        // Half disabled: a disabled bot still occupies its slot.
        enabled: i % 2 === 0,
      });
    }
    expect(MAX_PERSONAL_AGENTS).toBe(20);
    expect(store.countPersonalAgents(owner.id)).toBe(20);
    expect(store.listPersonalAgents(owner.id)).toHaveLength(10);
    expect(store.listPersonalAgents(owner.id, { includeDisabled: true })).toHaveLength(20);

    expect(() => store.createPersonalAgent(owner.id, { displayName: "한 개 더" })).toThrow(
      "PERSONAL_AGENT_LIMIT",
    );
    // The cap is per owner.
    expect(store.createPersonalAgent(other.id, { displayName: "남의 봇" }).id).toBeTruthy();

    // Deleting frees a slot.
    const doomed = store.listPersonalAgents(owner.id, { includeDisabled: true })[0];
    expect(store.deletePersonalAgent(doomed.id)).toBe(true);
    expect(store.createPersonalAgent(owner.id, { displayName: "다시 한 개" }).id).toBeTruthy();
  });

  it("round-trips the profile-image ext by PUBLIC avatar id, failing closed on a mismatch", () => {
    const { store } = services("image");
    const owner = makeUser(store, "owner");
    const other = makeUser(store, "other");
    const bot = store.createPersonalAgent(owner.id, { displayName: "봇" });

    store.setPersonalAgentImageExt(bot.id, "png");
    expect(store.getPersonalAgentById(bot.id)?.hasImage).toBe(true);
    expect(
      store.getPersonalAgentImageExtByAvatarId(personalAgentAvatarId(owner.id, bot.id)),
    ).toBe("png");
    // A real bot id under the WRONG owner id resolves to nothing.
    expect(
      store.getPersonalAgentImageExtByAvatarId(personalAgentAvatarId(other.id, bot.id)),
    ).toBeNull();
    expect(store.getPersonalAgentImageExtByAvatarId(`personal:${bot.id}`)).toBeNull();
    expect(store.getPersonalAgentImageExtByAvatarId("personal:")).toBeNull();
    expect(store.getPersonalAgentImageExtByAvatarId(owner.id)).toBeNull();

    store.setPersonalAgentImageExt(bot.id, null);
    expect(store.getPersonalAgentById(bot.id)?.hasImage).toBe(false);
  });

  it("deletePersonalAgent cascades ONE bot's threads (messages + canvases) only", () => {
    const { store } = services("del-bot");
    const owner = makeUser(store, "owner");
    const other = makeUser(store, "other");
    const doomed = store.createPersonalAgent(owner.id, { displayName: "지울 봇" });
    const sibling = store.createPersonalAgent(owner.id, { displayName: "남는 봇" });
    const foreign = store.createPersonalAgent(other.id, { displayName: "남의 봇" });
    const doomedAvatar = personalAgentAvatarId(owner.id, doomed.id);
    const siblingAvatar = personalAgentAvatarId(owner.id, sibling.id);
    const foreignAvatar = personalAgentAvatarId(other.id, foreign.id);

    store.touchConversation(owner.id, "d-conv", doomedAvatar, "질문");
    store.addMessage("d-conv", { role: "user", content: "안녕" });
    store.upsertCanvasArtifact(owner.id, "d-conv", {
      artifactId: "canvas-1",
      title: "보드",
      content: "# hi",
      contentType: "markdown",
    });
    expect(store.listCanvasArtifacts(owner.id, "d-conv")).toHaveLength(1);
    store.touchConversation(owner.id, "s-conv", siblingAvatar, "질문");
    store.touchConversation(other.id, "o-conv", foreignAvatar, "질문");
    // The owner's own personal thread must survive.
    store.touchConversation(owner.id, "self-conv", owner.id, "메모");

    expect(store.deletePersonalAgent("ghost")).toBe(false);
    expect(store.deletePersonalAgent(doomed.id)).toBe(true);
    expect(store.getPersonalAgentById(doomed.id)).toBeNull();
    expect(store.countConversationsForAvatar(doomedAvatar)).toBe(0);
    expect(store.listMessages(owner.id, "d-conv")).toEqual([]);
    expect(store.listCanvasArtifacts(owner.id, "d-conv")).toEqual([]);
    expect(store.getPersonalAgentById(sibling.id)).not.toBeNull();
    expect(store.countConversationsForAvatar(siblingAvatar)).toBe(1);
    expect(store.getPersonalAgentById(foreign.id)).not.toBeNull();
    expect(store.countConversationsForAvatar(foreignAvatar)).toBe(1);
    expect(store.countConversationsForAvatar(owner.id)).toBe(1);
  });

  it("deleteUser removes the owner's bot rows AND their bot threads, sparing other owners", () => {
    const { store } = services("del-user");
    const doomedOwner = makeUser(store, "doomed");
    const survivor = makeUser(store, "survivor");
    const doomedBot = store.createPersonalAgent(doomedOwner.id, { displayName: "지울 봇" });
    const survivorBot = store.createPersonalAgent(survivor.id, { displayName: "남는 봇" });
    const doomedAvatar = personalAgentAvatarId(doomedOwner.id, doomedBot.id);
    const survivorAvatar = personalAgentAvatarId(survivor.id, survivorBot.id);

    store.touchConversation(doomedOwner.id, "d-conv", doomedAvatar, "질문");
    store.addMessage("d-conv", { role: "user", content: "안녕" });
    store.upsertCanvasArtifact(doomedOwner.id, "d-conv", {
      artifactId: "canvas-1",
      title: "보드",
      content: "# hi",
      contentType: "markdown",
    });
    store.touchConversation(survivor.id, "s-conv", survivorAvatar, "질문");

    expect(store.deleteUser(doomedOwner.id)).toBe(true);
    expect(store.getPersonalAgentById(doomedBot.id)).toBeNull();
    expect(store.countPersonalAgents(doomedOwner.id)).toBe(0);
    // The owner_user_id conversation arm already cascaded the bot threads.
    expect(store.countConversationsForAvatar(doomedAvatar)).toBe(0);
    expect(store.listMessages(doomedOwner.id, "d-conv")).toEqual([]);
    expect(store.listCanvasArtifacts(doomedOwner.id, "d-conv")).toEqual([]);
    expect(store.getPersonalAgentById(survivorBot.id)).not.toBeNull();
    expect(store.countConversationsForAvatar(survivorAvatar)).toBe(1);
  });

  it("resolves the bot display name in conversation summaries (no '삭제된 아바타')", () => {
    const { store } = services("conv-name");
    const owner = makeUser(store, "owner");
    const bot = store.createPersonalAgent(owner.id, { displayName: "팀 비서" });
    store.touchConversation(owner.id, "c1", personalAgentAvatarId(owner.id, bot.id), "안녕");

    const summaries = store.listConversations(owner.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      avatarUserId: personalAgentAvatarId(owner.id, bot.id),
      avatarDisplayName: "팀 비서",
    });
    // The single-summary SQL site (renameConversation) must resolve it too.
    expect(store.renameConversation(owner.id, "c1", "회의")?.avatarDisplayName).toBe("팀 비서");
    // The join is live, not a snapshot taken at conversation creation.
    store.updatePersonalAgent(bot.id, { displayName: "팀 비서 2" });
    expect(store.listConversations(owner.id)[0].avatarDisplayName).toBe("팀 비서 2");
  });
});

describe("personal-agent helpers", () => {
  it("round-trips the avatar id namespace and fails closed on every malformed form", () => {
    expect(personalAgentAvatarId("u-1", "a-1")).toBe("personal:u-1:a-1");
    expect(parsePersonalAgentRef("personal:u-1:a-1")).toEqual({
      ownerUserId: "u-1",
      agentId: "a-1",
    });
    // A single-segment (group-agent-legacy-looking) form is not a bot ref.
    expect(parsePersonalAgentRef("personal:a-1")).toBeNull();
    expect(parsePersonalAgentRef("personal:u-1:")).toBeNull();
    expect(parsePersonalAgentRef("personal::a-1")).toBeNull();
    expect(parsePersonalAgentRef("personal:u-1:a-1:extra")).toBeNull();
    expect(parsePersonalAgentRef("personal:")).toBeNull();
    expect(parsePersonalAgentRef("group:g-1:a-1")).toBeNull();
    expect(parsePersonalAgentRef("external:x")).toBeNull();
    expect(parsePersonalAgentRef("plain-uuid")).toBeNull();
  });

  it("findChattablePersonalAgent gates on ref, existence, owner match, admin role, enabled", () => {
    const { store } = services("gate");
    const owner = makeUser(store, "owner"); // first account → admin
    const otherAdmin = makeUser(store, "other-admin", { admin: true });
    const member = makeUser(store, "member");
    const bot = store.createPersonalAgent(owner.id, { displayName: "내 봇" });
    const id = personalAgentAvatarId(owner.id, bot.id);

    expect(findChattablePersonalAgent(store, owner.id, id)?.agent.id).toBe(bot.id);
    // A real bot id under the WRONG owner id in the ref fails closed.
    expect(
      findChattablePersonalAgent(store, owner.id, personalAgentAvatarId(member.id, bot.id)),
    ).toBeNull();
    // Non-owner viewers never reach it — another SYSTEM ADMIN included.
    expect(findChattablePersonalAgent(store, otherAdmin.id, id)).toBeNull();
    expect(findChattablePersonalAgent(store, member.id, id)).toBeNull();
    // Unknown bot / non-bot avatar ids.
    expect(findChattablePersonalAgent(store, owner.id, "personal:x:ghost")).toBeNull();
    expect(findChattablePersonalAgent(store, owner.id, owner.id)).toBeNull();

    // Losing the admin role fails the NEXT turn closed (the row is untouched).
    store.setRole(owner.id, "admin", false);
    expect(findChattablePersonalAgent(store, owner.id, id)).toBeNull();
    expect(
      findChattablePersonalAgent(store, owner.id, id, { includeDisabled: true }),
    ).toBeNull();
    expect(store.getPersonalAgentById(bot.id)).not.toBeNull();
    store.setRole(owner.id, "admin", true);

    // Disabled: hidden from read surfaces, visible to the chat route's probe.
    store.updatePersonalAgent(bot.id, { enabled: false });
    expect(findChattablePersonalAgent(store, owner.id, id)).toBeNull();
    expect(
      findChattablePersonalAgent(store, owner.id, id, { includeDisabled: true })?.agent.enabled,
    ).toBe(false);
  });

  it("projects wire summaries/details keyed by the composite id", () => {
    const { store } = services("wire");
    const owner = makeUser(store, "owner");
    const bot = store.createPersonalAgent(owner.id, {
      displayName: "회의록 봇",
      alias: "록이",
      bio: "회의록을 정리합니다",
      intro: "안녕하세요",
      persona: "간결하게",
      hashtags: ["회의록"],
      defaultModel: "sonnet",
    });

    const summary = personalAgentAvatarSummary(bot);
    expect(summary).toMatchObject({
      id: personalAgentAvatarId(owner.id, bot.id),
      username: `personal-agent-${bot.id.slice(0, 8)}`,
      displayName: "회의록 봇",
      alias: "록이",
      bio: "회의록을 정리합니다",
      hashtags: ["회의록"],
      hasImage: false,
      pluginCount: 0,
      // Owner-only reach; "group" keeps the 탐색 비공개 chip off.
      visibility: "group",
      runtime: "native",
      sharesGroup: false,
      personalAgent: { agentId: bot.id, defaultModel: "sonnet" },
    });
    expect(summary.updatedAt).toBeNull();
    // The persona/intro stay OFF the summary and land on the detail.
    expect(summary).not.toHaveProperty("persona");

    const detail = personalAgentAvatarDetail(bot);
    expect(detail).toMatchObject({
      id: summary.id,
      persona: "간결하게",
      intro: "안녕하세요",
      isOwn: false,
      // Owner-grade run — the only lever that hides the 읽기 전용 header chip.
      elevated: true,
      plugins: [],
      personalAgent: { agentId: bot.id, defaultModel: "sonnet" },
    });
  });

  it("lists ONLY the viewer's own enabled bots, and nothing for a non-admin", () => {
    const { store } = services("list-summaries");
    const owner = makeUser(store, "owner"); // first account → admin
    const member = makeUser(store, "member");
    store.createPersonalAgent(owner.id, { displayName: "B 봇" });
    store.createPersonalAgent(owner.id, { displayName: "A 봇" });
    store.createPersonalAgent(owner.id, { displayName: "숨은 봇", enabled: false });
    store.createPersonalAgent(member.id, { displayName: "남의 봇" });

    expect(listPersonalAgentAvatarSummaries(store, owner.id).map((a) => a.displayName)).toEqual([
      "A 봇",
      "B 봇",
    ]);
    // A member's own bot rows exist but the feature gate hides them.
    expect(listPersonalAgentAvatarSummaries(store, member.id)).toEqual([]);
    // Losing admin empties the roster without touching the rows.
    store.setRole(owner.id, "admin", false);
    expect(listPersonalAgentAvatarSummaries(store, owner.id)).toEqual([]);
    expect(store.countPersonalAgents(owner.id)).toBe(3);
  });

  it("keys the workspace parent on the composite avatar id, not on a conversation", () => {
    const { store, config } = services("workspace");
    const owner = makeUser(store, "owner");
    const bot = store.createPersonalAgent(owner.id, { displayName: "봇" });
    const avatarId = personalAgentAvatarId(owner.id, bot.id);

    const parent = personalAgentWorkspaceParent(config, bot);
    expect(path.dirname(workspaceDirFor(config, avatarId, "conv-1"))).toBe(parent);
    expect(path.dirname(workspaceDirFor(config, avatarId, "conv-2"))).toBe(parent);
    // A different bot of the same owner gets its own tree.
    const other = store.createPersonalAgent(owner.id, { displayName: "다른 봇" });
    expect(personalAgentWorkspaceParent(config, other)).not.toBe(parent);
  });
});
