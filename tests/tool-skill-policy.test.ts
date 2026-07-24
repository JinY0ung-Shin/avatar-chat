// Admin builtin tool/skill on-off policy: validators, the skills-allowlist
// math (discovery cache ∪ plugin-root scan − disabled), and the PreToolUse
// hook + prompt enforcement/meta-cognition surfaces.
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_TOOL_SKILL_POLICY,
  TOGGLABLE_BUILTIN_TOOLS,
  disallowedEntriesForPolicy,
  isToolSkillPolicyEmpty,
  normalizeSkillDiscoveryCache,
  normalizeToolSkillPolicy,
  parseToolSkillPolicy,
  type SkillDiscoveryCache,
} from "../src/server/toolSkillPolicy.js";
import {
  computeSkillsOption,
  listPluginRootSkills,
} from "../src/server/agent/skillDiscovery.js";
import { buildPreToolUseHook } from "../src/server/agent/preToolUseHook.js";
import { buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { DEFAULT_HEX_SSH_TOOL_POLICY } from "../src/server/hexSshPolicy.js";
import type { AgentRequest } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";

const tempDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-skill-policy-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tool/skill policy validators", () => {
  it("keeps the core tools out of the togglable catalog", () => {
    const names = TOGGLABLE_BUILTIN_TOOLS.flatMap((tool) => tool.names);
    expect(names).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    for (const core of ["Bash", "Read", "Glob", "Grep", "Edit", "Write", "Skill", "AskUserQuestion"]) {
      expect(names).not.toContain(core);
    }
  });

  it("parses a valid policy strictly, deduplicating entries", () => {
    expect(
      parseToolSkillPolicy({
        disabledTools: ["WebFetch", "WebFetch"],
        disabledSkills: ["code-review", "code-review", "plugin:deep-research"],
      }),
    ).toEqual({
      disabledTools: ["WebFetch"],
      disabledSkills: ["code-review", "plugin:deep-research"],
    });
  });

  it("rejects malformed policies at the write boundary", () => {
    expect(parseToolSkillPolicy(null)).toBeNull();
    expect(parseToolSkillPolicy([])).toBeNull();
    expect(parseToolSkillPolicy({ disabledTools: [] })).toBeNull();
    expect(parseToolSkillPolicy({ disabledTools: "WebFetch", disabledSkills: [] })).toBeNull();
    // Core tools outside the togglable catalog must never be disable-able via the API.
    expect(parseToolSkillPolicy({ disabledTools: ["Bash"], disabledSkills: [] })).toBeNull();
    expect(parseToolSkillPolicy({ disabledTools: [], disabledSkills: ["bad name"] })).toBeNull();
    expect(parseToolSkillPolicy({ disabledTools: [], disabledSkills: ["skill(x)"] })).toBeNull();
    expect(
      parseToolSkillPolicy({
        disabledTools: [],
        disabledSkills: Array.from({ length: 201 }, (_, i) => `skill-${i}`),
      }),
    ).toBeNull();
  });

  it("normalizes stored values leniently (corrupt → safe default)", () => {
    expect(normalizeToolSkillPolicy(null)).toEqual(DEFAULT_TOOL_SKILL_POLICY);
    expect(normalizeToolSkillPolicy("garbage")).toEqual(DEFAULT_TOOL_SKILL_POLICY);
    expect(
      normalizeToolSkillPolicy({
        disabledTools: ["WebSearch", "Bash", 42],
        disabledSkills: ["ok-skill", "bad name", null],
      }),
    ).toEqual({ disabledTools: ["WebSearch"], disabledSkills: ["ok-skill"] });
  });

  it("compiles the policy into disallowedTools entries", () => {
    const policy = { disabledTools: ["WebFetch"], disabledSkills: ["code-review"] };
    expect(disallowedEntriesForPolicy(policy)).toEqual(["WebFetch", "Skill(code-review)"]);
    expect(isToolSkillPolicyEmpty(policy)).toBe(false);
    expect(isToolSkillPolicyEmpty(DEFAULT_TOOL_SKILL_POLICY)).toBe(true);
  });

  it("reads the discovery cache leniently", () => {
    expect(normalizeSkillDiscoveryCache(null)).toBeNull();
    expect(normalizeSkillDiscoveryCache({ cliVersion: "", skills: [] })).toBeNull();
    expect(normalizeSkillDiscoveryCache({ cliVersion: "1.0.0", skills: "nope" })).toBeNull();
    expect(
      normalizeSkillDiscoveryCache({
        cliVersion: "1.0.0",
        fetchedAt: "t",
        skills: [{ name: "a", description: "d" }, { description: "nameless" }, "junk"],
      }),
    ).toEqual({ cliVersion: "1.0.0", fetchedAt: "t", skills: [{ name: "a", description: "d" }] });
  });
});

