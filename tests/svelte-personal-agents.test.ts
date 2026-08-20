// 내 봇 (personal agents) — the CLIENT half. What is pinned here is the four
// places a bot differs from every other avatar in the UI: it wears its own badge
// and sorts right under my own avatar in 탐색 (and its card opens 봇 오피스, not a
// chat pane), the rail reaches it through the 봇 오피스 nav entry alone — with an
// unseen-work badge and NO 내 봇 section of its own — it is managed through
// /api/me/agents from 설정 ▸ 내 봇, and a new thread with it starts on the bot's
// OWN model tier instead of my remembered default.
// 봇 오피스's own screen is tests/svelte-bots-view.test.ts.
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Shell from "../src/client/src/components/Shell.svelte";
import SettingsPersonalAgentsCard from "../src/client/src/components/SettingsPersonalAgentsCard.svelte";
import ExploreView from "../src/client/src/views/ExploreView.svelte";
import SettingsView from "../src/client/src/views/SettingsView.svelte";
import { startChatWith } from "../src/client/src/lib/chat.js";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm.js";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import type {
  AvatarDetail,
  AvatarSummary,
  BootstrapInfo,
  PersonalAgent,
  User,
} from "../src/client/src/lib/types.js";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const OWNER_ID = "owner-1";
const BOT_AVATAR_ID = `personal:${OWNER_ID}:bot-1`;

function userOf(over: Partial<User> = {}): User {
  return {
    id: OWNER_ID,
    username: "owner",
    displayName: "나",
    alias: "",
    bio: "",
    persona: "",
    intro: "",
    hashtags: [],
    hasImage: false,
    visibility: "group",
    roles: ["admin"],
    pluginCount: 0,
    gitTokenSet: false,
    gitIdentityName: null,
    gitIdentityEmail: null,
    knowledgeRepo: null,
    knowledgeBranch: null,
    knowledgeSelected: null,
    groupKnowledgeOffDefault: [],
    modelDefault: null,
    effortDefault: null,
    mcpToolGroupsDefault: null,
    allowedMcpToolGroups: null,
    secretNames: [],
    shellExposedSecretNames: [],
    sshPublicKey: null,
    groups: [],
    experimentalFeatures: [],
    sharedAccount: false,
    onboardedAt: "2026-08-01T00:00:00.000Z",
    lastSeenRelease: null,
    ...over,
  } as unknown as User;
}

function bootstrapOf(tierIds: string[], locked = false): BootstrapInfo {
  return {
    needsSetup: false,
    githubHost: "github.com",
    signupMode: "closed",
    confluenceConfigured: false,
    modelSelection: {
      tiers: tierIds.map((id) => ({
        id,
        label: id.charAt(0).toUpperCase() + id.slice(1),
        description: "",
        model: null,
      })),
      locked,
    },
  };
}

/** The shape the server tags onto the owner's own bots in GET /api/avatars. */
function botSummary(over: Partial<AvatarSummary> = {}): AvatarSummary {
  return {
    id: BOT_AVATAR_ID,
    username: "personal-agent-bot-1",
    displayName: "코드리뷰 봇",
    alias: "리뷰어",
    bio: "PR을 먼저 읽어 둡니다",
    hashtags: [],
    hasImage: false,
    pluginCount: 0,
    visibility: "group",
    updatedAt: null,
    runtime: "native",
    personalAgent: { agentId: "bot-1", defaultModel: null },
    ...over,
  };
}

function plainSummary(over: Partial<AvatarSummary> = {}): AvatarSummary {
  return {
    id: "mate-1",
    username: "mate",
    displayName: "동료",
    alias: "",
    bio: "",
    hashtags: [],
    hasImage: false,
    pluginCount: 0,
    visibility: "group",
    updatedAt: null,
    runtime: "native",
    sharesGroup: true,
    ...over,
  };
}

function detailOf(summary: AvatarSummary): AvatarDetail {
  return { ...summary, persona: "", intro: "", isOwn: false, elevated: true, plugins: [] };
}

