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
      body = {
        conversations: [{
          id: "conversation-1",
          avatarUserId: "user-1",
          title: "Apple 디자인 다듬기",
          avatarDisplayName: "진영",
          updatedAt: "2026-07-12T03:00:00.000Z",
          isRoutine: false,
          routineId: null,
          routinePrompt: null,
        }],
      };
    } else if (path === "/api/messages") {
      body = {
        messages: [
          {
            id: "message-user-1",
            conversationId: "conversation-1",
            role: "user",
            content: "Apple 스타일의 핵심을 다시 확인해줘.",
            response: null,
            createdAt: "2026-07-12T03:00:00.000Z",
          },
          {
            id: "message-assistant-1",
            conversationId: "conversation-1",
            role: "assistant",
            content: "콘텐츠가 중심이 되도록 재질과 모션을 절제해 적용했습니다.",
            response: null,
            createdAt: "2026-07-12T03:00:05.000Z",
          },
        ],
        groupKnowledgeOff: [],
      };
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

async function waitForKoreanFont(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const visibleText = document.body.innerText;
    const faces = await Promise.all([400, 600, 700].map((weight) =>
      document.fonts.load(`${weight} 14px "Noto Sans KR Variable"`, visibleText)
    ));
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return document.fonts.status === "loaded" && faces.every((loaded) => loaded.length > 0);
  })).toBe(true);
}

async function contrastRatio(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((element) => {
    const channels = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (value: string) => {
      const [r, g, b] = channels(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const style = getComputedStyle(element);
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
}

async function styleContrastRatio(
  page: Page,
  foregroundSelector: string,
  foregroundProperty: "outlineColor",
  backgroundSelector: string,
): Promise<number> {
  return page.locator(foregroundSelector).evaluate((element, args) => {
    const parse = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (value: string) => {
      const [r, g, b] = parse(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const foreground = luminance(getComputedStyle(element)[args.foregroundProperty]);
    const background = luminance(getComputedStyle(document.querySelector(args.backgroundSelector)! as Element).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  }, { foregroundProperty, backgroundSelector });
}

async function assertFocusRingContrast(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "focus-ring-probe";
    probe.style.outline = "3px solid var(--focus-ring)";
    document.body.append(probe);
  });
  expect(await styleContrastRatio(page, ".focus-ring-probe", "outlineColor", "body")).toBeGreaterThanOrEqual(3);
  await page.locator(".focus-ring-probe").evaluate((element) => element.remove());
}

test.beforeEach(async ({ page }) => {
  await mockApp(page);
});

test("explore shell stays visually stable in light and dark themes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "탐색" })).toBeVisible();
  await waitForKoreanFont(page);
  expect(await contrastRatio(page, ".new-chat")).toBeGreaterThanOrEqual(4.5);
  await assertFocusRingContrast(page);
  await expect(page).toHaveScreenshot("explore-light.png", { fullPage: true });

  await page.getByRole("button", { name: /^테마:/ }).click();
  await page.getByRole("button", { name: /^테마:/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await contrastRatio(page, ".new-chat")).toBeGreaterThanOrEqual(4.5);
  await assertFocusRingContrast(page);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.className = "confirm-danger contrast-probe";
    button.textContent = "삭제";
    document.body.append(button);
  });
  expect(await contrastRatio(page, ".contrast-probe")).toBeGreaterThanOrEqual(4.5);
  await page.locator(".contrast-probe").evaluate((element) => element.remove());
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
});

test("mobile rail and destructive confirmation remain spatially connected", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForKoreanFont(page);
  await page.mouse.move(2, 360);
  await page.mouse.down();
  await page.mouse.move(250, 360, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("#rail")).toBeVisible();
  await expect(page.getByRole("button", { name: "메뉴 열기" })).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveScreenshot("mobile-rail.png", { fullPage: true });

  await page.getByRole("button", { name: "모든 일반 대화 삭제", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "취소", exact: true })).toBeFocused();
  await expect(page).toHaveScreenshot("mobile-confirmation-sheet.png", { fullPage: true });

  const grabber = page.getByRole("button", { name: "아래로 쓸어 창 닫기" });
  const box = await grabber.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 5; step += 1) {
    await page.mouse.move(box!.x + box!.width / 2, box!.y + step * 6);
    await page.waitForTimeout(50);
  }
  const sheetTransformY = await page.getByRole("dialog").evaluate((element) =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m42
  );
  expect(sheetTransformY).toBeGreaterThan(8);
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect.poll(() => page.getByRole("dialog").evaluate((element) =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m42
  )).toBeLessThan(0.5);

  const dismissBox = await grabber.boundingBox();
  expect(dismissBox).not.toBeNull();
  await page.mouse.move(dismissBox!.x + dismissBox!.width / 2, dismissBox!.y + dismissBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(dismissBox!.x + dismissBox!.width / 2, dismissBox!.y + 140, { steps: 3 });
  const releaseFrom = await page.getByRole("dialog").evaluate((element) =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m42
  );
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect.poll(() => page.getByRole("dialog").evaluate((element) =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m42
  )).toBeGreaterThan(releaseFrom);
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("chat chrome and bubbles retain the Apple hierarchy", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "탐색" })).toBeVisible();
  await page.getByRole("button", { name: "대화 열기: Apple 디자인 다듬기" }).click();
  await expect(page.getByText("Apple 스타일의 핵심을 다시 확인해줘.")).toBeVisible();
  await expect(page.getByText("콘텐츠가 중심이 되도록 재질과 모션을 절제해 적용했습니다.")).toBeVisible();
  await waitForKoreanFont(page);
  expect(await contrastRatio(page, ".message.user .bubble")).toBeGreaterThanOrEqual(4.5);
  await expect(page).toHaveScreenshot("chat-light.png", { fullPage: true });
});

test("coarse pointers keep a 44px toggle target around a 28px track", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await mockApp(page);
  await page.goto("/");
  await page.evaluate(() => {
    const toggle = document.createElement("button");
    toggle.className = "toggle on";
    toggle.setAttribute("aria-label", "테스트 토글");
    toggle.innerHTML = '<span class="knob"></span>';
    document.body.append(toggle);
  });
  const metrics = await page.getByRole("button", { name: "테스트 토글" }).evaluate((element) => ({
    targetHeight: element.getBoundingClientRect().height,
    trackHeight: parseFloat(getComputedStyle(element, "::before").height),
    knobTop: parseFloat(getComputedStyle(element.querySelector(".knob")!).top),
  }));
  expect(metrics.targetHeight).toBe(44);
  expect(metrics.trackHeight).toBe(28);
  expect(metrics.knobTop).toBe(10);
  await context.close();
});
