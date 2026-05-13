import { test, expect } from "@playwright/test";
import {
  startWebServer,
  pushContent,
  clearContent,
  getPort,
  drainPendingQuestions,
  drainPendingSelections,
  answerQuestion,
  clearThreads,
} from "../dist/web.js";

test.describe.configure({ mode: "serial" });

let baseUrl: string;

test.beforeAll(async () => {
  await startWebServer();
  baseUrl = `http://localhost:${getPort()}`;
});

test.beforeEach(async ({ page }) => {
  clearContent("/");
  // Load the page once to clear localStorage from any previous test.
  await page.goto(baseUrl);
  await page.evaluate(() => localStorage.clear());
});

test("renders markdown content pushed before page load", async ({ page }) => {
  pushContent("# Hello\n\nWorld", "/");
  await page.goto(baseUrl);
  await expect(page.locator("h1")).toHaveText("Hello");
  await expect(page.locator("p")).toContainText("World");
});

test("status bar shows Connected once the WS handshake completes", async ({ page }) => {
  pushContent("# x", "/");
  await page.goto(baseUrl);
  await expect(page.locator("#status-text")).toHaveText("Connected");
});

test("renders a Mermaid diagram into an SVG", async ({ page }) => {
  pushContent("```mermaid\nflowchart LR\n  A --> B\n```\n", "/");
  await page.goto(baseUrl);
  await expect(page.locator("pre.mermaid svg")).toBeVisible();
});

test("renders KaTeX math", async ({ page }) => {
  pushContent("Inline $E = mc^2$ math.", "/");
  await page.goto(baseUrl);
  await expect(page.locator(".katex")).toBeVisible();
});

test("syntax-highlights fenced code blocks", async ({ page }) => {
  pushContent("```js\nconst x = 1;\n```\n", "/");
  await page.goto(baseUrl);
  // highlight.js wraps tokens in spans like .hljs-keyword
  await expect(page.locator("code .hljs-keyword").first()).toBeVisible();
});

test("copy button on code blocks copies code to clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  pushContent("```\nhello world\n```\n", "/");
  await page.goto(baseUrl);

  const wrapper = page.locator(".code-block-wrapper");
  await wrapper.hover();
  await wrapper.locator(".copy-btn").click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.trim()).toBe("hello world");
});

test("theme toggle switches between dark and light, persisting via localStorage", async ({ page }) => {
  pushContent("# Test", "/");
  await page.goto(baseUrl);

  await expect(page.locator("html")).toHaveClass(/theme-dark/);

  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveClass(/theme-light/);
  expect(await page.evaluate(() => localStorage.getItem("mdv-theme"))).toBe("light");

  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
});

test("font select swaps the markdown body font class", async ({ page }) => {
  pushContent("# Font test", "/");
  await page.goto(baseUrl);

  await page.locator("#font-select").selectOption("serif");
  await expect(page.locator("#content")).toHaveClass(/font-serif/);

  await page.locator("#font-select").selectOption("mono");
  await expect(page.locator("#content")).toHaveClass(/font-mono/);

  await page.locator("#font-select").selectOption("system");
  await expect(page.locator("#content")).not.toHaveClass(/font-(serif|mono)/);
});

test("append message extends content without re-rendering from scratch", async ({ page }) => {
  pushContent("# Start\n\n", "/");
  await page.goto(baseUrl);
  await expect(page.locator("h1")).toHaveText("Start");

  // Use the running server's appendContent — the WS listener on the page
  // will receive the message and re-render the accumulated markdown.
  const { appendContent } = await import("../dist/web.js");
  appendContent("More text here.", "/");

  await expect(page.locator("p")).toContainText("More text here.");
});

