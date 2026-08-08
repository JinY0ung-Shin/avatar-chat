import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { ensureClone, knowledgeRepoContextFor } from "../src/server/knowledgeRepo.js";
import {
  copySkillDir,
  hashSkillDir,
  learnSkillIntoRepo,
  listRepoSkills,
  normalizeSkillSlug,
  readSkillOrigin,
} from "../src/server/skillTransfer.js";
import { buildSkillExchangeTools } from "../src/server/agent/skillExchangeTools.js";
import { callTool, makeBareRemote, shareGroup, signup, withTempDir } from "./helpers.js";

// Coverage target: the skill-share (#skill-share) surface —
//  - store/avatars.ts shared_skills CRUD + learnable visibility (mirrors 탐색)
//  - skillTransfer.ts listing/copy/learn plumbing (offline local bare remotes)
//  - routes/skillShare.ts share/unshare/available/preview/learn
//  - agent/skillExchangeTools.ts handler self-gates + redirects

let tempDir: string;
const getTempDir = withTempDir("skill-share", () => {
  tempDir = getTempDir();
});

function bootstrap() {
  const services = createServices({
    dataDir: tempDir,
    agentRuntime: "local",
    sessionSecret: "test",
  });
  return { app: createApp(services), store: services.store, config: services.config };
}

async function newUser(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, userId: res.body.user.id as string };
}

const SKILL_MD = `---
name: pptx-report
description: Weekly report deck generator
---

# pptx-report

Make the deck.
`;

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
    const abs = path.join(seed, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("branch", "-M", "main");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  return remote;
}

/** A remote holding one shareable skill plus an empty marketplace manifest. */
function seedSkillRemote(name: string, extra: Record<string, string> = {}): string {
  return seedRemote(name, {
    ".claude-plugin/marketplace.json": JSON.stringify({ name, plugins: [] }),
    "skills/pptx-report/SKILL.md": SKILL_MD,
    "skills/pptx-report/scripts/render.sh": "#!/bin/sh\necho deck\n",
    ...extra,
  });
}