const BOT_ROW: PersonalAgent = {
  id: "bot-1",
  ownerUserId: OWNER_ID,
  displayName: "코드리뷰 봇",
  alias: "리뷰어",
  bio: "PR을 먼저 읽어 둡니다",
  intro: "",
  persona: "",
  hashtags: [],
  hasImage: false,
  enabled: true,
  defaultModel: "sonnet",
  // Per-bot memory + skill allowlist: insert-only folder name, and a grant list
  // that starts EMPTY (a bot loads no knowledge-repo skills until granted).
  memoryDir: "bot-1",
  selectedSkills: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

interface Call {
  url: string;
  method: string;
  body?: string;
}

// A configurable fake <img>: jsdom neither decodes images nor paints a 2D
// context, so setting src schedules the load callback on a microtask (same shape
// tests/client-dom.test.ts uses for the real downscale unit tests).
class FakeImage {
  onload: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  width = 64;
  height = 64;
  private _src = "";
  set src(value: string) {
    this._src = value;
    queueMicrotask(() => this.onload?.());
  }
  get src(): string {
    return this._src;
  }
}

/** Wait until an async row action has released its busy lock. */
async function enabled(name: string): Promise<HTMLButtonElement> {
  await waitFor(() => {
    const button = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/** Records every request; `routes` answers by URL substring. */
function stubFetch(routes: (url: string, method: string) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body as string | undefined });
      return { ok: true, status: 200, json: async () => routes(url, method) ?? {} } as Response;
    }),
  );
  return calls;
}

function setDesktopViewport(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      media: "(min-width: 861px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })) as unknown as typeof window.matchMedia,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  replaceState({
    user: userOf(),
    bootstrap: bootstrapOf(["opus", "sonnet", "haiku"]),
    avatars: [],
    // Pretend the list is already loaded: every surface here reads it from state,
    // and loadAvatars() must not refetch behind the assertions.
    avatarsLoaded: true,
    avatarsLoading: false,
    conversations: [],
    chatPanes: [],
    activePaneId: null,
    settingsTab: "profile",
    view: "explore",
    botsAgentId: "",
    // The store is a singleton across this file — a seeded badge must not leak
    // into the next test.
    botTaskUnseen: { total: 0, agents: {} },
  });
  history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* 탐색 — badge + ordering                                             */
/* ------------------------------------------------------------------ */

describe("ExploreView 내 봇", () => {
  it("badges a bot and sorts it between my own avatar and same-group avatars", async () => {
    // The 시작하기 card is dismissed for this session so only the cards render.
    sessionStorage.setItem("setupBannerDismissed", "1");
    stubFetch(() => ({ avatars: [], conversations: [], repoConfigured: false, skills: [] }));
    const me = plainSummary({ id: OWNER_ID, username: "owner", displayName: "나", sharesGroup: false });
    replaceState({ avatars: [plainSummary(), botSummary(), me] });

    const { container } = render(ExploreView);
    await waitFor(() => expect(container.querySelectorAll(".avatar-card").length).toBe(3));

    expect([...container.querySelectorAll(".ac-name strong")].map((el) => el.textContent)).toEqual([
      "나",
      "코드리뷰 봇",
      "동료",
    ]);
    const badges = [...container.querySelectorAll(".avatar-card")].map(
      (card) => card.querySelector(".ac-name .tag")?.textContent,
    );
    expect(badges).toEqual(["나", "내 봇", "같은 그룹"]);
  });

  it("keeps the group hint for an owner whose only other avatars are bots", async () => {
    sessionStorage.setItem("setupBannerDismissed", "1");
    stubFetch(() => ({ avatars: [], conversations: [], repoConfigured: false, skills: [] }));
    replaceState({ avatars: [plainSummary({ id: OWNER_ID, displayName: "나", sharesGroup: false }), botSummary()] });

    const { container } = render(ExploreView);
    await waitFor(() => expect(container.querySelectorAll(".avatar-card").length).toBe(2));
    // A bot is reachable by me alone, so it is not a peer avatar.
    expect(container.textContent).toContain("그룹에 소속되면 동료의 아바타가 여기에 보여요.");
  });
});

/* ------------------------------------------------------------------ */
/* 탐색 — a bot card opens 봇 오피스, not a chat pane                    */
/* ------------------------------------------------------------------ */

