import { test, expect } from "@playwright/test";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startWebServer,
  pushContent,
  clearContent,
  getPort,
} from "../dist/web.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const samplePng = join(repoRoot, "screenshot.png");

const SVG_FIXTURE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24">' +
  '<rect width="40" height="24" fill="#4488cc"/></svg>';

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

test("Mermaid node labels contrast with custom fills in dark mode", async ({ page }) => {
  // A light custom fill (`style B fill:#ffcccc`) must get dark label text,
  // while a dark default node keeps light text. Regression for white-on-pink.
  pushContent(
    "```mermaid\nflowchart LR\n  A[Default] --> B[Pink]\n  style B fill:#ffcccc\n```\n",
    "/",
  );
  await page.goto(baseUrl);
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
  await expect(page.locator("pre.mermaid svg .node")).toHaveCount(2);

  const colors = await page.evaluate(() => {
    const lum = (rgb: string) => {
      const [r, g, b] = rgb.match(/[\d.]+/g)!.slice(0, 3).map((v) => {
        const n = Number(v) / 255;
        return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const out: Record<string, number> = {};
    document.querySelectorAll("pre.mermaid svg .node").forEach((node) => {
      const label = node.textContent!.trim();
      const p = node.querySelector("foreignObject p, foreignObject span.nodeLabel")!;
      out[label] = lum(getComputedStyle(p).color);
    });
    return out;
  });

  // Dark default fill → light text (high luminance); light pink fill → dark text.
  expect(colors["Default"]).toBeGreaterThan(0.5);
  expect(colors["Pink"]).toBeLessThan(0.1);
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

test("renders GitHub-style task list checkboxes", async ({ page }) => {
  pushContent("- [ ] unchecked item\n- [x] checked item\n", "/");
  await page.goto(baseUrl);
  const checkboxes = page.locator(".task-list-item input[type='checkbox']");
  await expect(checkboxes).toHaveCount(2);
  await expect(checkboxes.nth(0)).not.toBeChecked();
  await expect(checkboxes.nth(1)).toBeChecked();
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

test("copy button on mermaid diagrams copies the diagram source", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  pushContent("```mermaid\nflowchart LR\n  A --> B\n```\n", "/");
  await page.goto(baseUrl);

  // Source text is replaced by the rendered SVG, so the button must copy the
  // original diagram source stashed before mermaid ran.
  await expect(page.locator("pre.mermaid svg")).toBeVisible();

  const wrapper = page.locator(".mermaid-wrapper");
  await wrapper.hover();
  await wrapper.locator(".copy-btn").click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.trim()).toBe("flowchart LR\n  A --> B");
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

test("list items and nested lists get generous default spacing", async ({ page }) => {
  pushContent("- one\n- two\n  - nested\n  - nested two\n", "/");
  await page.goto(baseUrl);

  const items = page.locator("#content > ul > li");
  await expect(items).toHaveCount(2);

  const siblingGap = await items
    .nth(1)
    .evaluate((el) => parseFloat(getComputedStyle(el).marginTop));
  expect(siblingGap).toBeGreaterThanOrEqual(8);

  const nested = await page.locator("#content ul ul").evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      top: parseFloat(style.marginTop),
      bottom: parseFloat(style.marginBottom),
    };
  });
  expect(nested.top).toBeGreaterThanOrEqual(8);
  expect(nested.bottom).toBeGreaterThanOrEqual(8);
});

test("render_file renders a markdown file from disk", async ({ page }) => {
  const { pushFile } = await import("../dist/web.js");
  const filePath = join(tmpdir(), `render-file-${Date.now()}.md`);
  await writeFile(filePath, "# From a file\n\nLoaded from disk.");
  try {
    await pushFile(filePath, "/");
    await page.goto(baseUrl);
    await expect(page.locator("h1")).toHaveText("From a file");
    await expect(page.locator("p")).toContainText("Loaded from disk.");
  } finally {
    await unlink(filePath);
  }
});

test.describe("images", () => {
  // A loaded raster image reports its real pixel dimensions; a broken one is 0.
  const naturalWidth = (page: import("@playwright/test").Page) =>
    page.locator("#content img").first().evaluate((el) => (el as HTMLImageElement).naturalWidth);

  test("renders a local absolute path by routing it through the image endpoint", async ({ page }) => {
    pushContent(`![shot](${samplePng})\n`, "/");
    await page.goto(baseUrl);

    const img = page.locator("#content img");
    await expect(img).toHaveAttribute("src", /^\/__mdv\/image\?src=/);
    // The authored path is kept for diagnostics.
    await expect(img).toHaveAttribute("data-src", samplePng);
    await expect.poll(() => naturalWidth(page)).toBeGreaterThan(0);
  });

  test("resolves a relative image path against the rendered file's directory", async ({ page }) => {
    const { pushFile } = await import("../dist/web.js");
    const dir = await mkdtemp(join(tmpdir(), "mdv-view-"));
    await writeFile(join(dir, "pic.svg"), SVG_FIXTURE);
    const doc = join(dir, "doc.md");
    await writeFile(doc, "# Doc\n\n![pic](./pic.svg)\n");
    try {
      await pushFile(doc, "/");
      await page.goto(baseUrl);
      await expect(page.locator("#content img")).toBeVisible();
      await expect.poll(() => naturalWidth(page)).toBe(40);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("leaves remote and data URLs untouched", async ({ page }) => {
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(SVG_FIXTURE).toString("base64")}`;
    pushContent(`![remote](https://example.com/a.png)\n\n![inline](${dataUrl})\n`, "/");
    await page.goto(baseUrl);

    const srcs = await page.locator("#content img").evaluateAll((els) =>
      els.map((el) => el.getAttribute("src")),
    );
    expect(srcs[0]).toBe("https://example.com/a.png");
    expect(srcs[1]).toBe(dataUrl);
    // The inline SVG must actually decode — proof the data URL survived intact.
    await expect
      .poll(() =>
        page.locator("#content img").nth(1).evaluate((el) => (el as HTMLImageElement).naturalWidth),
      )
      .toBe(40);
  });

  test("renders a file:// URL, which markdown-it blocks by default", async ({ page }) => {
    pushContent(`![shot](file://${samplePng})\n`, "/");
    await page.goto(baseUrl);

    await expect(page.locator("#content img")).toHaveAttribute("src", /^\/__mdv\/image\?src=/);
    await expect.poll(() => naturalWidth(page)).toBeGreaterThan(0);
  });

  test("still refuses a javascript: image src", async ({ page }) => {
    pushContent("![x](javascript:alert(1))\n", "/");
    await page.goto(baseUrl);

    await expect(page.locator("#content p")).toBeVisible();
    await expect(page.locator("#content img")).toHaveCount(0);
  });

  test("rewrites raw <img> tags in the markdown too", async ({ page }) => {
    pushContent(`<img src="${samplePng}" alt="raw">\n`, "/");
    await page.goto(baseUrl);

    await expect(page.locator("#content img")).toHaveAttribute("src", /^\/__mdv\/image\?src=/);
    await expect.poll(() => naturalWidth(page)).toBeGreaterThan(0);
  });

  test("shows the authored path when an image fails to load", async ({ page }) => {
    pushContent("![missing](/nope/not-here.png)\n", "/");
    await page.goto(baseUrl);

    const err = page.locator("#content .img-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText("Image failed to load");
    await expect(err.locator("code")).toHaveText("/nope/not-here.png");
    await expect(err).toContainText("missing");
    await expect(page.locator("#content img")).toHaveCount(0);
  });

  test("a standalone image is framed and zoomable; an inline one is not", async ({ page }) => {
    pushContent(`![alone](${samplePng})\n\ntext ![badge](${samplePng}) more text\n`, "/");
    await page.goto(baseUrl);

    const images = page.locator("#content img");
    await expect(images).toHaveCount(2);
    await expect(images.nth(0)).toHaveClass(/standalone/);
    await expect(images.nth(1)).not.toHaveClass(/standalone/);
    expect(await images.nth(0).evaluate((el) => getComputedStyle(el).cursor)).toBe("zoom-in");
    expect(await images.nth(1).evaluate((el) => getComputedStyle(el).cursor)).not.toBe("zoom-in");
    expect(await images.nth(0).evaluate((el) => getComputedStyle(el).display)).toBe("block");
    expect(await images.nth(1).evaluate((el) => getComputedStyle(el).display)).toBe("inline");
  });

  test("a linked image stays a link, not a zoom target", async ({ page }) => {
    pushContent(`[![badge](${samplePng})](https://example.com)\n`, "/");
    await page.goto(baseUrl);

    await expect(page.locator("#content a img")).toHaveCount(1);
    await expect(page.locator("#content img")).not.toHaveClass(/standalone/);
  });

  test("clicking a standalone image opens the lightbox, Escape closes it", async ({ page }) => {
    pushContent(`![shot](${samplePng})\n`, "/");
    await page.goto(baseUrl);
    await expect.poll(() => naturalWidth(page)).toBeGreaterThan(0);

    await expect(page.locator("#lightbox")).toBeHidden();
    await page.locator("#content img").click();
    await expect(page.locator("#lightbox")).toBeVisible();
    await expect(page.locator("#lightbox img")).toHaveAttribute("src", /__mdv\/image/);

    await page.keyboard.press("Escape");
    await expect(page.locator("#lightbox")).toBeHidden();
  });

  test("clicking an inline image does not open the lightbox", async ({ page }) => {
    pushContent(`text ![badge](${samplePng}) more\n`, "/");
    await page.goto(baseUrl);
    await expect.poll(() => naturalWidth(page)).toBeGreaterThan(0);

    await page.locator("#content img").click();
    await expect(page.locator("#lightbox")).toBeHidden();
  });
});

test.describe("PDF export", () => {
  test("waits for images to load before sizing the page", async ({ page }) => {
    pushContent(`# With an image\n\n![shot](${samplePng})\n`, "/");
    await page.goto(baseUrl);

    await page.evaluate(() => {
      (window as unknown as { __rule: string }).__rule = "";
      window.print = () => {
        const ps = document.getElementById("dynamic-page-size");
        (window as unknown as { __rule: string }).__rule = ps?.textContent ?? "";
      };
    });

    // Click without waiting for the image, so the export itself has to.
    await page.locator("#pdf-button").click();
    await expect(page.locator("#pdf-button")).toBeEnabled();

    const rule = await page.evaluate(() => (window as unknown as { __rule: string }).__rule);
    const height = Number(rule.match(/size:\s*\d+px\s+(\d+)px/)![1]);
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    // The image is tall; if the snapshot had been taken before it loaded, the
    // page would have been sized to the heading alone.
    expect(height).toBeGreaterThanOrEqual(scrollHeight);
  });

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