/** Commit + push a file change to a remote seeded by seedRemote (new version). */
function updateRemoteFile(name: string, rel: string, content: string): void {
  const seed = path.join(tempDir, `${name}-seed`);
  const abs = path.join(seed, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("add", "-A");
  g("commit", "-q", "-m", "update");
  g("push", "-q", "origin", "main");
}

// ---- store: shared_skills ---------------------------------------------------

describe("shared_skills store", () => {
  it("share upserts (id stable, metadata refreshed), unshare deletes", () => {
    const { store } = bootstrap();
    const first = store.shareSkill("u1", {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "old",
    });
    const second = store.shareSkill("u1", {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "new",
    });
    expect(second.id).toBe(first.id);
    expect(second.description).toBe("new");
    expect(store.listSharedSkillsByOwner("u1")).toHaveLength(1);
    expect(store.unshareSkill("u1", "pptx-report")).toBe(true);
    expect(store.unshareSkill("u1", "pptx-report")).toBe(false);
    expect(store.listSharedSkillsByOwner("u1")).toHaveLength(0);
  });

  it("learnable visibility mirrors avatar discovery (group teammates only)", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin"); // first signup = system admin
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    const outsider = await newUser(app, "outsider");
    const groupId = await shareGroup(admin.agent, ["sharer", "mate"]);

    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "Weekly report deck generator",
    });

    // Teammate sees it; the sharer's own view and outsiders don't.
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(1);
    expect(store.countLearnableSkills(mate.userId)).toBe(1);
    expect(store.listLearnableSkills(sharer.userId)).toHaveLength(0);
    expect(store.listLearnableSkills(outsider.userId)).toHaveLength(0);
    expect(store.countLearnableSkills(outsider.userId)).toBe(0);

    // Lookup by @username + slug, and by id — visibility-checked both ways.
    const byName = store.getLearnableSkillByName(mate.userId, "sharer", "pptx-report");
    expect(byName?.owner.username).toBe("sharer");
    expect(store.getLearnableSkillByName(outsider.userId, "sharer", "pptx-report")).toBeNull();
    expect(store.getLearnableSkill(mate.userId, byName!.id)?.id).toBe(byName!.id);
    expect(store.getLearnableSkill(outsider.userId, byName!.id)).toBeNull();

    // A private avatar's shares disappear from teammates (visibility axis).
    store.updateProfile(sharer.userId, { visibility: "private" });
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
    store.updateProfile(sharer.userId, { visibility: "group" });

    // A suspended owner's shares disappear.
    store.setSuspended(sharer.userId, true);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
    store.setSuspended(sharer.userId, false);

    // An avatar-sharing-off group grants neither visibility nor learnability.
    store.setGroupAvatarSharing(groupId, false);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
    store.setGroupAvatarSharing(groupId, true);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(1);
  });

  it("filters by query across skill fields and owner names", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "Weekly report deck generator",
    });
    store.shareSkill(sharer.userId, {
      skillName: "code-review",
      displayName: "code-review",
      description: "Review checklists",
    });

    expect(store.listLearnableSkills(mate.userId, "deck")).toHaveLength(1);
    expect(store.listLearnableSkills(mate.userId, "review")).toHaveLength(1);
    expect(store.listLearnableSkills(mate.userId, "sharer")).toHaveLength(2);
    expect(store.listLearnableSkills(mate.userId, "nothing-matches")).toHaveLength(0);
  });

  it("counts learns per (owner, skill) and keeps them across unshare→re-share", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });

    expect(store.listLearnableSkills(mate.userId)[0].learnCount).toBe(0);
    store.recordSkillLearn(sharer.userId, "pptx-report", mate.userId);
    store.recordSkillLearn(sharer.userId, "pptx-report", mate.userId);
    expect(store.listLearnableSkills(mate.userId)[0].learnCount).toBe(2);
    expect(store.listSharedSkillsByOwner(sharer.userId)[0].learnCount).toBe(2);
    expect(store.skillLearnCounts(sharer.userId)).toEqual({ "pptx-report": 2 });
    expect(store.countSkillLearnsForOwner(sharer.userId)).toBe(2);

    // Events are keyed by (owner, skill_name), not the share row: an
    // unshare→re-share keeps the history.
    store.unshareSkill(sharer.userId, "pptx-report");
    expect(store.skillLearnCounts(sharer.userId)).toEqual({ "pptx-report": 2 });
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    expect(store.listSharedSkillsByOwner(sharer.userId)[0].learnCount).toBe(2);

    // deleteUser cascades the LEARNER axis too (privacy promise).
    store.deleteUser(mate.userId);
    expect(store.countSkillLearnsForOwner(sharer.userId)).toBe(0);
  });

  it("deleteUser cascades the owner's share rows", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(1);
    store.deleteUser(sharer.userId);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
  });
});

// ---- skillTransfer.ts --------------------------------------------------------

