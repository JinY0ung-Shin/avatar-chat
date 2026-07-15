import { expect, test, type Page } from "@playwright/test";

// External avatars hide the image-attach button and swap the native composer
// settings for a gateway model picker. These are geometry/structure checks (no
// screenshots): the send button must hug the composer's right edge with the
// textarea filling the row (the 3-column grid regression), and the settings row
// must show ONLY the gateway model select — never the native effort/MCP/group
// controls, even when the bootstrap offers them.

const user = {
  id: "user-1",
  username: "jinyoung",
  displayName: "김진영",
  alias: "진영",
  bio: "차분하고 유용한 AI 동료를 만들고 있습니다.",
  intro: "함께 더 좋은 답을 찾습니다.",
  hashtags: ["design", "agent"],
  onboardedAt: "2026-07-01T00:00:00.000Z",
  knowledgeRepo: "knowledge/repo",
  gitTokenSet: true,
  secretNames: [],
};

// Mirrors externalAvatarSummary/externalAvatarDetail on the server.
const externalSummary = {
  id: "external:research",
  username: "external-research",
  displayName: "Research Agent",
  alias: "리서처",
  bio: "외부 조사 에이전트",
  hashtags: ["research"],
  hasImage: false,
  pluginCount: 0,
  visibility: "public",
  updatedAt: null,
  runtime: "external",
  sharesGroup: false,
};
const externalDetail = {
  ...externalSummary,
  persona: "공개 소개",
  intro: "외부 Gateway에서 실행됩니다.",
  isOwn: false,
  elevated: false,
  plugins: [],
};

async function mockApp(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    // Avatar ids like "external:research" arrive percent-encoded (%3A).
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    let body: Record<string, unknown> = {};
    if (path === "/api/bootstrap") {
      body = {
        needsSetup: false,
        githubHost: "github.com",
        signupMode: "open",
        confluenceConfigured: false,
        // Native pickers ARE available server-wide — the external pane must
        // still hide them (they don't apply behind the gateway).
        modelSelection: {
          tiers: [{ id: "default", label: "기본", description: "균형", model: null }],
          locked: false,
        },
        effortSelection: {
          levels: [{ id: "high", label: "높음", description: "기본 강도" }],
          default: "high",
        },
      };
    } else if (path === "/api/me") {
      body = { user };
    } else if (path === "/api/avatars") {
      body = { avatars: [{ ...user, sharesGroup: false }, externalSummary] };
    } else if (path === "/api/avatars/external:research") {
      body = { avatar: externalDetail };
    } else if (path === "/api/avatars/external:research/models") {
      body = {
        models: ["gateway-model", "claude-frontier-9"],
        defaultModel: "gateway-model",
      };
    } else if (path === "/api/avatars/user-1") {
      body = {
        avatar: {
          ...user,
          hasImage: false,
          pluginCount: 0,
          visibility: "public",
          updatedAt: "2026-07-12T03:00:00.000Z",
          persona: "차분하고 정확한 디자인 동료",
          isOwn: true,
          elevated: true,
          plugins: [],
        },
      };
    } else if (path === "/api/conversations") {
      body = { conversations: [] };
    } else if (path === "/api/chat/runs") {
      body = { run: null };
    } else if (path.endsWith("/knowledge/requests")) {
      body = { requests: [] };
    } else if (path.endsWith("/notifications")) {
      body = { notifications: [] };
    } else if (path.endsWith("/plugins")) {
      body = { plugins: [] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApp(page);
});

test("external pane pins the send button to the composer edge and offers the gateway model picker", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "탐색" })).toBeVisible();
  await page.getByRole("button", { name: "리서처 아바타와 대화" }).click();
  await expect(page.getByRole("heading", { name: "리서처 아바타와 대화" })).toBeVisible();

  // No image-attach column, and the two remaining grid children stay put:
  // textarea fills the row, send button hugs the right edge.
  const composerBox = page.locator(".composer-box");
  await expect(composerBox).toHaveClass(/no-attach/);
  await expect(page.locator(".composer-attach")).toHaveCount(0);
  const box = await composerBox.boundingBox();
  const send = await page.locator(".send-button").boundingBox();
  const textarea = await page.locator(".composer-box textarea").boundingBox();
  expect(box).not.toBeNull();
  expect(send).not.toBeNull();
  expect(textarea).not.toBeNull();
  expect(box!.x + box!.width - (send!.x + send!.width)).toBeLessThanOrEqual(20);
  expect(textarea!.width).toBeGreaterThan(box!.width * 0.7);

  // Desktop shows the composer controls inline (no settings toggle), and the
  // gateway catalog loads eagerly with the pane — the picker must be populated
  // without any interaction, with the admin default labeled.
  const modelSelect = page.locator(".composer-model-select");
  await expect(modelSelect).toHaveCount(1);
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect.locator("option")).toHaveText([
    "기본 (gateway-model)",
    "claude-frontier-9",
  ]);
  await expect(modelSelect).toBeEnabled();
  await modelSelect.selectOption("claude-frontier-9");
  await expect(modelSelect).toHaveValue("claude-frontier-9");

  // Native-only controls never leak into an external pane.
  await expect(page.locator(".composer-tools-btn")).toHaveCount(0);
  await expect(page.locator(".composer-gk-btn")).toHaveCount(0);
  await expect(page.getByLabel("이 대화에 사용할 사고 강도(effort)")).toHaveCount(0);

  // Mobile collapses the controls behind the settings button; the summary chip
  // reflects the picked model and opening it reveals the same populated picker.
  await page.setViewportSize({ width: 390, height: 844 });
  const settingsButton = page.locator(".composer-settings-btn");
  await expect(settingsButton).toBeVisible();
  await expect(page.locator(".composer-settings-summary")).toHaveText("claude-frontier-9");
  await settingsButton.click();
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect).toHaveValue("claude-frontier-9");
});

test("native pane keeps the attach column and native pickers", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "탐색" })).toBeVisible();
  await page.getByRole("button", { name: "진영 아바타와 대화" }).click();
  await expect(page.getByRole("heading", { name: "진영 아바타와 대화" })).toBeVisible();

  const composerBox = page.locator(".composer-box");
  await expect(composerBox).not.toHaveClass(/no-attach/);
  await expect(page.locator(".composer-attach")).toHaveCount(1);
  const box = await composerBox.boundingBox();
  const send = await page.locator(".send-button").boundingBox();
  expect(box).not.toBeNull();
  expect(send).not.toBeNull();
  expect(box!.x + box!.width - (send!.x + send!.width)).toBeLessThanOrEqual(20);

  // Desktop shows the native pickers inline; the gateway select stays absent.
  await expect(page.getByLabel("이 대화에 사용할 모델")).toBeVisible();
  await expect(page.getByLabel("이 대화에 사용할 사고 강도(effort)")).toBeVisible();
  await expect(page.locator(".composer-tools-btn")).toHaveCount(1);
  await expect(page.getByLabel("이 대화에 사용할 Gateway 모델")).toHaveCount(0);
});