test.describe("PDF export", () => {
  test("forces light theme during print and restores after", async ({ page }) => {
    pushContent("# PDF Test\n\n```mermaid\nflowchart LR\n  A --> B\n```\n", "/");
    await page.goto(baseUrl);
    await expect(page.locator("pre.mermaid svg")).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/theme-dark/);

    // Stub window.print so the dialog doesn't block, capture state at call time.
    await page.evaluate(() => {
      (window as unknown as { __snap: unknown }).__snap = null;
      window.print = () => {
        const ps = document.getElementById("dynamic-page-size");
        const hljsLight = document.getElementById("hljs-light") as HTMLLinkElement;
        const hljsDark = document.getElementById("hljs-dark") as HTMLLinkElement;
        (window as unknown as { __snap: unknown }).__snap = {
          pageRule: ps ? ps.textContent : null,
          htmlClass: document.documentElement.className,
          hljsLightDisabled: hljsLight.disabled,
          hljsDarkDisabled: hljsDark.disabled,
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
      };
    });

    await page.locator("#pdf-button").click();

    // Wait for the export to finish (button re-enables).
    await expect(page.locator("#pdf-button")).toBeEnabled();

    const snap = await page.evaluate(
      () => (window as unknown as { __snap: Record<string, unknown> }).__snap,
    );
    expect(snap.htmlClass).toContain("theme-light");
    expect(snap.hljsLightDisabled).toBe(false);
    expect(snap.hljsDarkDisabled).toBe(true);
    expect(snap.bodyBg).toBe("rgb(255, 255, 255)");
    expect(snap.pageRule).toMatch(/^@page \{ size: \d+px \d+px; margin: 0; \}$/);

    // After: theme restored, dynamic style gone.
    await expect(page.locator("html")).toHaveClass(/theme-dark/);
    await expect(page.locator("#dynamic-page-size")).toHaveCount(0);
  });

  test("does not switch theme when already in light mode", async ({ page }) => {
    pushContent("# Light start", "/");
    await page.goto(baseUrl);
    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveClass(/theme-light/);

    await page.evaluate(() => {
      (window as unknown as { __classDuringPrint: string }).__classDuringPrint = "";
      window.print = () => {
        (window as unknown as { __classDuringPrint: string }).__classDuringPrint =
          document.documentElement.className;
      };
    });

    await page.locator("#pdf-button").click();
    await expect(page.locator("#pdf-button")).toBeEnabled();

    const cls = await page.evaluate(
      () => (window as unknown as { __classDuringPrint: string }).__classDuringPrint,
    );
    expect(cls).toContain("theme-light");
    // Theme stays light afterwards.
    await expect(page.locator("html")).toHaveClass(/theme-light/);
  });

  test("user can select text, ask a question, and see Claude's answer in the panel", async ({ page }) => {
    // Drain anything stale.
    drainPendingQuestions();

    pushContent("# Doc\n\nThe quick brown fox jumps over the lazy dog.\n", "/");
    await page.goto(baseUrl);

    // Select the word "quick" by double-clicking it.
    const target = page.locator("p", { hasText: "quick brown fox" });
    await target.evaluate((el) => {
      const textNode = el.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 4);
      range.setEnd(textNode, 9);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup"));
    });

    // Popover appears.
    const popover = page.locator("#selection-popover");
    await expect(popover).toBeVisible();
    await popover.locator("#selection-popover-collapsed .ask-btn").first().click();

    // Expanded form.
    await popover.locator("textarea").fill("What does this mean?");
    await popover.locator(".submit-btn").click();

    // Panel opens, thread shows pending state.
    await expect(page.locator("#qa-panel.open")).toBeVisible();
    const thread = page.locator(".qa-thread").first();
    await expect(thread).toBeVisible();
    await expect(thread.locator(".qa-question")).toHaveText("What does this mean?");
    await expect(thread.locator(".qa-pending")).toBeVisible();
    await expect(page.locator("#qa-badge")).toHaveClass(/visible/);

    // Server drains the question.
    const pending = drainPendingQuestions();
    expect(pending.length).toBe(1);
    expect(pending[0].question).toBe("What does this mean?");
    expect(pending[0].selection).toBe("quick");

    // Claude answers — should broadcast and render as markdown in the panel.
    const result = answerQuestion(pending[0].id, "It means **fast**.");
    expect(result).not.toBeNull();

    await expect(thread.locator(".qa-answer strong")).toHaveText("fast");
    await expect(thread.locator(".qa-pending")).toHaveCount(0);
    await expect(page.locator("#qa-badge")).not.toHaveClass(/visible/);
  });

  test("user can quote selection with a comment — context only, no panel thread", async ({ page }) => {
    drainPendingSelections();
    drainPendingQuestions();
    clearThreads();

    pushContent("# Doc\n\nThe quick brown fox jumps over the lazy dog.\n", "/");
    await page.goto(baseUrl);

    const target = page.locator("p", { hasText: "quick brown fox" });
    await target.evaluate((el) => {
      const textNode = el.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 4);
      range.setEnd(textNode, 19); // "quick brown fox"
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup"));
    });

    const popover = page.locator("#selection-popover");
    await expect(popover).toBeVisible();
    await popover.locator(".quote-btn").click();

    await expect(popover.locator("#popover-mode-label")).toContainText("Drop into context");
    await popover.locator("textarea").fill("worth keeping in mind");
    await popover.locator(".submit-btn").click();

    // No thread created.
    await expect(page.locator(".qa-thread")).toHaveCount(0);
    // Toast briefly appears.
    await expect(page.locator("#quote-toast")).toBeVisible();

    const sels = drainPendingSelections();
    expect(sels.length).toBe(1);
    expect(sels[0].selection).toBe("quick brown fox");
    expect(sels[0].comment).toBe("worth keeping in mind");
  });

  test("@page size height roughly matches document scrollHeight", async ({ page }) => {
    // Push enough content to make the page scroll.
    const long = Array.from({ length: 100 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
    pushContent(`# Long\n\n${long}\n`, "/");
    await page.goto(baseUrl);

    const expectedHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    await page.evaluate(() => {
      (window as unknown as { __rule: string }).__rule = "";
      window.print = () => {
        const ps = document.getElementById("dynamic-page-size");
        (window as unknown as { __rule: string }).__rule = ps?.textContent ?? "";
      };
    });

    await page.locator("#pdf-button").click();
    await expect(page.locator("#pdf-button")).toBeEnabled();

    const rule = await page.evaluate(() => (window as unknown as { __rule: string }).__rule);
    const match = rule.match(/size:\s*(\d+)px\s+(\d+)px/);
    expect(match).not.toBeNull();
    const heightPx = Number(match![2]);
    // Height should be at least the scrollHeight (we add ~40px slack and
    // the print stylesheet may shrink padding, so allow a wide window).
    expect(heightPx).toBeGreaterThanOrEqual(expectedHeight);
    expect(heightPx).toBeLessThanOrEqual(expectedHeight + 200);
  });
});
