import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createServices } from "../src/server/app.js";
import { ensureClone, knowledgeRepoContextFor } from "../src/server/knowledgeRepo.js";
import {
  normalizeScopedPath,
  normalizeWikiPath,
  rankBrainNotes,
} from "../src/server/agent/brainSearch.js";
import { buildBrainTools } from "../src/server/agent/brainTools.js";
import { buildRepoTools } from "../src/server/agent/repoTools.js";
import { isBrainNotePath } from "../src/server/agent/repoToolKit.js";
import { callTool, makeBareRemote, withTempDir } from "./helpers.js";

// Coverage target: per-bot MEMORY SCOPING — a personal agent's memory lives in
// `agents/<dir>/` inside the OWNER's single knowledge repo, and a bot run is a
// full owner run, so the scope is the only thing keeping it out of the owner's
// vault/skills. Exercised at the mechanism layer (a statically injected scope):
//  - brainSearch.ts   scope guards + subtree ranking
//  - brainTools.ts     scoped recall text (no brain-migrate, no create_repo)
//  - repoTools.ts      every path-taking op, scaffold/create refusals, commit
//  - repoGitCore.ts    pathspec-scoped staging
// …and at the wiring layer, where the run has to actually PRODUCE that scope:
//  - runPlan.ts        scoped repo/brain servers (+ an unscoped owner control)
//  - plugins.ts        the granted-skill allowlist + subtree standing memory
//  - preToolUseHook.ts the native-write integrity guard
//
// The reconcile hook must NOT run for a scoped commit (a bot never touches
// `skills/`), so the real implementation is wrapped in a spy — everything else
// about skillTransfer stays real. The three tool-server factories below are
// wrapped the same way: the run plan's job is to pass the scope, so the spies
// record the context it built while the real servers are still constructed.
vi.mock("../src/server/skillTransfer.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/server/skillTransfer.js")>();
  return { ...actual, reconcileOwnerSharedSkills: vi.fn(actual.reconcileOwnerSharedSkills) };
});
vi.mock("../src/server/agent/brainTools.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/server/agent/brainTools.js")>();
  return { ...actual, buildBrainServer: vi.fn(actual.buildBrainServer) };
});
vi.mock("../src/server/agent/repoTools.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/server/agent/repoTools.js")>();
  return { ...actual, buildRepoServer: vi.fn(actual.buildRepoServer) };
});
vi.mock("../src/server/agent/personalAgentProfileTools.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../src/server/agent/personalAgentProfileTools.js")
  >();
  return {
    ...actual,
    buildPersonalAgentSelfServer: vi.fn(actual.buildPersonalAgentSelfServer),
  };
});
import { reconcileOwnerSharedSkills } from "../src/server/skillTransfer.js";
import { buildBrainServer } from "../src/server/agent/brainTools.js";
import { buildRepoServer } from "../src/server/agent/repoTools.js";
import { buildPersonalAgentSelfServer } from "../src/server/agent/personalAgentProfileTools.js";
import { buildAgentRunPlan } from "../src/server/agent/runPlan.js";
import { buildPreToolUseHook } from "../src/server/agent/preToolUseHook.js";
import {
  loadAgentPluginRoots,
  loadKnowledgeRepoMemory,
} from "../src/server/plugins.js";
import {
  personalAgentMemoryDirName,
  personalAgentMemoryRoot,
} from "../src/server/personalAgents.js";
import { knowledgeClonePath } from "../src/server/knowledgeRepo.js";
import type { AgentRequest } from "../src/server/types.js";

let tempDir: string;
const getTempDir = withTempDir("bot-memory", () => {
  tempDir = getTempDir();
});