describe("skillTransfer", () => {
  it("normalizes slugs the way scaffold_skill does", () => {
    expect(normalizeSkillSlug("My Cool Skill!")).toBe("my-cool-skill");
    expect(normalizeSkillSlug("  -weird-  ")).toBe("weird");
  });

  it("hashes a skill dir deterministically, ignoring the origin marker", () => {
    const root = path.join(tempDir, "hash-repo");
    fs.mkdirSync(path.join(root, "skills", "s"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "s", "SKILL.md"), SKILL_MD);
    const first = hashSkillDir(root, "s");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSkillDir(root, "s")).toBe(first);
    // The learner-side provenance marker must not change the fingerprint —
    // a learned copy re-shared by the learner hashes like the original.
    fs.writeFileSync(path.join(root, "skills", "s", ".noah-skill-origin.json"), "{}");
    expect(hashSkillDir(root, "s")).toBe(first);
    fs.writeFileSync(path.join(root, "skills", "s", "SKILL.md"), `${SKILL_MD}\nmore`);
    expect(hashSkillDir(root, "s")).not.toBe(first);
    expect(hashSkillDir(root, "missing")).toBeNull();
  });

  it("lists skills/<slug>/SKILL.md with frontmatter metadata", () => {
    const root = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(root, "skills", "b-skill"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "a-skill"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "not-a-skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "a-skill", "SKILL.md"), SKILL_MD);
    fs.writeFileSync(path.join(root, "skills", "b-skill", "SKILL.md"), "no frontmatter");
    const skills = listRepoSkills(root);
    expect(skills.map((s) => s.slug)).toEqual(["a-skill", "b-skill"]);
    expect(skills[0].name).toBe("pptx-report"); // frontmatter wins
    expect(skills[0].description).toBe("Weekly report deck generator");
    expect(skills[1].name).toBe("b-skill"); // dir-name fallback
  });

  it("copies a skill dir with guards (exists/missing/symlink/oversize)", async () => {
    const src = path.join(tempDir, "src-repo");
    const dest = path.join(tempDir, "dest-repo");
    fs.mkdirSync(path.join(src, "skills", "s", "nested"), { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(src, "skills", "s", "SKILL.md"), SKILL_MD);
    fs.writeFileSync(path.join(src, "skills", "s", "nested", "x.txt"), "x");
    fs.symlinkSync("/etc/hostname", path.join(src, "skills", "s", "evil-link"));

    const stats = await copySkillDir(src, "s", dest, "s");
    expect(stats.files).toBe(2);
    expect(stats.skippedSymlinks).toBe(1);
    expect(fs.existsSync(path.join(dest, "skills", "s", "nested", "x.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "skills", "s", "evil-link"))).toBe(false);

    await expect(copySkillDir(src, "s", dest, "s")).rejects.toThrow("SKILL_EXISTS");
    await expect(copySkillDir(src, "missing", dest, "m")).rejects.toThrow("SKILL_NOT_FOUND");
    await expect(copySkillDir(src, "../s", dest, "t")).rejects.toThrow("INVALID_NAME");

    fs.writeFileSync(path.join(src, "skills", "s", "big.bin"), Buffer.alloc(512 * 1024 + 1));
    await expect(copySkillDir(src, "s", dest, "s2")).rejects.toThrow("SKILL_FILE_TOO_LARGE");
  });

  it("learns end-to-end: copy, identity rewrite, manifest, commit+push", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const sharer = await newUser(app, "sharer");
    const learner = await newUser(app, "learner");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      learner.userId,
      seedRemote("learner-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "l", plugins: [] }),
      }),
      "main",
    );
    const sharerCtx = knowledgeRepoContextFor(store, sharer.userId, config)!;
    const learnerCtx = knowledgeRepoContextFor(store, learner.userId, config)!;

    const result = await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      sharerUsername: "sharer",
      commitMessage: "Learn skill",
      identity: { name: "Learner", email: "l@example.com" },
    });
    expect(result.slug).toBe("pptx-report");
    expect(result.committed).toBe(true);
    expect(result.needsSelection).toBe(false);

    const learnerRoot = await ensureClone(learnerCtx);
    expect(fs.readFileSync(path.join(learnerRoot, "skills", "pptx-report", "SKILL.md"), "utf8")).toContain(
      "Make the deck.",
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(learnerRoot, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as { plugins: { name: string; source: string }[] };
    expect(manifest.plugins).toContainEqual({ name: "pptx-report", source: "./skills/pptx-report" });
    // plugin.json is created when the source skill lacked one (loadability).
    const pluginJson = JSON.parse(
      fs.readFileSync(
        path.join(learnerRoot, "skills", "pptx-report", ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    ) as { name: string };
    expect(pluginJson.name).toBe("pptx-report");
    // The commit reached the learner's REMOTE (persistence, not just the clone).
    const remoteLog = execFileSync(
      "git",
      ["-C", path.join(tempDir, "learner-repo.git"), "log", "--oneline", "main"],
      { stdio: "pipe" },
    ).toString();
    expect(remoteLog).toContain("Learn skill");

    // Provenance marker: who it came from + the SOURCE hash at learn time.
    const origin = readSkillOrigin(learnerRoot, "pptx-report");
    expect(origin?.ownerUserId).toBe(sharer.userId);
    expect(origin?.ownerUsername).toBe("sharer");
    expect(origin?.skillName).toBe("pptx-report");
    expect(origin?.contentHash).toBe(result.contentHash);

    // Renamed learn rewrites the SKILL.md frontmatter name + plugin.json name.
    const renamed = await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      newName: "My Deck Skill",
      sharerUsername: "sharer",
      commitMessage: "Learn skill again",
      identity: { name: "Learner", email: "l@example.com" },
    });
    expect(renamed.slug).toBe("my-deck-skill");
    const renamedMd = fs.readFileSync(
      path.join(learnerRoot, "skills", "my-deck-skill", "SKILL.md"),
      "utf8",
    );
    expect(renamedMd).toContain("name: my-deck-skill");
    const renamedPlugin = JSON.parse(
      fs.readFileSync(
        path.join(learnerRoot, "skills", "my-deck-skill", ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    ) as { name: string };
    expect(renamedPlugin.name).toBe("my-deck-skill");
  });

  it("updates a learned copy in place, gated on the origin marker", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const sharer = await newUser(app, "sharer");
    const learner = await newUser(app, "learner");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      learner.userId,
      seedRemote("learner-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "l", plugins: [] }),
        // A hand-made skill with NO origin marker — update must refuse it.
        "skills/handmade/SKILL.md": "---\nname: handmade\n---\n",
      }),
      "main",
    );
    const sharerCtx = knowledgeRepoContextFor(store, sharer.userId, config)!;
    const learnerCtx = knowledgeRepoContextFor(store, learner.userId, config)!;
    const identity = { name: "Learner", email: "l@example.com" };

    const first = await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      newName: "my-copy",
      sharerUsername: "sharer",
      commitMessage: "Learn",
      identity,
    });
    expect(first.updated).toBe(false);

    // The sharer ships a new version; updating replaces the learner's copy and
    // records the NEW source hash.
    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## v2\n`);
    const updated = await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      updateSlug: "my-copy",
      sharerUsername: "sharer",
      commitMessage: "Update",
      identity,
    });
    expect(updated.updated).toBe(true);
    expect(updated.slug).toBe("my-copy");
    expect(updated.contentHash).not.toBe(first.contentHash);
    const learnerRoot = await ensureClone(learnerCtx);
    expect(
      fs.readFileSync(path.join(learnerRoot, "skills", "my-copy", "SKILL.md"), "utf8"),
    ).toContain("## v2");
    expect(readSkillOrigin(learnerRoot, "my-copy")?.contentHash).toBe(updated.contentHash);

    // No origin marker (or a mismatched one) → fail closed, nothing replaced.
    await expect(
      learnSkillIntoRepo({
        sharerCtx,
        learnerCtx,
        skillName: "pptx-report",
        updateSlug: "handmade",
        sharerUsername: "sharer",
        commitMessage: "Update",
        identity,
      }),
    ).rejects.toThrow("NOT_LEARNED_FROM_SHARE");
    expect(fs.existsSync(path.join(learnerRoot, "skills", "handmade", "SKILL.md"))).toBe(true);
  });
});

