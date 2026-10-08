import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const script = (await readFile(new URL("../runtime/internet-angel-extension.js", import.meta.url), "utf8"))
  .replace("__INTERNET_ANGEL_EXTENSION_ENABLED_JSON__", "true");
const css = await readFile(new URL("../runtime/internet-angel-extension.css", import.meta.url), "utf8");
const browserOptions = {
  skip: process.env.DREAM_SKIN_MODERN_REVIEW_BROWSER !== "1"
    ? "opt in with DREAM_SKIN_MODERN_REVIEW_BROWSER=1 and installed Playwright/Chromium" : false,
};

function card(id, modern, review = modern ? "查看变更" : "Review") {
  return `<section id="${id}" class="rounded-lg ${modern ? "[--resource-card-row-padding-x:0.75rem]" : "[--thread-resource-card-row-padding-x:0.75rem]"}">
    <div class="group/turn-diff-header"><span class="size-10 rounded-lg"><svg></svg></span>
      <span class="font-medium ${modern ? "text-default" : "text-token-foreground"}">${modern ? "已编辑 2 个文件" : "Edited 2 files"}</span>
      <span class="turn-diff-default-subtitle"><span class="text-codex-git-added">+44</span><span class="text-codex-git-deleted">-3</span></span>
      <div class="actions"><button disabled>Undo</button><button>${review}</button></div>
    </div><div class="flex flex-col border-t">
      <div class="${modern ? "group/turn-diff-file-row" : "thread-diff-virtualized"}"><button aria-expanded="false">
        <span class="min-w-0 flex-1 items-center">sample.js</span><span class="tabular-nums"><span class="git-decoration-added">+44</span><span class="git-decoration-deleted">-3</span></span>
      </button></div>
    </div></section>`;
}

function reviewPanel(id) {
  return `<div role="tabpanel" id="${id}" class="review-panel">
    <div data-app-action-review-scroll class="electron:bg-surface" style="overflow-y:auto;height:300px">
      <div data-review-path="sample.js"><div class="sticky" style="position:sticky;top:0">
        <button data-app-action-review-file-toggle data-app-action-review-file-expanded="false" aria-expanded="false">sample.js</button>
        <span class="text-codex-git-added">+44</span><span class="text-codex-git-deleted">-3</span>
      </div><div style="height:600px">Synthetic file body</div></div>
    </div></div>`;
}

async function launch() {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  return chromium.launch({ headless: true,
    ...(process.env.DREAM_SKIN_BROWSER_EXECUTABLE ? { executablePath: process.env.DREAM_SKIN_BROWSER_EXECUTABLE } : {}),
  });
}

async function setup(browser, content) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(`<html data-dream-skin="active" data-dream-theme="internet-angel"><head><style>
    html { --dream-text:#eee;--dream-text-muted:#bbb;--dream-surface:#19184e;--dream-surface-raised:#312074;--dream-line-soft:#45567a;--dream-accent:#63f4ff; }
    .review-panel { width:400px;height:320px; }
    [data-app-action-review-scroll] { background:rgb(24,24,24); }
    .text-codex-git-added,.git-decoration-added { color:rgb(30,200,80); }
    .text-codex-git-deleted,.git-decoration-deleted { color:rgb(240,60,60); }
    button:disabled {opacity:.4;pointer-events:none;}
  </style></head><body>${content}</body></html>`);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  return page;
}

test("modern and legacy edited cards theme their file rows and preserve native colors and controls", browserOptions, async () => {
  const browser = await launch();
  try {
    const page = await setup(browser, card("modern", true) + card("legacy", false));
    for (const light of [false, true]) {
      const result = await page.evaluate(light => {
        document.documentElement.classList.toggle("dream-theme-light", light);
        return [...document.querySelectorAll("section")].map(node => ({
          marker: node.dataset.angelComponent,
          rows: node.querySelectorAll('[data-angel-component="edited-card-file-row"]').length,
          filesBackground: getComputedStyle(node.querySelector('[data-angel-component="edited-card-files"]')).backgroundImage,
          review: node.querySelector('[data-angel-component="edited-card-review"]').textContent,
          counts: [...node.querySelectorAll('[class*="git-added"],[class*="git-deleted"],[class*="git-decoration-"]')].map(el => getComputedStyle(el).color),
          disabled: node.querySelector("button:disabled").disabled,
          pointer: getComputedStyle(node.querySelector("button:disabled")).pointerEvents,
          expanded: node.querySelector('[data-angel-component="edited-card-file-row"]').getAttribute("aria-expanded"),
        }));
      }, light);
      for (const entry of result) {
        assert.equal(entry.marker, "edited-card");
        assert.equal(entry.rows, 1);
        assert.match(entry.filesBackground, /linear-gradient/);
        assert.deepEqual(entry.counts, ["rgb(30, 200, 80)", "rgb(240, 60, 60)", "rgb(30, 200, 80)", "rgb(240, 60, 60)"]);
        assert.equal(entry.disabled, true);
        assert.equal(entry.pointer, "none");
        assert.equal(entry.expanded, "false");
      }
    }
    for (const caption of ["View changes", "查看更改", "查看变更"]) {
      await page.evaluate(html => { document.body.innerHTML = html; }, card("localized", true, caption));
      await page.waitForFunction(() => document.querySelector('[data-angel-component="edited-card-review"]'));
    }
  } finally { await browser.close(); }
});

