import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SkillsView from "../src/client/src/views/SkillsView.svelte";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import type { User } from "../src/client/src/lib/types.js";

const user = {
  id: "owner-1",
  username: "owner",
  displayName: "Owner",
  alias: "",
  bio: "",
  persona: "",
  intro: "",
  hashtags: [],
  hasImage: false,
  visibility: "group",
  roles: [],
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
  onboardedAt: null,
  lastSeenRelease: null,
} satisfies User;

const LISTING = {
  id: "share-1",
  ownerUserId: "mate-1",
  skillName: "pptx-report",
  displayName: "Deck maker",
  description: "Weekly report deck generator",
  learnCount: 2,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  owner: {
    id: "mate-1",
    username: "mate",
    displayName: "Mate",
    alias: "",
    hasImage: false,
  },
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function mockFetch(routes: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return jsonResponse(body);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  replaceState({ user, view: "skills", settingsTab: "profile" });
  vi.restoreAllMocks();
});

describe("SkillsView", () => {
  it("lists learnable skills with owner attribution and my shareable skills", async () => {
    mockFetch({
      "/api/skill-share/available": { skills: [LISTING] },
      "/api/skill-share/mine": {
        repoConfigured: true,
        skills: [
          { slug: "my-skill", name: "my-skill", description: "mine", shared: true, learnCount: 3 },
        ],
      },
    });
    render(SkillsView);

    await waitFor(() => {
      expect(screen.getByText("Deck maker")).toBeTruthy();
    });
    expect(screen.getByText("@mate")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deck maker 스킬 전수받기" })).toBeTruthy();
    // Adoption badges (전수된 횟수) on both the learnable card and my own row.
    expect(screen.getByText("전수 2회")).toBeTruthy();
    expect(screen.getByText("전수 3회")).toBeTruthy();
    // My section: the shared toggle reflects server state.
    expect(screen.getByRole("switch", { name: "my-skill 공유" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("guides to knowledge settings when no repo is connected", async () => {
    mockFetch({
      "/api/skill-share/available": { skills: [] },
      "/api/skill-share/mine": { repoConfigured: false, skills: [] },
    });
    render(SkillsView);

    const cta = await screen.findByRole("button", { name: "지식 저장소 연결하기" });
    await fireEvent.click(cta);
    expect(readState().view).toBe("settings");
    expect(readState().settingsTab).toBe("knowledge");
  });

  it("filters the learnable list by the search query", async () => {
    mockFetch({
      "/api/skill-share/available": {
        skills: [
          LISTING,
          {
            ...LISTING,
            id: "share-2",
            skillName: "code-review",
            displayName: "code-review",
            description: "Review checklists",
          },
        ],
      },
      "/api/skill-share/mine": { repoConfigured: true, skills: [] },
    });
    render(SkillsView);
    await waitFor(() => {
      expect(screen.getByText("code-review")).toBeTruthy();
    });

    const search = screen.getByRole("searchbox", { name: "공유된 스킬 검색" });
    await fireEvent.input(search, { target: { value: "deck" } });
    expect(screen.queryByText("code-review")).toBeNull();
    expect(screen.getByText("Deck maker")).toBeTruthy();
  });
});