// ---- routes/skillShare.ts -----------------------------------------------------

describe("skill-share routes", () => {
  it("mine reports repoConfigured=false without a repo (not an error)", async () => {
    const { app } = bootstrap();
    const { agent } = await newUser(app, "solo");
    const res = await agent.get("/api/skill-share/mine").expect(200);
    expect(res.body).toEqual({ repoConfigured: false, skills: [] });
  });

  // The heaviest test in the suite: two seeded remotes + repeated clone/learn
  // round-trips. Under full-suite parallel load the real git work can exceed
  // vitest's 5s default, so give the END-TO-END flow explicit headroom.
  it("shares, browses, previews, and learns across a group", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    const outsider = await newUser(app, "outsider");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );

    // Owner's mine view lists the repo skill, unshared, never learned.
    const mine = await sharer.agent.get("/api/skill-share/mine").expect(200);
    expect(mine.body.repoConfigured).toBe(true);
    expect(mine.body.skills).toEqual([
      {
        slug: "pptx-report",
        name: "pptx-report",
        description: "Weekly report deck generator",
        shared: false,
        learnCount: 0,
        origin: null,
      },
    ]);

    // Share validation: unknown skill 404, malformed name 400.
    await sharer.agent.post("/api/skill-share/share").send({ skill: "nope" }).expect(404);
    await sharer.agent.post("/api/skill-share/share").send({ skill: "../etc" }).expect(400);
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);

    // Teammate browses it; outsider sees nothing. The SHARER sees their own
    // share in the same feed (like 탐색 shows one's own avatar) with the count.
    const avail = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(avail.body.skills).toHaveLength(1);
    const listing = avail.body.skills[0];
    expect(listing.owner.username).toBe("sharer");
    expect(listing.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const outsiderAvail = await outsider.agent.get("/api/skill-share/available").expect(200);
    expect(outsiderAvail.body.skills).toHaveLength(0);
    const sharerAvail = await sharer.agent.get("/api/skill-share/available").expect(200);
    expect(sharerAvail.body.skills).toHaveLength(1);
    expect(sharerAvail.body.skills[0].ownerUserId).toBe(sharer.userId);
    expect(sharerAvail.body.skills[0].learnCount).toBe(0);

    // Preview returns the live SKILL.md; outsiders get 404 even with the id.
    const previewRes = await mate.agent
      .get(`/api/skill-share/available/${listing.id}`)
      .expect(200);
    expect(previewRes.body.content).toContain("Make the deck.");
    await outsider.agent.get(`/api/skill-share/available/${listing.id}`).expect(404);

    // Learn: outsider 404; mate without conflicts 200; second learn 409; rename ok.
    await outsider.agent.post("/api/skill-share/learn").send({ id: listing.id }).expect(404);
    const learned = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id })
      .expect(200);
    expect(learned.body.slug).toBe("pptx-report");
    await mate.agent.post("/api/skill-share/learn").send({ id: listing.id }).expect(409);
    const renamed = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, newName: "deck-two" })
      .expect(200);
    expect(renamed.body.slug).toBe("deck-two");

    // The learned skill shows up in the mate's own mine view (now shareable).
    const mateMine = await mate.agent.get("/api/skill-share/mine").expect(200);
    expect(mateMine.body.skills.map((s: { slug: string }) => s.slug)).toEqual([
      "deck-two",
      "pptx-report",
    ]);

    // Both successful learns were counted: teammates' listing AND the owner's
    // mine view show 전수 2회.
    const availAfterLearns = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(availAfterLearns.body.skills[0].learnCount).toBe(2);
    const sharerMine = await sharer.agent.get("/api/skill-share/mine").expect(200);
    expect(sharerMine.body.skills[0].learnCount).toBe(2);

    // Unshare: 404 for a non-shared name, 200 for the shared one; the listing empties.
    await sharer.agent.delete("/api/skill-share/share/none").expect(404);
    await sharer.agent.delete("/api/skill-share/share/pptx-report").expect(200);
    const after = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(after.body.skills).toHaveLength(0);
  });

  it("flags updates via origin markers and overwrites in place", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const avail = await mate.agent.get("/api/skill-share/available").expect(200);
    const listing = avail.body.skills[0];

    await mate.agent.post("/api/skill-share/learn").send({ id: listing.id }).expect(200);
    // Mine reports the provenance the client joins against the listing hash.
    const mateMine = await mate.agent.get("/api/skill-share/mine").expect(200);
    const learnedRow = mateMine.body.skills.find((s: { slug: string }) => s.slug === "pptx-report");
    expect(learnedRow.origin.ownerUserId).toBe(sharer.userId);
    expect(learnedRow.origin.contentHash).toBe(listing.contentHash);

    // The sharer ships v2; their mine reconciliation refreshes the row hash,
    // which no longer matches the learner's origin hash (= update available).
    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## v2\n`);
    await sharer.agent.get("/api/skill-share/mine").expect(200);
    const availAfter = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(availAfter.body.skills[0].contentHash).not.toBe(listing.contentHash);

    // updateSlug + newName together is invalid; wrong slug fails closed.
    await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "pptx-report", newName: "x" })
      .expect(400);
    await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "not-mine" })
      .expect(409);

    const updated = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "pptx-report" })
      .expect(200);
    expect(updated.body.updated).toBe(true);
    const mineAfter = await mate.agent.get("/api/skill-share/mine").expect(200);
    expect(
      mineAfter.body.skills.find((s: { slug: string }) => s.slug === "pptx-report").origin
        .contentHash,
    ).toBe(availAfter.body.skills[0].contentHash);
    // The refresh did NOT inflate 전수된 횟수 — one learn, one count.
    expect(store.countSkillLearnsForOwner(sharer.userId)).toBe(1);
  });

  it("learn without a connected learner repo is a 400 with guidance", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    const row = store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    const res = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: row.id })
      .expect(400);
    expect(res.body.error).toContain("지식 저장소");
  });

  it("disconnecting or repointing the knowledge repo clears the owner's shares", async () => {
    const { app, store } = bootstrap();
    const sharer = await newUser(app, "sharer");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });

    // Repoint to a different repo → the old-repo shares are dropped.
    await sharer.agent.put("/api/me/knowledge-repo").send({ repo: "owner/brain" }).expect(200);
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);

    // A same-repo re-save (e.g. branch change) keeps shares.
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    await sharer.agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "owner/brain", branch: "dev" })
      .expect(200);
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(1);

    // Disconnecting clears them too.
    await sharer.agent.put("/api/me/knowledge-repo").send({ repo: "" }).expect(200);
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);
  });

  it("mine reconciles stale rows: a share whose dir vanished is unshared", async () => {
    const { app, store } = bootstrap();
    const sharer = await newUser(app, "sharer");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.shareSkill(sharer.userId, {
      skillName: "deleted-skill",
      displayName: "deleted-skill",
      description: "",
    });
    const mine = await sharer.agent.get("/api/skill-share/mine").expect(200);
    expect(mine.body.skills.map((s: { slug: string }) => s.slug)).toEqual(["pptx-report"]);
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);
  });
});