describe("skill discovery helpers", () => {
  function writeSkill(root: string, dir: string, frontmatter?: string) {
    const skillDir = path.join(root, "skills", dir);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      frontmatter !== undefined ? frontmatter : "no frontmatter body\n",
    );
  }

  it("enumerates plugin-root skills from SKILL.md frontmatter with directory fallback", () => {
    const root = tmpDir();
    writeSkill(root, "alpha", "---\nname: alpha-skill\ndescription: Alpha helper\n---\nbody\n");
    writeSkill(root, "beta");
    // Non-directory entries under skills/ are ignored.
    fs.writeFileSync(path.join(root, "skills", "stray.md"), "x");
    const skills = listPluginRootSkills([root, path.join(root, "missing-root")]);
    expect(skills).toEqual([
      { name: "alpha-skill", description: "Alpha helper" },
      { name: "beta", description: "" },
    ]);
  });

  it("computes the skills option with fail-open visibility", () => {
    const emptyPolicy = { disabledTools: [], disabledSkills: [] };
    const policy = { disabledTools: [], disabledSkills: ["code-review", "qualified-skill"] };
    const cache: SkillDiscoveryCache = {
      cliVersion: "2.1.185",
      fetchedAt: "t",
      skills: [
        { name: "code-review", description: "" },
        { name: "verify", description: "" },
        { name: "some-plugin:qualified-skill", description: "" },
      ],
    };
    // Nothing disabled → pre-feature behavior.
    expect(computeSkillsOption(emptyPolicy, cache, [])).toBe("all");
    // Disabled but no fresh cache → visibility fail-open (hook still denies).
    expect(computeSkillsOption(policy, null, [])).toBe("all");

    const root = tmpDir();
    writeSkill(root, "gamma", "---\nname: gamma-skill\n---\n");
    // Allowlist = (cache ∪ plugin roots) − disabled; a disabled bare name also
    // strips the plugin-qualified form.
    expect(computeSkillsOption(policy, cache, [root])).toEqual(["gamma-skill", "verify"]);
  });
});

