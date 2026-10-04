// oneshot · MIT © 2026 Artem Islamov — общие помощники для команд
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

export const log = (...a) => console.log(...a);
export const die = msg => { console.error('oneshot: ' + msg); process.exit(1); };

export function has(cmd) { return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd]).status === 0; }

export function run(cmd, args, { input, quiet = true } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = '';
    p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
    p.on('close', code => (code === 0 ? ok({ out, err }) : fail(new Error(`${cmd} ${args.slice(0, 6).join(' ')}… → ${code}\n${err.slice(-1500)}`))));
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

export async function launch() { return chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text'] }); }

// открывает композицию и ждёт window.oneshot.ready
export async function openComp(browser, comp, { scale = 1, query = '' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(resolve(comp)).href + query);
  try { await page.waitForFunction(() => window.oneshot && window.oneshot.ready, null, { timeout: 20000 }); }
  catch { throw new Error('страница не объявила window.oneshot (забыли F.expose()?)\n' + errors.join('\n')); }
  await page.evaluate(() => window.oneshot.ready);
  const meta = await page.evaluate(() => ({ duration: oneshot.duration, fps: oneshot.fps, width: oneshot.width, height: oneshot.height, cuts: oneshot.cuts || [], beats: oneshot.beats || [] }));
  if (meta.width !== 1920 || meta.height !== 1080) await page.setViewportSize({ width: meta.width, height: meta.height });
  return { page, meta, errors };
}

export function args(argv, spec) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (v !== undefined) o[key] = v; else if (spec?.flags?.includes(key)) o[key] = true; else o[key] = argv[++i]; }
    else o._.push(a);
  }
  return o;
}
export const num = (v, d) => (v === undefined ? d : Number(v));

// библиотека ролика (lib/oneshot.js) в Node: физика и кривые для галереи и замеров
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
export function runtime() {
  const sb = { Math, console }; vm.createContext(sb);
  vm.runInContext(readFileSync(new URL('./oneshot.js', import.meta.url), 'utf8'), sb);
  return sb.OS;
}
