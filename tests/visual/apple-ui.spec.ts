import { expect, test, type Page } from "@playwright/test";

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

async function mockApp(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: Record<string, unknown> = {};
    if (path === "/api/bootstrap") {
      body = { needsSetup: false, githubHost: "github.com", signupMode: "open", confluenceConfigured: false };
    } else if (path === "/api/me") {
      body = { user };
    } else if (path === "/api/avatars") {
      body = { avatars: [{ ...user, sharesGroup: false }] };
    } else if (path === "/api/conversations") {
      body = {
        conversations: [{
          id: "conversation-1",
          title: "Apple 디자인 다듬기",
          avatarDisplayName: "진영",
          updatedAt: "2026-07-12T03:00:00.000Z",
          isRoutine: false,
        }],
      };
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

test("explore shell stays visually stable in light and dark themes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "탐색" })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page).toHaveScreenshot("explore-light.png", { fullPage: true });

  await page.getByRole("button", { name: /^테마:/ }).click();
  await page.getByRole("button", { name: /^테마:/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page).toHaveScreenshot("explore-dark.png", { fullPage: true });

  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  await expect(page).toHaveScreenshot("explore-dark-reduced-transparency.png", { fullPage: true });

  await page.getByRole("button", { name: "알림", exact: true }).click();
  await expect(page.getByRole("heading", { name: "알림", level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.load('400 14px "Noto Sans KR Variable"', "한글");
    return document.fonts.check('400 14px "Noto Sans KR Variable"', "한글");
  })).toBe(true);
});

test("mobile rail and destructive confirmation remain spatially connected", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForTimeout(300);
  await page.mouse.move(2, 360);
  await page.mouse.down();
  await page.mouse.move(250, 360, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("#rail")).toBeVisible();
  await expect(page.getByRole("button", { name: "메뉴 열기" })).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveScreenshot("mobile-rail.png", { fullPage: true });

  await page.getByRole("button", { name: "모든 일반 대화 삭제", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveScreenshot("mobile-confirmation-sheet.png", { fullPage: true });

  const grabber = page.getByRole("button", { name: "아래로 쓸어 창 닫기" });
  const box = await grabber.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 70, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toBeVisible();
});