/** The memory namespace of one bot — what the integration pass will inject. */
const ROOT = "agents/bot-a1b2c3d4";
const BOT = "리서치봇";

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Seed a bare remote on `main` with the given repo-relative files. */
function seedRemote(name: string, files: Record<string, string>): string {
  const remote = makeBareRemote(path.join(tempDir, `${name}.git`));
  const seed = path.join(tempDir, `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "seed@example.com");
  g("config", "user.name", "Seed");
  g("config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries(files)) {
    write(seed, rel, content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("branch", "-M", "main");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  return remote;
}

function bootstrap(dir: string) {
  const { store, config } = createServices({
    dataDir: path.join(tempDir, dir),
    agentRuntime: "local",
    sessionSecret: "t",
  });
  const owner = store.createUser({
    username: "owner",
    displayName: "Owner",
    password: "password123",
  });
  return { store, config, owner };
}

/** Connect a seeded remote as the owner's knowledge repo and clone it. */
async function connectRepo(
  s: ReturnType<typeof bootstrap>,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  s.store.setKnowledgeRepo(s.owner.id, seedRemote(name, files), "main");
  s.store.setGitToken(s.owner.id, "tok"); // commit gate; a file remote ignores it
  return ensureClone(knowledgeRepoContextFor(s.store, s.owner.id, s.config)!);
}

const gitOut = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();

// ---------------------------------------------------------------------------
// brainSearch.ts — the shared scope guards
// ---------------------------------------------------------------------------

describe("scope guards (normalizeWikiPath / normalizeScopedPath / isBrainNotePath)", () => {
  it("keeps the unscoped wiki guard unchanged", () => {
    expect(normalizeWikiPath("wiki")).toEqual({ ok: true, norm: "wiki" });
    expect(normalizeWikiPath("/wiki/concepts/deploy.md")).toEqual({
      ok: true,
      norm: "wiki/concepts/deploy.md",
    });
    expect(normalizeWikiPath("wiki/foo.md", {})).toEqual({ ok: true, norm: "wiki/foo.md" });
    expect(normalizeWikiPath("raw/x")).toEqual({ ok: false });
    expect(normalizeWikiPath("wiki/../CLAUDE.md")).toEqual({ ok: false });
  });

  it("moves the vault under a bot root, and the owner's vault falls outside it", () => {
    const opts = { root: ROOT };
    expect(normalizeWikiPath(`${ROOT}/wiki`, opts)).toEqual({ ok: true, norm: `${ROOT}/wiki` });
    expect(normalizeWikiPath(`/${ROOT}/wiki/concepts/a.md`, opts)).toEqual({
      ok: true,
      norm: `${ROOT}/wiki/concepts/a.md`,
    });
    // The OWNER's own vault, the bot's raw inbox, and a sibling bot are all out.
    expect(normalizeWikiPath("wiki/concepts/a.md", opts)).toEqual({ ok: false });
    expect(normalizeWikiPath(`${ROOT}/raw/a.md`, opts)).toEqual({ ok: false });
    expect(normalizeWikiPath(`${ROOT}/wiki/../../bot-other/wiki/a.md`, opts)).toEqual({ ok: false });
    // Traversal all the way out of the namespace.
    expect(normalizeWikiPath(`${ROOT}/wiki/../../../CLAUDE.md`, opts)).toEqual({ ok: false });
  });

  it("normalizeScopedPath admits the root itself and refuses look-alikes", () => {
    expect(normalizeScopedPath(ROOT, ROOT)).toEqual({ ok: true, norm: ROOT });
    expect(normalizeScopedPath(`./${ROOT}/raw/2026-08-20.md`, ROOT)).toEqual({
      ok: true,
      norm: `${ROOT}/raw/2026-08-20.md`,
    });
    // A sibling whose name merely STARTS with the root is not under it.
    expect(normalizeScopedPath(`${ROOT}-evil/wiki/a.md`, ROOT)).toEqual({ ok: false });
    expect(normalizeScopedPath("skills/foo/SKILL.md", ROOT)).toEqual({ ok: false });
    expect(normalizeScopedPath("/etc/passwd", ROOT)).toEqual({ ok: false });
    expect(normalizeScopedPath("agents", ROOT)).toEqual({ ok: false });
  });

  it("fails CLOSED on a broken scope root instead of widening back to the repo", () => {
    for (const root of ["", "/", ".", "..", "../escape", "agents/../..", "agents//x"]) {
      expect(normalizeScopedPath("wiki/a.md", root)).toEqual({ ok: false });
      expect(normalizeWikiPath("wiki/a.md", { root })).toEqual({ ok: false });
    }
  });

  it("isBrainNotePath follows the scope root, unchanged without one", () => {
    expect(isBrainNotePath("wiki/a.md")).toBe(true);
    expect(isBrainNotePath("./wiki/a.md")).toBe(true);
    expect(isBrainNotePath("raw/a.md")).toBe(false);
    expect(isBrainNotePath(`${ROOT}/wiki/a.md`)).toBe(false);
    expect(isBrainNotePath(`${ROOT}/wiki/a.md`, ROOT)).toBe(true);
    expect(isBrainNotePath(`${ROOT}/raw/a.md`, ROOT)).toBe(false);
    // The owner's vault never counts as the bot's memory.
    expect(isBrainNotePath("wiki/a.md", ROOT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// brainSearch.ts — subtree ranking
// ---------------------------------------------------------------------------

describe("rankBrainNotes scoped to a bot's memory", () => {
  it("ranks only the bot's own notes, and a root search never surfaces them", async () => {
    const dir = path.join(tempDir, "vaults");
    write(dir, "wiki/concepts/deploy.md", "---\ntitle: Owner deploy runbook\n---\nowner steps");
    write(dir, `${ROOT}/wiki/concepts/deploy.md`, "---\ntitle: Bot deploy notes\n---\nbot steps");
    write(dir, `${ROOT}/wiki/entities/alice.md`, "---\ntitle: Alice\n---\nmentioned deploy once");
    // The vault furniture is excluded relative to the SCOPED root.
    write(dir, `${ROOT}/wiki/index.md`, "# Index\ndeploy deploy");
    write(dir, `${ROOT}/wiki/log.md`, "deploy deploy");
    write(dir, `${ROOT}/wiki/_template.md`, "---\ntitle: deploy deploy\n---\n");

    const scoped = await rankBrainNotes(dir, "deploy", undefined, { root: ROOT });
    expect(scoped.kind).toBe("ok");
    if (scoped.kind !== "ok") return;
    // Full repo-relative paths, title hit first, nothing from the owner's vault.
    expect(scoped.hits.map((h) => h.path)).toEqual([
      `${ROOT}/wiki/concepts/deploy.md`,
      `${ROOT}/wiki/entities/alice.md`,
    ]);

    const root = await rankBrainNotes(dir, "deploy");
    expect(root.kind).toBe("ok");
    if (root.kind !== "ok") return;
    expect(root.hits.map((h) => h.path)).toEqual(["wiki/concepts/deploy.md"]);
  });

  it("separates a bot with no vault from a bot whose vault is merely empty", async () => {
    const dir = path.join(tempDir, "vault-states");
    // The OWNER has a vault; the bot has nothing yet → no_vault for the bot.
    write(dir, "wiki/concepts/a.md", "---\ntitle: A\n---\nq");
    expect((await rankBrainNotes(dir, "q", undefined, { root: ROOT })).kind).toBe("no_vault");
    // A raw capture alone is a live (if unconsolidated) vault → ok, no hits.
    write(dir, `${ROOT}/raw/2026-08-20.md`, "q");
    expect(await rankBrainNotes(dir, "q", undefined, { root: ROOT })).toEqual({
      kind: "ok",
      hits: [],
    });
  });

  it("reports no_vault (never the owner's vault) for a broken scope root", async () => {
    const dir = path.join(tempDir, "vault-broken");
    write(dir, "wiki/concepts/a.md", "---\ntitle: A\n---\nq");
    expect((await rankBrainNotes(dir, "q", undefined, { root: "../escape" })).kind).toBe("no_vault");
  });
});

// ---------------------------------------------------------------------------
// brainTools.ts — scoped recall
// ---------------------------------------------------------------------------

describe("scoped brain tools (a bot's own memory)", () => {
  const tools = (s: ReturnType<typeof bootstrap>, scope?: { root: string; botName: string }) =>
    buildBrainTools(s.store, {
      avatarUserId: s.owner.id,
      viewerIsOwner: true,
      elevated: true,
      config: s.config,
      scope,
    });

  it("describes the tools as the bot's OWN memory, separate from the owner's brain", () => {
    const s = bootstrap("brain-desc");
    const scoped = tools(s, { root: ROOT, botName: BOT });
    const search = scoped.find((t) => t.name === "search");
    expect(search?.description).toContain(`${ROOT}/wiki/`);
    expect(search?.description).toContain(BOT);
    expect(search?.description).toContain("SEPARATE from the owner's own second brain");
    // The action trigger survives — a bot must still search before answering.
    expect(search?.description).toContain("**Call this BEFORE answering");
    const getNote = scoped.find((t) => t.name === "get_note");
    expect(getNote?.description).toContain(`${ROOT}/wiki/`);

    // Unscoped wording is untouched.
    const plain = tools(s).find((t) => t.name === "search");
    expect(plain?.description).toContain("Search your SECOND BRAIN");
    expect(plain?.description).not.toContain(ROOT);
  });

  it("points a repo-less bot at the OWNER's main avatar chat, not create_repo", async () => {
    const s = bootstrap("brain-norepo");
    const res = await callTool(tools(s, { root: ROOT, botName: BOT }), "search", { query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("MAIN avatar chat");
    expect(res.content[0].text).toContain("`create_repo` is not available in a bot chat");

    // The owner's own avatar still gets the create_repo redirect.
    const owner = await callTool(tools(s), "search", { query: "q" });
    expect(owner.content[0].text).toContain("mcp__repo__create_repo");
  });

  it("treats an empty memory as normal (no brain-migrate, not an error)", async () => {
    const s = bootstrap("brain-empty");
    await connectRepo(s, "brain-empty", { "CLAUDE.md": "owner", "wiki/index.md": "# Index" });
    const res = await callTool(tools(s, { root: ROOT, botName: BOT }), "search", { query: "q" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).not.toContain("brain-migrate");
    expect(res.content[0].text).toContain(`${ROOT}/wiki/`);
    expect(res.content[0].text).toContain("mcp__repo__commit");

    // The owner's own repo DOES have a root vault, so the owner sees hits/empty
    // — the brain-migrate wording is reserved for a repo that predates it.
    const rootless = bootstrap("brain-legacy");
    await connectRepo(rootless, "brain-legacy", { "CLAUDE.md": "old stub" });
    const legacy = await callTool(tools(rootless), "search", { query: "q" });
    expect(legacy.isError).toBe(true);
    expect(legacy.content[0].text).toContain("brain-migrate");
  });

  it("searches and reads only inside the bot's vault", async () => {
    const s = bootstrap("brain-scoped");
    await connectRepo(s, "brain-scoped", {
      "wiki/concepts/deploy.md": "---\ntitle: Owner deploy\n---\nowner only",
      [`${ROOT}/wiki/concepts/deploy.md`]: "---\ntitle: Bot deploy\n---\nbot only",
    });
    const scoped = tools(s, { root: ROOT, botName: BOT });

    const hits = await callTool(scoped, "search", { query: "deploy" });
    expect(hits.isError).toBeFalsy();
    expect(hits.content[0].text).toContain(`${ROOT}/wiki/concepts/deploy.md`);
    expect(hits.content[0].text).toContain("from your memory");
    expect(hits.content[0].text).not.toContain("Owner deploy");

    const note = await callTool(scoped, "get_note", { path: `${ROOT}/wiki/concepts/deploy.md` });
    expect(note.isError).toBeFalsy();
    expect(note.content[0].text).toContain("bot only");

    // The owner's note is a valid wiki path — but not the bot's.
    const refused = await callTool(scoped, "get_note", { path: "wiki/concepts/deploy.md" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain(`only reads notes under \`${ROOT}/wiki/\``);
    const escape = await callTool(scoped, "get_note", { path: `${ROOT}/wiki/../../CLAUDE.md` });
    expect(escape.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// repoTools.ts — path-scoped file ops
// ---------------------------------------------------------------------------

describe("scoped repo tools (path confinement)", () => {
  const REFUSAL = `This bot's repository access is scoped to its own memory folder \`${ROOT}/\` (wiki/ and raw/ inside it). Adjust the path to live under that folder.`;

  function toolsFor(
    s: ReturnType<typeof bootstrap>,
    pathScope?: { root: string; botName: string },
    onMemory?: (e: { action: "add" | "update"; path: string }) => void,
  ) {
    return buildRepoTools(
      s.store,
      {
        avatarUserId: s.owner.id,
        owner: { id: s.owner.id, username: "owner", displayName: "Owner" },
        viewerIsOwner: true,
        config: s.config,
        pathScope,
        onMemory,
      },
      { allowCreate: true },
    );
  }

  async function scopedSetup(dir: string) {
    const s = bootstrap(dir);
    const root = await connectRepo(s, dir, {
      "CLAUDE.md": "owner root guidance",
      "wiki/concepts/owner.md": "owner note",
      "skills/deploy/SKILL.md": "---\nname: deploy\n---\n",
      [`${ROOT}/wiki/concepts/bot.md`]: "bot note",
    });
    return { s, root };
  }

  it("writes, reads, edits and moves inside the memory folder", async () => {
    const { s, root } = await scopedSetup("scoped-inside");
    const seen: { action: string; path: string }[] = [];
    const tools = toolsFor(s, { root: ROOT, botName: BOT }, (e) => seen.push(e));

    const wrote = await callTool(tools, "write_file", {
      path: `${ROOT}/wiki/concepts/new.md`,
      content: "fresh note",
    });
    expect(wrote.isError).toBeFalsy();
    expect(wrote.content[0].text).toContain(`Saved the file ${ROOT}/wiki/concepts/new.md`);
    expect(fs.readFileSync(path.join(root, ROOT, "wiki/concepts/new.md"), "utf8")).toBe("fresh note");
    // The 기억 notice follows the scope root.
    expect(seen).toEqual([{ action: "add", path: `${ROOT}/wiki/concepts/new.md` }]);

    const capture = await callTool(tools, "write_file", {
      path: `${ROOT}/raw/2026-08-20.md`,
      content: "raw capture",
    });
    expect(capture.isError).toBeFalsy();
    expect(seen).toHaveLength(1); // raw/ is not a note

    const read = await callTool(tools, "read_file", { path: `${ROOT}/wiki/concepts/bot.md` });
    expect(read.content[0].text).toBe("bot note");

    const edited = await callTool(tools, "edit_file", {
      path: `${ROOT}/wiki/concepts/new.md`,
      old_string: "fresh",
      new_string: "updated",
    });
    expect(edited.isError).toBeFalsy();
    expect(seen[1]).toEqual({ action: "update", path: `${ROOT}/wiki/concepts/new.md` });

    const moved = await callTool(tools, "move_file", {
      from: `${ROOT}/wiki/concepts/new.md`,
      to: `${ROOT}/wiki/concepts/renamed.md`,
    });
    expect(moved.isError).toBeFalsy();

    const deleted = await callTool(tools, "delete_file", {
      path: `${ROOT}/wiki/concepts/renamed.md`,
    });
    expect(deleted.isError).toBeFalsy();
    expect(fs.existsSync(path.join(root, ROOT, "wiki/concepts/renamed.md"))).toBe(false);
  });

  it("refuses every path outside the memory folder with the redirect", async () => {
    const { s } = await scopedSetup("scoped-outside");
    const tools = toolsFor(s, { root: ROOT, botName: BOT });

    const outside = [
      "CLAUDE.md",
      "wiki/concepts/owner.md",
      "skills/deploy/SKILL.md",
      `${ROOT}/../CLAUDE.md`,
      `${ROOT}/wiki/../../../etc/hosts`,
      `${ROOT}-evil/wiki/a.md`,
      "agents/bot-other/wiki/a.md",
    ];
    for (const p of outside) {
      const read = await callTool(tools, "read_file", { path: p });
      expect(read.isError, `read ${p}`).toBe(true);
      expect(read.content[0].text).toBe(REFUSAL);
      const wrote = await callTool(tools, "write_file", { path: p, content: "x" });
      expect(wrote.isError, `write ${p}`).toBe(true);
      expect(wrote.content[0].text).toBe(REFUSAL);
      const edited = await callTool(tools, "edit_file", {
        path: p,
        old_string: "owner",
        new_string: "bot",
      });
      expect(edited.isError, `edit ${p}`).toBe(true);
      const removed = await callTool(tools, "delete_file", { path: p });
      expect(removed.isError, `delete ${p}`).toBe(true);
    }
    // The owner's files are untouched by the refused writes.
    const owner = await callTool(toolsFor(s), "read_file", { path: "CLAUDE.md" });
    expect(owner.content[0].text).toBe("owner root guidance");
  });

  it("leaves a backslash traversal to the second layer (never a read)", async () => {
    const { s } = await scopedSetup("scoped-backslash");
    const tools = toolsFor(s, { root: ROOT, botName: BOT });
    // A backslash is not a POSIX separator, so `<root>\..\..` is one segment that
    // isn't the root and isn't under it → the prefix check refuses it outright.
    const res = await callTool(tools, "read_file", { path: `${ROOT}\\..\\..\\CLAUDE.md` });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(REFUSAL);
    // Below the root, though, a backslash tail LOOKS like a legal leaf name to
    // the prefix check — the repo-containment layer (resolveInRepo splits on both
    // separators) is what refuses it. Layer 1 alone is never the whole guard.
    const nested = await callTool(tools, "read_file", { path: `${ROOT}/..\\CLAUDE.md` });
    expect(nested.isError).toBe(true);
    expect(nested.content[0].text).toBe("Invalid path.");
  });

  it("refuses a move whose SOURCE or DESTINATION leaves the folder", async () => {
    const { s, root } = await scopedSetup("scoped-move");
    const tools = toolsFor(s, { root: ROOT, botName: BOT });

    const out = await callTool(tools, "move_file", {
      from: `${ROOT}/wiki/concepts/bot.md`,
      to: "wiki/concepts/stolen.md",
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe(REFUSAL);
    expect(fs.existsSync(path.join(root, "wiki/concepts/stolen.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, ROOT, "wiki/concepts/bot.md"))).toBe(true);

    const inbound = await callTool(tools, "move_file", {
      from: "wiki/concepts/owner.md",
      to: `${ROOT}/wiki/concepts/taken.md`,
    });
    expect(inbound.isError).toBe(true);
    expect(inbound.content[0].text).toBe(REFUSAL);
    expect(fs.existsSync(path.join(root, "wiki/concepts/owner.md"))).toBe(true);
  });

  it("lists the memory folder instead of the owner's whole repo", async () => {
    const { s } = await scopedSetup("scoped-list");
    const scoped = await callTool(toolsFor(s, { root: ROOT, botName: BOT }), "list_files", {});
    expect(scoped.isError).toBeFalsy();
    const body = scoped.content[0].text ?? "";
    expect(body).toContain(`Your memory folder (\`${ROOT}/\`) file list:`);
    expect(body).toContain(`${ROOT}/wiki/concepts/bot.md`);
    expect(body).not.toContain("CLAUDE.md");
    expect(body).not.toContain("skills/");
    for (const line of body.split("\n").slice(1)) {
      expect(line.replace(/\/$/, "").startsWith(ROOT)).toBe(true);
    }

    const plain = await callTool(toolsFor(s), "list_files", {});
    expect(plain.content[0].text).toContain("Knowledge repository file list:");
    expect(plain.content[0].text).toContain("CLAUDE.md");
    expect(plain.content[0].text).toContain("skills/deploy/SKILL.md");
  });

  it("reports an empty memory folder as empty (not the repo)", async () => {
    const s = bootstrap("scoped-list-empty");
    await connectRepo(s, "scoped-list-empty", { "CLAUDE.md": "owner root guidance" });
    const res = await callTool(toolsFor(s, { root: ROOT, botName: BOT }), "list_files", {});
    expect(res.content[0].text).toBe(`(Your memory folder \`${ROOT}/\` is empty.)`);
  });

  it("refuses scaffold_skill and create_repo, redirecting to the owner", async () => {
    const { s } = await scopedSetup("scoped-refusals");
    const tools = toolsFor(s, { root: ROOT, botName: BOT });

    const skill = await callTool(tools, "scaffold_skill", { name: "deploy-runbook" });
    expect(skill.isError).toBe(true);
    expect(skill.content[0].text).toBe(
      "Skills are granted by the owner, so this bot cannot scaffold one into the owner's `skills/` folder — its repository access is limited to its own memory folder. Ask the owner to create the skill from their main avatar chat.",
    );
    const repo = await callTool(tools, "create_repo", { name: "new-repo" });
    expect(repo.isError).toBe(true);
    expect(repo.content[0].text).toBe(
      "Only the owner's main avatar chat can create or connect the knowledge repository; a bot chat cannot. Tell the owner to do it there, then retry.",
    );
    // Both stay registered (the allowedTools list is static) but advertise that
    // they are unavailable, so the model doesn't spend a turn on them.
    expect(tools.find((t) => t.name === "scaffold_skill")?.description).toContain("NOT AVAILABLE");
    expect(tools.find((t) => t.name === "create_repo")?.description).toContain("NOT AVAILABLE");

    // Unscoped: scaffold_skill still works and its description is unchanged.
    const plain = toolsFor(s);
    const scaffolded = await callTool(plain, "scaffold_skill", { name: "deploy-runbook" });
    expect(scaffolded.isError).toBeFalsy();
    expect(scaffolded.content[0].text).toContain("skills/deploy-runbook/SKILL.md");
    expect(plain.find((t) => t.name === "scaffold_skill")?.description).toContain(
      "Create a new skill (skills/<name>/SKILL.md + marketplace registration)",
    );
  });

  it("advertises the scope on the manage tools, and nothing when unscoped", async () => {
    const { s } = await scopedSetup("scoped-descriptions");
    const scoped = toolsFor(s, { root: ROOT, botName: BOT });
    for (const name of ["list_files", "read_file", "write_file", "edit_file", "delete_file", "move_file"]) {
      expect(scoped.find((t) => t.name === name)?.description, name).toContain(
        `only your own memory folder \`${ROOT}/\``,
      );
    }
    expect(scoped.find((t) => t.name === "commit")?.description).toContain(
      `Commit the changes in your memory folder \`${ROOT}/\``,
    );

    const plain = toolsFor(s);
    for (const t of plain) {
      expect(t.description, t.name).not.toContain(ROOT);
    }
    expect(plain.find((t) => t.name === "list_files")?.description).toBe(
      "Get the file list of my knowledge repository (personal repo). (owner or trusted same-group teammates; read-only)",
    );
    expect(plain.find((t) => t.name === "read_file")?.description).toBe(
      "Read the content of a file in my knowledge repository. (owner or trusted same-group teammates; read-only)",
    );
  });

  it("keeps the owner/no-repo gates ahead of the scope check", async () => {
    const s = bootstrap("scoped-gates");
    // No repo connected: the scoped no-repo redirect wins over the path check.
    const norepo = await callTool(toolsFor(s, { root: ROOT, botName: BOT }), "read_file", {
      path: "CLAUDE.md",
    });
    expect(norepo.isError).toBe(true);
    expect(norepo.content[0].text).toContain("MAIN avatar chat");
    expect(norepo.content[0].text).not.toContain("Adjust the path");

    // A viewer past the write gate gets OWNER_ONLY, not the scope redirect.
    const teammate = buildRepoTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "Owner" },
      viewerIsOwner: false,
      config: s.config,
      pathScope: { root: ROOT, botName: BOT },
    });
    const denied = await callTool(teammate, "write_file", { path: "CLAUDE.md", content: "x" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toBe("This tool can only be used by the avatar owner.");
  });
});

// ---------------------------------------------------------------------------
// repoTools.ts + repoGitCore.ts — pathspec-scoped commit
// ---------------------------------------------------------------------------

describe("scoped commit (stages only the memory folder)", () => {
  function toolsFor(s: ReturnType<typeof bootstrap>, pathScope?: { root: string; botName: string }) {
    return buildRepoTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "Owner" },
      viewerIsOwner: true,
      config: s.config,
      pathScope,
    });
  }

  it("commits the bot's note, leaves the owner's work in flight, skips reconcile", { timeout: 30_000 }, async () => {
    vi.mocked(reconcileOwnerSharedSkills).mockClear();
    const s = bootstrap("commit-scoped");
    const remote = seedRemote("commit-scoped", {
      "CLAUDE.md": "owner root guidance",
      "skills/deploy/SKILL.md": "---\nname: deploy\n---\n",
    });
    s.store.setKnowledgeRepo(s.owner.id, remote, "main");
    s.store.setGitToken(s.owner.id, "tok");
    const root = await ensureClone(knowledgeRepoContextFor(s.store, s.owner.id, s.config)!);

    // The owner left work in flight in the SHARED clone: one tracked edit and one
    // untracked file. A bot commit must not sweep either into its push.
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "owner edit in flight");
    write(root, "wiki/concepts/draft.md", "owner draft");

    const tools = toolsFor(s, { root: ROOT, botName: BOT });
    await callTool(tools, "write_file", { path: `${ROOT}/wiki/concepts/a.md`, content: "bot note" });
    const res = await callTool(tools, "commit", { message: "capture a memory" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Committed and pushed the changes");
    expect(res.content[0].text).not.toContain("Shared skills were reconciled");
    expect(vi.mocked(reconcileOwnerSharedSkills)).not.toHaveBeenCalled();

    // Only the subtree change is in the commit…
    expect(gitOut(root, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean)).toEqual([
      `${ROOT}/wiki/concepts/a.md`,
    ]);
    // …and the owner's work is still sitting uncommitted in the clone.
    const dirty = gitOut(root, "status", "--porcelain").split("\n").map((l) => l.trim());
    expect(dirty).toContain("M CLAUDE.md");
    expect(dirty).toContain("?? wiki/");
    // The remote received the note and nothing else.
    expect(gitOut(remote, "show", "main:CLAUDE.md")).toBe("owner root guidance");
    expect(gitOut(remote, "show", `main:${ROOT}/wiki/concepts/a.md`)).toBe("bot note");
    expect(gitOut(remote, "ls-tree", "-r", "--name-only", "main")).not.toContain(
      "wiki/concepts/draft.md",
    );

    // Positive control: an UNSCOPED commit on the same clone sweeps the owner's
    // pending work AND runs the shared-skill reconciliation.
    const owner = await callTool(toolsFor(s), "commit", { message: "owner work" });
    expect(owner.isError).toBeFalsy();
    expect(vi.mocked(reconcileOwnerSharedSkills)).toHaveBeenCalledTimes(1);
    expect(gitOut(remote, "show", "main:CLAUDE.md")).toBe("owner edit in flight");
    expect(gitOut(remote, "ls-tree", "-r", "--name-only", "main")).toContain(
      "wiki/concepts/draft.md",
    );
  });

  it("reports NO_CHANGES when only paths outside the folder are dirty", { timeout: 30_000 }, async () => {
    vi.mocked(reconcileOwnerSharedSkills).mockClear();
    const s = bootstrap("commit-nochanges");
    const remote = seedRemote("commit-nochanges", { "CLAUDE.md": "owner root guidance" });
    s.store.setKnowledgeRepo(s.owner.id, remote, "main");
    s.store.setGitToken(s.owner.id, "tok");
    const root = await ensureClone(knowledgeRepoContextFor(s.store, s.owner.id, s.config)!);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "owner edit in flight");

    // The memory folder doesn't exist in this repo at all — the pathspec matches
    // nothing, which is "nothing to commit", not a failure.
    const res = await callTool(toolsFor(s, { root: ROOT, botName: BOT }), "commit", { message: "m" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("There are no changes to commit.");
    expect(vi.mocked(reconcileOwnerSharedSkills)).not.toHaveBeenCalled();
    expect(gitOut(root, "status", "--porcelain")).toContain("CLAUDE.md");
    expect(gitOut(remote, "show", "main:CLAUDE.md")).toBe("owner root guidance");
  });
});

// ---------------------------------------------------------------------------
// runPlan.ts — the run actually PRODUCES the scope
// ---------------------------------------------------------------------------

describe("run plan scoping (bot run vs owner control)", () => {
  /** Minimal request for a bot run; `avatar` stays the OWNER's row (the A-1 rule). */
  function botRequest(
    ownerId: string,
    agentId: string,
    over: Partial<AgentRequest> = {},
  ): AgentRequest {
    return {
      message: "안녕",
      avatar: { id: ownerId, displayName: "리서치 봇", alias: "리서치", persona: "" },
      viewerUserId: ownerId,
      viewerIsOwner: true,
      personalAgent: { agentId, ownerUserId: ownerId },
      ...over,
    };
  }

  async function plan(
    s: ReturnType<typeof bootstrap>,
    request: AgentRequest,
  ): Promise<void> {
    vi.mocked(buildRepoServer).mockClear();
    vi.mocked(buildBrainServer).mockClear();
    vi.mocked(buildPersonalAgentSelfServer).mockClear();
    await buildAgentRunPlan(request, [], s.config, s.store, undefined, undefined, () => 0);
  }

  it("hands the repo and brain servers the bot's own memory namespace", async () => {
    const s = bootstrap("plan-scoped");
    // The feature is admin-gated in phase 1; the bot row is the scope's source.
    s.store.setRole(s.owner.id, "admin", true);
    const agent = s.store.createPersonalAgent(s.owner.id, { displayName: "리서치 봇" });
    await connectRepo(s, "plan-scoped", { "CLAUDE.md": "owner root" });

    await plan(s, botRequest(s.owner.id, agent.id));

    const expected = {
      root: personalAgentMemoryRoot(agent.memoryDir),
      botName: "리서치 봇",
    };
    expect(vi.mocked(buildRepoServer).mock.calls[0][1].pathScope).toEqual(expected);
    expect(vi.mocked(buildBrainServer).mock.calls[0][1].scope).toEqual(expected);
    // The root the servers get is the row's IMMUTABLE dir, not a re-derivation
    // from the current display name — renaming the bot must not move it.
    expect(expected.root).toBe(
      `agents/${personalAgentMemoryDirName("리서치 봇", agent.id)}`,
    );
    // adopt_skill/drop_skill can only read the owner's skill catalog when the
    // run passes config through; without it every grant fails closed.
    expect(vi.mocked(buildPersonalAgentSelfServer).mock.calls[0][1].config).toBe(s.config);
  });

  it("leaves a NON-bot owner run completely unscoped", async () => {
    const s = bootstrap("plan-unscoped");
    await connectRepo(s, "plan-unscoped", { "CLAUDE.md": "owner root" });

    await plan(s, {
      message: "안녕",
      avatar: { id: s.owner.id, displayName: "Owner", alias: "", persona: "" },
      viewerUserId: s.owner.id,
      viewerIsOwner: true,
    });

    expect(vi.mocked(buildRepoServer).mock.calls[0][1].pathScope).toBeUndefined();
    expect(vi.mocked(buildBrainServer).mock.calls[0][1].scope).toBeUndefined();
    expect(vi.mocked(buildPersonalAgentSelfServer)).not.toHaveBeenCalled();
  });

  it("scopes to a bot-id namespace when the row vanished mid-flight", async () => {
    const s = bootstrap("plan-ghost");
    s.store.setRole(s.owner.id, "admin", true);
    await connectRepo(s, "plan-ghost", { "CLAUDE.md": "owner root" });

    // The reach gate passed, then the row went away: the degenerate run must
    // never come out WIDER than a healthy one.
    await plan(s, botRequest(s.owner.id, "ghost-agent"));

    expect(vi.mocked(buildRepoServer).mock.calls[0][1].pathScope).toEqual({
      root: "agents/ghost-agent",
      botName: "리서치 봇",
    });
  });
});

// ---------------------------------------------------------------------------
// plugins.ts — the granted-skill allowlist + subtree standing memory
// ---------------------------------------------------------------------------

describe("bot skill allowlist and standing memory", () => {
  /** A NON-local runtime: `local` short-circuits both loaders to empty. */
  function claudeBootstrap(dir: string) {
    const dataDir = path.join(tempDir, dir);
    const { store, config } = createServices({
      dataDir,
      agentRuntime: "claude",
      sessionSecret: "t",
      // Keep the assertion about knowledge-repo roots free of bundled defaults.
      defaultPluginsDir: path.join(dataDir, "no-default-plugins"),
    });
    const owner = store.createUser({
      username: "owner",
      displayName: "Owner",
      password: "password123",
    });
    return { store, config, owner };
  }

  /** A marketplace knowledge repo carrying one `skills/<slug>/` plugin per slug. */
  function seedSkillRepo(name: string, slugs: string[], extra: Record<string, string> = {}) {
    const files: Record<string, string> = {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: slugs.map((slug) => ({ name: slug, source: `./skills/${slug}` })),
      }),
      ...extra,
    };
    for (const slug of slugs) {
      files[`skills/${slug}/SKILL.md`] =
        `---\nname: ${slug}\ndescription: ${slug} does things\n---\n`;
      files[`skills/${slug}/.claude-plugin/plugin.json`] = JSON.stringify({ name: slug });
    }
    return seedRemote(name, files);
  }

  it("loads no personal-knowledge roots, and no warning, for an ungranted bot", async () => {
    const s = claudeBootstrap("skills-none");
    s.store.setKnowledgeRepo(s.owner.id, seedSkillRepo("skills-none", ["code-review"]), "main");
    const warns: string[] = [];
    const roots = await loadAgentPluginRoots(
      s.store,
      s.owner.id,
      s.config,
      (m) => warns.push(m),
      { personalAgent: { selectedSkills: [] } },
    );

    expect(roots).toEqual([]);
    // "No loadable plugins" is the NORMAL state of a bot nobody granted a skill
    // to — it must not surface as a plugin warning in the owner's chat.
    expect(warns).toEqual([]);
    // The working tree is still materialized: the standing-memory read and the
    // scoped brain/repo tools all run off this clone.
    const clone = knowledgeClonePath(s.owner.id, s.config);
    expect(fs.existsSync(path.join(clone, "skills", "code-review", "SKILL.md"))).toBe(true);
  });

  it("loads exactly the granted skill, and the owner's own run still loads all", async () => {
    const s = claudeBootstrap("skills-one");
    s.store.setKnowledgeRepo(
      s.owner.id,
      seedSkillRepo("skills-one", ["code-review", "pptx-report"]),
      "main",
    );
    const clone = knowledgeClonePath(s.owner.id, s.config);

    const granted = await loadAgentPluginRoots(s.store, s.owner.id, s.config, undefined, {
      personalAgent: { selectedSkills: ["code-review"] },
    });
    expect(granted.map((r) => r.path)).toEqual([path.join(clone, "skills", "code-review")]);

    // Control: the owner's OWN run is untouched by the allowlist plumbing.
    const ownerRoots = await loadAgentPluginRoots(s.store, s.owner.id, s.config);
    expect(ownerRoots.map((r) => r.path).sort()).toEqual(
      [
        path.join(clone, "skills", "code-review"),
        path.join(clone, "skills", "pptx-report"),
      ].sort(),
    );
  });

  it("reads standing memory from the bot's folder, ignoring the owner's root CLAUDE.md", async () => {
    const s = claudeBootstrap("memory-claudemd");
    s.store.setKnowledgeRepo(
      s.owner.id,
      seedSkillRepo("memory-claudemd", [], {
        "CLAUDE.md": "OWNER standing memory",
        [`${ROOT}/CLAUDE.md`]: "BOT standing memory",
      }),
      "main",
    );
    // Materialize the clone the way a real turn does (plugin roots first).
    await loadAgentPluginRoots(s.store, s.owner.id, s.config, undefined, {
      personalAgent: { selectedSkills: [] },
    });

    const scoped = await loadKnowledgeRepoMemory(s.store, s.owner.id, s.config, {
      personalAgentMemoryRoot: ROOT,
    });
    expect(scoped.personal).toBe("BOT standing memory");

    // Control: the owner's own turn still reads the repo-root file.
    const unscoped = await loadKnowledgeRepoMemory(s.store, s.owner.id, s.config);
    expect(unscoped.personal).toBe("OWNER standing memory");

    // A bot whose folder has no CLAUDE.md inherits NOTHING — silence, not the
    // owner's standing memory.
    const empty = await loadKnowledgeRepoMemory(s.store, s.owner.id, s.config, {
      personalAgentMemoryRoot: "agents/bot-deadbeef",
    });
    expect(empty.personal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// preToolUseHook.ts — native-write integrity guard
// ---------------------------------------------------------------------------

describe("native-write guard on a bot run", () => {
  const CLONE = "/data/knowledge/u1";
  const scope = { clonePath: CLONE, memoryRoot: ROOT };
  const READONLY = ["Read", "Glob", "Grep"];
  /** Elevated + auto-approve, so anything the guard lets through is ALLOWED. */
  const hookFor = (personalAgentRun: boolean | typeof scope) =>
    buildPreToolUseHook(
      {},
      true,
      READONLY,
      false,
      false,
      true,
      "owner",
      undefined,
      false,
      undefined,
      true,
      personalAgentRun,
    );

  const call = (
    hook: ReturnType<typeof hookFor>,
    tool_name: string,
    file_path: string,
  ) => hook({ tool_name, tool_input: { file_path } });

  it("denies a write into the owner's clone outside the bot's folder", async () => {
    const hook = hookFor(scope);
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      const out = await call(hook, tool, `${CLONE}/wiki/concepts/a.md`);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
        "the knowledge repository is edited through the mcp__repo__* tools",
      );
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain(`\`${ROOT}/\``);
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
        "mcp__repo__write_file",
      );
    }
    // The owner's root CLAUDE.md and a SIBLING bot's folder are both outside.
    for (const target of [
      `${CLONE}/CLAUDE.md`,
      `${CLONE}/skills/code-review/SKILL.md`,
      `${CLONE}/agents/bot-other/wiki/a.md`,
      // A look-alike sibling directory is not under the root.
      `${CLONE}/${ROOT}-evil/wiki/a.md`,
      // Traversal back out of the folder resolves outside it.
      `${CLONE}/${ROOT}/../../CLAUDE.md`,
    ]) {
      const out = await call(hook, "Write", target);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  it("allows a write inside the bot's own folder and anywhere off the clone", async () => {
    const hook = hookFor(scope);
    for (const target of [
      `${CLONE}/${ROOT}/CLAUDE.md`,
      `${CLONE}/${ROOT}/wiki/concepts/a.md`,
      `${CLONE}/${ROOT}/raw/2026-08-20.md`,
      // Outside the clone entirely: the run's workspace is not this guard's business.
      "/data/workspaces/u1/scratch.md",
    ]) {
      const out = await call(hook, "Write", target);
      expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    }
    // Reads are never touched, inside the clone or out.
    const read = await call(hook, "Read", `${CLONE}/CLAUDE.md`);
    expect(read.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("leaves non-bot runs (and a scope-less bot run) unaffected", async () => {
    for (const kind of [false, true] as const) {
      const out = await call(hookFor(kind), "Write", `${CLONE}/CLAUDE.md`);
      expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    }
    // A bot run WITHOUT a write scope still redirects the question dialog — the
    // one parameter carries the run kind for both behaviors.
    const q = await hookFor(true)({ tool_name: "AskUserQuestion", tool_input: {} });
    expect(q.hookSpecificOutput.permissionDecisionReason).toContain(
      "mcp__personal_agent__report_task",
    );
    const scoped = await hookFor(scope)({ tool_name: "AskUserQuestion", tool_input: {} });
    expect(scoped.hookSpecificOutput.permissionDecisionReason).toContain(
      "mcp__personal_agent__report_task",
    );
  });
});