test("Changes native scroller themes through mount/removal and preserves scrolling and sticky controls", browserOptions, async () => {
  const browser = await launch();
  try {
    // An outer main is a shell for both chat and auxiliary panes, not a reason
    // to exclude the Changes tabpanel.
    const page = await setup(browser, `<main id="app" class="main-surface _MainContentSurface_current_2"><div class="thread-scroll-container">Synthetic transcript sibling</div><div id="mount"></div></main>`);
    await page.evaluate(html => { document.getElementById("mount").innerHTML = html; }, reviewPanel("review"));
    await page.waitForFunction(() => document.querySelector('[data-angel-component="review-scroll"]'));
    const result = await page.evaluate(() => {
      const panel = document.getElementById("review"), scroll = panel.querySelector('[data-app-action-review-scroll]');
      scroll.scrollTop = 50;
      return {
        panel: panel.dataset.angelComponent, scroll: scroll.dataset.angelComponent,
        image: getComputedStyle(scroll).backgroundImage, overflow: getComputedStyle(scroll).overflowY, top: scroll.scrollTop,
        file: scroll.querySelector('[data-review-path]').dataset.angelComponent,
        sticky: getComputedStyle(scroll.querySelector('.sticky')).position,
        expanded: scroll.querySelector('button').getAttribute('aria-expanded'),
        colors: [...scroll.querySelectorAll('[class*="git-added"],[class*="git-deleted"]')].map(node => getComputedStyle(node).color),
      };
    });
    assert.equal(result.panel, "side-workspace"); assert.equal(result.scroll, "review-scroll");
    assert.equal(result.file, "review-file"); assert.match(result.image, /linear-gradient/);
    assert.equal(result.overflow, "auto"); assert.equal(result.top, 50);
    assert.equal(result.sticky, "sticky"); assert.equal(result.expanded, "false");
    assert.deepEqual(result.colors, ["rgb(30, 200, 80)", "rgb(240, 60, 60)"]);
    await page.evaluate(() => {
      document.querySelector('[data-app-action-review-scroll]').removeAttribute('data-app-action-review-scroll');
      window.__CODEX_INTERNET_ANGEL_EXTENSION_STATE__.refresh();
    });
    assert.equal(await page.locator('[data-angel-component]').count(), 0, "loss of native anchor clears all review marks");
    await page.evaluate(html => { document.getElementById('mount').innerHTML = html; }, reviewPanel('second'));
    await page.waitForFunction(() => document.querySelector('[data-angel-component="review-scroll"]'));
    await page.evaluate(() => document.getElementById('mount').setAttribute('data-app-shell-active-page', 'false'));
    await page.waitForFunction(() => !document.querySelector('[data-angel-component="review-scroll"]'));
    await page.evaluate(() => document.getElementById('mount').setAttribute('data-app-shell-active-page', 'true'));
    await page.waitForFunction(() => document.querySelector('[data-angel-component="review-scroll"]'));
    await page.evaluate(() => window.__CODEX_INTERNET_ANGEL_EXTENSION_STATE__.cleanup());
    assert.equal(await page.locator('[data-angel-component]').count(), 0);
    await page.evaluate(() => {
      document.body.innerHTML = '<main class="main-surface _MainContentSurface_current_2"><aside><div id="legacyPane" class="bg-token-main-surface-primary" style="width:400px;height:320px"><div role="tabpanel">Legacy auxiliary pane</div></div></aside></main>';
    });
    await page.addScriptTag({ content: script });
    assert.equal(await page.locator('#legacyPane').getAttribute('data-angel-component'), 'side-workspace',
      'legacy right pane remains eligible beneath the shared recognized main shell');
  } finally { await browser.close(); }
});

test("review adaptation excludes unrelated panes, conversation containment and retained hidden pages", browserOptions, async () => {
  const browser = await launch();
  try {
    const page = await setup(browser, `<main class="main-surface"><div class="thread-scroll-container"><div class="[contain:layout_paint]"><div class="thread-scroll-container"></div></div>${reviewPanel("conversation")}</div></main>
      <aside class="app-shell-left-panel">${reviewPanel("sidebar")}</aside>
      <div hidden>${reviewPanel("hidden")}${card("hiddenCard", true)}</div>
      <div aria-hidden="true">${reviewPanel("ariaHidden")}</div>
      <div inert>${reviewPanel("inert")}</div>
      <div data-app-shell-active-page="false">${reviewPanel("inactive")}${card("inactiveCard", true)}</div>
      <div role="tabpanel" id="browser">Browser surface</div><div role="tabpanel" id="terminal"><div class="xterm"></div></div>`);
    const result = await page.evaluate(() => ({
      review: document.querySelectorAll('[data-angel-component="review-scroll"]').length,
      workspace: document.querySelectorAll('[data-angel-component="side-workspace"]').length,
      edited: document.querySelectorAll('[data-angel-component="edited-card"]').length,
    }));
    assert.deepEqual(result, { review: 0, workspace: 0, edited: 0 });
  } finally { await browser.close(); }
});