describe("ExploreView 내 봇 카드 라우팅", () => {
  /** Serve the background loads every ExploreView mount makes. */
  function stubExplore(extra: (url: string) => unknown = () => undefined): Call[] {
    sessionStorage.setItem("setupBannerDismissed", "1");
    return stubFetch((url) => extra(url) ?? { avatars: [], conversations: [], repoConfigured: false, skills: [] });
  }

  it("lands in 봇 오피스 with that bot selected, opening no chat pane", async () => {
    const calls = stubExplore();
    replaceState({ avatars: [botSummary()] });

    const { container } = render(ExploreView);
    await waitFor(() => expect(container.querySelectorAll(".avatar-card").length).toBe(1));

    // The card names where it actually goes — a bot card no longer promises a
    // chat pane it does not open.
    await fireEvent.click(screen.getByRole("button", { name: "리뷰어 봇 오피스에서 열기" }));

    expect(readState().view).toBe("bots");
    expect(readState().botsAgentId).toBe("bot-1");
    // 봇 오피스 opens the thread itself, so 탐색 neither makes a pane nor pulls
    // the avatar detail.
    expect(readState().chatPanes).toHaveLength(0);
    expect(calls.some((call) => call.url.includes("/api/avatars/"))).toBe(false);
    expect(location.hash).toBe("#/bots/bot-1");
  });

  it("leaves a non-bot card on its chat-pane path", async () => {
    stubExplore((url) => (url.includes("/api/avatars/") ? { avatar: detailOf(plainSummary()) } : undefined));
    replaceState({ avatars: [plainSummary()] });

    render(ExploreView);
    await fireEvent.click(await screen.findByRole("button", { name: "동료 아바타와 대화" }));

    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    expect(readState().view).toBe("chat");
    expect(readState().botsAgentId).toBe("");
  });

  it("falls back to a chat pane when 봇 오피스 is closed to the viewer", async () => {
    stubExplore((url) => (url.includes("/api/avatars/") ? { avatar: detailOf(botSummary()) } : undefined));
    // Phase 1 never tags a bot for a non-admin, so this is the gate-widens case:
    // goView is the ONLY access check, and a refused view must not eat the click.
    replaceState({ user: userOf({ roles: [] }), avatars: [botSummary()] });

    render(ExploreView);
    await fireEvent.click(await screen.findByRole("button", { name: /봇 오피스에서 열기/ }));

    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    expect(readState().chatPanes[0].avatar.id).toBe(BOT_AVATAR_ID);
    expect(readState().view).toBe("chat");
  });
});

/* ------------------------------------------------------------------ */
/* rail — 봇 오피스 nav entry + unseen badge                            */
/* ------------------------------------------------------------------ */