// ---- agent/skillExchangeTools.ts ----------------------------------------------

describe("mcp skill_exchange tools", () => {
  function toolsFor(
    store: ReturnType<typeof bootstrap>["store"],
    config: ReturnType<typeof bootstrap>["config"],
    userId: string,
    username: string,
    viewerIsOwner = true,
  ) {
    return buildSkillExchangeTools(store, {
      avatarUserId: userId,
      owner: { id: userId, username, displayName: username, alias: "" },
      viewerIsOwner,
      config,
    });
  }

  it("every tool self-gates on viewerIsOwner", async () => {
    const { store, config } = bootstrap();
    const tools = toolsFor(store, config, "u1", "u1", false);
    for (const name of ["find_shared_skills", "learn_skill", "share_skill", "unshare_skill"]) {
      const result = await callTool(tools, name, {
        owner_username: "x",
        skill_name: "y",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("avatar owner");
    }
  });

  it("find lists teammate shares with the learn address; empty state guides", async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    const tools = toolsFor(store, config, mate.userId, "mate");

    const empty = await callTool(tools, "find_shared_skills", {});
    expect(empty.content[0].text).toContain("No teammate has shared a skill yet");

    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "Weekly report deck generator",
    });
    const found = await callTool(tools, "find_shared_skills", { query: "deck" });
    expect(found.content[0].text).toContain("pptx-report");
    expect(found.content[0].text).toContain("@sharer");

    const miss = await callTool(tools, "find_shared_skills", { query: "zzz" });
    expect(miss.content[0].text).toContain('No shared skill matches "zzz"');
  });

  it("learn_skill copies into the owner's repo and redirects on failures", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    const tools = toolsFor(store, config, mate.userId, "mate");

    // Unknown share → redirect to find_shared_skills.
    const unknown = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "nope",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("find_shared_skills");

    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });

    // No learner repo yet → NO_REPO guidance.
    const noRepo = await callTool(tools, "learn_skill", {
      owner_username: "@sharer",
      skill_name: "pptx-report",
    });
    expect(noRepo.isError).toBe(true);
    expect(noRepo.content[0].text).toContain("knowledge repository");

    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    const ok = await callTool(tools, "learn_skill", {
      owner_username: "@sharer",
      skill_name: "pptx-report",
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain('Learned "pptx-report" from @sharer');
    const mateRoot = await ensureClone(knowledgeRepoContextFor(store, mate.userId, config)!);
    expect(fs.existsSync(path.join(mateRoot, "skills", "pptx-report", "SKILL.md"))).toBe(true);
    // The learn was recorded, and find surfaces the adoption count.
    expect(store.countSkillLearnsForOwner(sharer.userId)).toBe(1);
    const foundAfter = await callTool(tools, "find_shared_skills", {});
    expect(foundAfter.content[0].text).toContain("learned 1×");

    // Second learn collides → suggests new_name.
    const dup = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
    });
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toContain("new_name");
  });

  it("learn_skill update:true resolves the learner's copy and refuses ambiguity", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    const tools = toolsFor(store, config, mate.userId, "mate");

    // Nothing learned yet → update has no target.
    const none = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      update: true,
    });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain("nothing to update");

    await callTool(tools, "learn_skill", { owner_username: "sharer", skill_name: "pptx-report" });
    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## v2\n`);
    const ok = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      update: true,
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain('Updated "pptx-report"');
    const mateRoot = await ensureClone(knowledgeRepoContextFor(store, mate.userId, config)!);
    expect(
      fs.readFileSync(path.join(mateRoot, "skills", "pptx-report", "SKILL.md"), "utf8"),
    ).toContain("## v2");

    // A second copy makes the update target ambiguous → redirect, no change.
    await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      new_name: "second-copy",
    });
    const ambiguous = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      update: true,
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain("ambiguous");

    // update + new_name is contradictory input.
    const both = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      update: true,
      new_name: "x",
    });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain("mutually exclusive");
  });

  it("share_skill/unshare_skill manage the owner's own listings", async () => {
    const { app, store, config } = bootstrap();
    const sharer = await newUser(app, "sharer");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    const tools = toolsFor(store, config, sharer.userId, "sharer");

    const missing = await callTool(tools, "share_skill", { skill_name: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("scaffold_skill");

    const shared = await callTool(tools, "share_skill", { skill_name: "pptx-report" });
    expect(shared.isError).toBeFalsy();
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(1);

    const unshared = await callTool(tools, "unshare_skill", { skill_name: "pptx-report" });
    expect(unshared.isError).toBeFalsy();
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);

    const again = await callTool(tools, "unshare_skill", { skill_name: "pptx-report" });
    expect(again.isError).toBe(true);
  });
});