describe("PreToolUse hook admin tool/skill policy", () => {
  const READONLY = ["Read", "Glob", "Grep"];

  function policyHook(
    policy: { disabledTools: string[]; disabledSkills: string[] },
    events: AgentEvents = {},
  ) {
    return buildPreToolUseHook(
      events,
      true,
      READONLY,
      false,
      false,
      true,
      "owner",
      DEFAULT_HEX_SSH_TOOL_POLICY,
      "rtk",
      false,
      policy,
    );
  }

  it("denies an admin-disabled skill with a redirecting reason and Korean block notice", async () => {
    const blocked: string[] = [];
    const hook = policyHook(
      { disabledTools: [], disabledSkills: ["code-review"] },
      { onBlocked: (info) => void blocked.push(info.reason ?? "") },
    );
    const out = await hook(
      { tool_name: "Skill", tool_input: { skill: "code-review" }, tool_use_id: "t1" },
      "t1",
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("disabled by the system administrator");
    expect(blocked[0]).toContain("관리자가 비활성화한 스킬");
  });

  it("denies a plugin-qualified invocation of a disabled bare skill name", async () => {
    const hook = policyHook({ disabledTools: [], disabledSkills: ["security-review"] });
    const out = await hook(
      { tool_name: "Skill", tool_input: { skill: "some-plugin:security-review" }, tool_use_id: "t2" },
      "t2",
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("still auto-allows other skills and read-only tools under a policy", async () => {
    const hook = policyHook({ disabledTools: ["WebFetch"], disabledSkills: ["code-review"] });
    const skill = await hook(
      { tool_name: "Skill", tool_input: { skill: "verify" }, tool_use_id: "t3" },
      "t3",
    );
    expect(skill.hookSpecificOutput.permissionDecision).toBe("allow");
    const read = await hook(
      { tool_name: "Read", tool_input: { file_path: "/tmp/x" }, tool_use_id: "t4" },
      "t4",
    );
    expect(read.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("denies an admin-disabled built-in tool even for an auto-approving owner", async () => {
    const hook = policyHook({ disabledTools: ["WebFetch"], disabledSkills: [] });
    const out = await hook(
      { tool_name: "WebFetch", tool_input: { url: "https://example.com" }, tool_use_id: "t5" },
      "t5",
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("disabled by the system administrator");
  });
});

describe("prompt admin-disabled note", () => {
  const baseRequest = {
    message: "안녕",
    avatar: { id: "a1", displayName: "아바타", alias: "", persona: "" },
  } as unknown as AgentRequest;

  it("adds the standing note when the admin disabled tools or skills", () => {
    const prompt = buildSystemPromptAppend({
      ...baseRequest,
      adminDisabledTools: ["WebFetch", "WebSearch"],
      adminDisabledSkills: ["code-review"],
    });
    expect(prompt).toContain("system administrator disabled");
    expect(prompt).toContain("`WebFetch`");
    expect(prompt).toContain("`code-review`");
    expect(prompt).toContain("Do not attempt, retry, or suggest them");
  });

  it("omits the note when nothing is disabled", () => {
    expect(buildSystemPromptAppend(baseRequest)).not.toContain("system administrator disabled");
  });
});

// ---- per-model-tier vision policy (modelVisionPolicy.ts) ----
import {
  normalizeModelVisionPolicy,
  parseModelVisionPolicy,
  visionForModel,
} from "../src/server/modelVisionPolicy.js";

describe("model vision policy", () => {
  it("normalize keeps only known tiers with strict-boolean values", () => {
    expect(normalizeModelVisionPolicy(null)).toEqual({});
    expect(normalizeModelVisionPolicy("junk")).toEqual({});
    expect(normalizeModelVisionPolicy({ opus: true, haiku: "no", gpt: false })).toEqual({ opus: true });
  });

  it("parse rejects unknown tiers, non-boolean values, and non-object shapes", () => {
    expect(parseModelVisionPolicy({ opus: false })).toEqual({ opus: false });
    expect(parseModelVisionPolicy({})).toEqual({});
    expect(parseModelVisionPolicy({ gpt: true })).toBeNull();
    expect(parseModelVisionPolicy({ opus: 1 })).toBeNull();
    expect(parseModelVisionPolicy([])).toBeNull();
    expect(parseModelVisionPolicy(null)).toBeNull();
  });

  it("visionForModel: tiers consult the policy; concrete ids and unset tiers inherit the default", () => {
    const policy = { sonnet: false };
    expect(visionForModel("sonnet", policy, true)).toBe(false);
    expect(visionForModel("opus", policy, true)).toBe(true);
    expect(visionForModel("opus", policy, false)).toBe(false);
    expect(visionForModel("claude-opus-4-8", policy, true)).toBe(true);
    expect(visionForModel(null, policy, false)).toBe(false);
    expect(visionForModel(undefined, policy, true)).toBe(true);
  });
});
