#!/usr/bin/env node
/** icon.svg -> PNG (PWA ikonları). Kullanım: node tools/make-icons.mjs */
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = await readFile(join(ROOT, "icons/icon.svg"), "utf8");

const browser = await chromium.launch();
const page = await browser.newPage();

async function shot(size, file, { maskable = false } = {}) {
  const inner = maskable
    ? `<div style="background:#0b0f14;width:${size}px;height:${size}px;display:grid;place-items:center">
         <div style="width:${Math.round(size * 0.72)}px;height:${Math.round(size * 0.72)}px">${svg}</div>
       </div>`
    : svg;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:100%;height:100%;display:block}</style>${inner}`,
    { waitUntil: "load" }
  );
  const buf = await page.screenshot({ omitBackground: true });
  await writeFile(join(ROOT, "icons", file), buf);
  console.log("✓", file, `${size}px`);
}

await shot(192, "icon-192.png");
await shot(512, "icon-512.png");
await shot(512, "icon-maskable-512.png", { maskable: true });
await browser.close();