describe("Shell 봇 오피스 nav entry", () => {
  beforeEach(setDesktopViewport);

  /** The visible digits of the bots nav badge, or null when there is none. */
  function badgeText(): string | null {
    const entry = screen.getByRole("button", { name: /봇 오피스/ });
    return entry.querySelector('.nav-badge [aria-hidden="true"]')?.textContent ?? null;
  }

  it("badges the entry with unseen bot work, and keeps no 내 봇 section of its own", async () => {
    stubFetch(() => ({ conversations: [] }));
    // Bots in state used to paint a rail list; 봇 오피스 is the single entry point now.
    replaceState({ avatars: [botSummary(), plainSummary()], botTaskUnseen: { total: 3, agents: { "bot-1": 3 } } });

    render(Shell, { props: { user: userOf(), view: "explore" } });

    expect(badgeText()).toBe("3");
    // The bare number does not say what it counts, so the row spells it out.
    expect(screen.getByRole("button", { name: /봇 오피스/ }).textContent).toContain(
      "확인하지 않은 봇 작업 결과 3건",
    );
    expect(screen.queryByRole("group", { name: "내 봇 목록" })).toBeNull();
    expect(screen.queryByRole("button", { name: /첫 봇 만들기/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /봇과 대화/ })).toBeNull();
  });

  it("caps the count at 99+ and shows no badge at zero", async () => {
    stubFetch(() => ({ conversations: [] }));
    replaceState({ botTaskUnseen: { total: 128, agents: {} } });
    const many = render(Shell, { props: { user: userOf(), view: "explore" } });
    expect(badgeText()).toBe("99+");
    many.unmount();

    replaceState({ botTaskUnseen: { total: 0, agents: {} } });
    render(Shell, { props: { user: userOf(), view: "explore" } });
    expect(badgeText()).toBeNull();
  });

  it("follows a later store write instead of freezing at mount", async () => {
    stubFetch(() => ({ conversations: [] }));
    render(Shell, { props: { user: userOf(), view: "explore" } });
    expect(badgeText()).toBeNull();

    // The badge is fed by a background poll, so it has to move without a remount.
    replaceState({ botTaskUnseen: { total: 5, agents: { "bot-1": 5 } } });
    await tick();
    expect(badgeText()).toBe("5");
  });

  it("hides 봇 오피스 from a non-admin even with unseen work in state", async () => {
    stubFetch(() => ({ conversations: [] }));
    replaceState({ avatars: [botSummary()], botTaskUnseen: { total: 2, agents: { "bot-1": 2 } } });

    render(Shell, { props: { user: userOf({ roles: [] }), view: "explore" } });

    expect(screen.queryByRole("button", { name: /봇 오피스/ })).toBeNull();
    expect(screen.queryByText("내 봇")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 설정 ▸ 내 봇 — management card                                        */
/* ------------------------------------------------------------------ */

describe("SettingsPersonalAgentsCard", () => {
  interface SkillCatalog {
    repoConfigured: boolean;
    skills: { slug: string; intro: string }[];
  }

  /** Serve the listing + the grantable-skill catalog; mutations answer ok. */
  function mockAgents(rows: PersonalAgent[] = [BOT_ROW], catalog?: SkillCatalog): Call[] {
    return stubFetch((url) => {
      // Matched FIRST: the literal path is a substring of the listing path.
      if (url.includes("/api/me/agents/skill-catalog")) return catalog ?? { repoConfigured: false, skills: [] };
      if (url.includes("/api/me/agents")) return { agents: rows, agent: rows[0], ok: true };
      return { avatars: [], conversations: [] };
    });
  }

  const catalogReads = (calls: Call[]): number =>
    calls.filter((call) => call.url.includes("/skill-catalog")).length;

  it("lists the bots it fetched and creates one through POST /api/me/agents", async () => {
    const calls = mockAgents();
    render(SettingsPersonalAgentsCard, { props: { active: true } });

    await screen.findByText("코드리뷰 봇");
    expect(calls[0]).toMatchObject({ url: "/api/me/agents", method: "GET" });
    // The row names the tier the bot starts new conversations on.
    expect(document.body.textContent).toContain("모델: Sonnet");

    await fireEvent.click(screen.getByRole("button", { name: "봇 추가" }));
    await fireEvent.input(screen.getByLabelText("표시 이름"), { target: { value: " 문서 봇 " } });
    // The 기본 모델 label carries a hint sentence, so it is matched loosely.
    await fireEvent.change(screen.getByLabelText(/기본 모델/), { target: { value: "haiku" } });
    await fireEvent.click(screen.getByRole("button", { name: "만들기" }));

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe("/api/me/agents");
    expect(JSON.parse(post.body!)).toEqual({
      displayName: "문서 봇",
      alias: "",
      bio: "",
      intro: "",
      persona: "",
      // A new bot starts with NO skills — the opposite default of the owner's
      // own knowledgeSelected (null = load all).
      selectedSkills: [],
      defaultModel: "haiku",
    });
  });

  it("patches an existing bot, toggles it off, and uploads its photo", async () => {
    const calls = mockAgents();
    render(SettingsPersonalAgentsCard, { props: { active: true } });
    await screen.findByText("코드리뷰 봇");

    await fireEvent.click(await enabled("설정"));
    // The form opens pre-filled from the row, including the stored tier.
    expect((screen.getByLabelText("표시 이름") as HTMLInputElement).value).toBe("코드리뷰 봇");
    expect((screen.getByLabelText(/기본 모델/) as HTMLSelectElement).value).toBe("sonnet");

    await fireEvent.input(screen.getByLabelText("한 줄 소개"), { target: { value: "리뷰 담당" } });
    await fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toBe("/api/me/agents/bot-1");
    expect(JSON.parse(patch.body!)).toMatchObject({ bio: "리뷰 담당", defaultModel: "sonnet" });

    // 비활성화 is the row-level PATCH and keeps history — it is what the delete
    // confirm offers as the alternative.
    await fireEvent.click(await enabled("비활성화"));
    await waitFor(() =>
      expect(calls.filter((call) => call.method === "PATCH").length).toBeGreaterThan(1),
    );
    expect(JSON.parse(calls.filter((call) => call.method === "PATCH").at(-1)!.body!)).toEqual({
      enabled: false,
    });

    // Photo upload rides the same id path + /image (canvas paint is browser-only,
    // so Image + the 2D context are stubbed the way tests/client-dom.test.ts does).
    await fireEvent.click(await enabled("설정"));
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AA");
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await fireEvent.change(fileInput, {
      target: { files: [new File(["x"], "bot.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.url).toBe("/api/me/agents/bot-1/image");
    expect(JSON.parse(put.body!)).toEqual({ image: "data:image/png;base64,AA" });
  });

  it("warns that every conversation goes before deleting, and offers 비활성화 instead", async () => {
    const calls = mockAgents();
    render(SettingsPersonalAgentsCard, { props: { active: true } });
    await screen.findByText("코드리뷰 봇");

    await fireEvent.click(await enabled("삭제"));
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    expect(get(confirmation)?.message).toContain("모든 대화 기록이 함께 삭제되며");
    expect(get(confirmation)?.message).toContain("비활성화");
    // The bot's memory is a folder in the owner's OWN repo, so it is not the
    // bot's to take with it — the confirm has to say what stays behind.
    expect(get(confirmation)?.message).toContain(
      "봇의 기억 폴더(지식 저장소의 agents/bot-1/)는 삭제되지 않고 남습니다.",
    );
    expect(get(confirmation)?.tone).toBe("danger");
    resolveConfirmation(true);

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    expect(calls.find((call) => call.method === "DELETE")!.url).toBe("/api/me/agents/bot-1");
  });

  it("fetches nothing until the tab is actually opened", async () => {
    const calls = mockAgents();
    render(SettingsPersonalAgentsCard, { props: { active: false } });
    await tick();
    expect(calls.length).toBe(0);
    expect(screen.queryByText("내 봇")).toBeNull();
  });

  /* ---- 스킬 grants -------------------------------------------------- */

  /** The picker's checkboxes, in catalog order. */
  function skillBoxes(): HTMLInputElement[] {
    return [...document.querySelectorAll<HTMLInputElement>(".pc-list input[type='checkbox']")];
  }

  it("reflects the bot's grants, names each skill, and saves the WHOLE list back", async () => {
    const calls = mockAgents([{ ...BOT_ROW, selectedSkills: ["release"] }], {
      repoConfigured: true,
      skills: [
        { slug: "release", intro: "릴리즈 절차" },
        { slug: "triage", intro: "이슈 분류" },
      ],
    });
    render(SettingsPersonalAgentsCard, { props: { active: true } });
    await screen.findByText("코드리뷰 봇");

    // The row says how many grants a bot carries without opening the form…
    expect(document.body.textContent).toContain("스킬 1개");
    // …and the catalog costs a repo clone server-side, so nothing reads it until
    // a form actually opens.
    expect(catalogReads(calls)).toBe(0);

    await fireEvent.click(await enabled("설정"));
    await waitFor(() => expect(skillBoxes().length).toBe(2));

    expect(skillBoxes().map((box) => box.checked)).toEqual([true, false]);
    expect(document.body.textContent).toContain("릴리즈 절차");
    expect(document.body.textContent).toContain("변경은 봇의 다음 새 대화부터 적용됩니다.");

    // Revoke one and grant the other: the body carries the full list, not a delta.
    await fireEvent.click(skillBoxes()[0]);
    await fireEvent.click(skillBoxes()[1]);
    await fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toBe("/api/me/agents/bot-1");
    expect(JSON.parse(patch.body!).selectedSkills).toEqual(["triage"]);
  });

  it("reads the catalog once per mount, however many forms open", async () => {
    const calls = mockAgents([BOT_ROW], {
      repoConfigured: true,
      skills: [{ slug: "release", intro: "릴리즈 절차" }],
    });
    render(SettingsPersonalAgentsCard, { props: { active: true } });
    await screen.findByText("코드리뷰 봇");

    await fireEvent.click(await enabled("설정"));
    await waitFor(() => expect(catalogReads(calls)).toBe(1));

    await fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    await fireEvent.click(await enabled("봇 추가"));
    await waitFor(() => expect(skillBoxes().length).toBe(1));
    // A fresh bot starts with nothing checked even though the last form had a
    // grant open, and the catalog is not pulled a second time.
    expect(skillBoxes()[0].checked).toBe(false);
    expect(catalogReads(calls)).toBe(1);
  });

  it("explains an empty picker instead of showing empty controls", async () => {
    const noRepo = mockAgents([BOT_ROW], { repoConfigured: false, skills: [] });
    const first = render(SettingsPersonalAgentsCard, { props: { active: true } });
    await screen.findByText("코드리뷰 봇");
    await fireEvent.click(await enabled("설정"));

    await screen.findByText("지식 저장소를 연결하면 봇에게 내 스킬을 줄 수 있어요.");
    expect(document.querySelector(".pc-list")).toBeNull();
    expect(catalogReads(noRepo)).toBe(1);
    first.unmount();
    vi.unstubAllGlobals();

    // A connected repo with no skills/ tree is a different sentence: the fix is
    // writing a skill, not connecting a repo.
    mockAgents([BOT_ROW], { repoConfigured: true, skills: [] });
    render(SettingsPersonalAgentsCard, { props: { active: true } });
    await screen.findByText("코드리뷰 봇");
    await fireEvent.click(await enabled("설정"));

    await screen.findByText("지식 저장소에 아직 스킬이 없습니다.");
    expect(document.querySelector(".pc-list")).toBeNull();
  });

  it("keeps the stored grants when the picker offers no controls", async () => {
    // The save is a FULL REPLACE, so a picker with nothing in it must not read
    // as "revoke everything": the form is seeded from the ROW, which means an
    // untouched save replaces the stored list with itself.
    const calls = mockAgents([{ ...BOT_ROW, selectedSkills: ["release"] }], {
      repoConfigured: false,
      skills: [],
    });
    render(SettingsPersonalAgentsCard, { props: { active: true } });
    await screen.findByText("코드리뷰 봇");

    await fireEvent.click(await enabled("설정"));
    await waitFor(() => expect(catalogReads(calls)).toBe(1));
    expect(document.querySelector(".pc-list")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((call) => call.method === "PATCH")!.body!).selectedSkills).toEqual(["release"]);
  });
});

/* ------------------------------------------------------------------ */
/* 설정 nav — the 내 봇 tab is admin-only                               */
/* ------------------------------------------------------------------ */

describe("SettingsView 내 봇 tab", () => {
  /** loadSettingsData() re-reads /api/me, so the role has to come from there. */
  function mockSettings(roles: string[]): Call[] {
    return stubFetch((url) => {
      if (url === "/api/me") return { user: userOf({ roles }) };
      if (url.includes("/api/me/plugins")) return { plugins: [] };
      if (url.includes("/api/me/knowledge/requests")) return { requests: [] };
      if (url.includes("/api/me/agents")) return { agents: [BOT_ROW] };
      return { avatars: [], conversations: [] };
    });
  }

  it("offers the tab to an admin and mounts the card on it", async () => {
    mockSettings(["admin"]);
    replaceState({ settingsTab: "agents" });
    render(SettingsView);

    await screen.findByRole("tab", { name: "내 봇" });
    // Landing on the tab loads the roster into the card.
    await screen.findByText("코드리뷰 봇");
    expect(readState().settingsTab).toBe("agents");
  });

  it("hides the tab from a non-admin and never mounts the card", async () => {
    const calls = mockSettings([]);
    // A bookmarked #/settings/agents must not leave every tab unselected.
    replaceState({ settingsTab: "agents" });
    render(SettingsView);

    await screen.findByRole("tab", { name: "프로필" });
    expect(screen.queryByRole("tab", { name: "내 봇" })).toBeNull();
    await waitFor(() => expect(readState().settingsTab).toBe("profile"));
    expect(calls.some((call) => call.url.includes("/api/me/agents"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* makePane — the bot's own model tier seeds a NEW conversation         */
/* ------------------------------------------------------------------ */

describe("chat.makePane model seeding", () => {
  /** Open a fresh pane with `summary` and report the tier it was seeded with. */
  async function seededTier(summary: AvatarSummary): Promise<string | undefined> {
    stubFetch((url) => {
      if (url.includes("/api/avatars/")) return { avatar: detailOf(summary) };
      return { conversations: [] };
    });
    await startChatWith(summary);
    return readState().chatPanes[0]?.modelTier;
  }

  beforeEach(() => {
    replaceState({ user: userOf({ modelDefault: "haiku" }) });
  });

  it("prefers the bot's default tier over my remembered default", async () => {
    expect(await seededTier(botSummary({ personalAgent: { agentId: "bot-1", defaultModel: "sonnet" } }))).toBe(
      "sonnet",
    );
  });

  it("falls back to my default when the bot has none or names an unknown tier", async () => {
    expect(await seededTier(botSummary())).toBe("haiku");
    replaceState({ chatPanes: [], activePaneId: null, conversations: [] });
    expect(
      await seededTier(botSummary({ personalAgent: { agentId: "bot-1", defaultModel: "retired-tier" } })),
    ).toBe("haiku");
  });

  it("leaves a plain avatar's seeding untouched", async () => {
    expect(await seededTier(plainSummary())).toBe("haiku");
  });
});

