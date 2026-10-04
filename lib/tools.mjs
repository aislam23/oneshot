// oneshot · MIT © 2026 Artem Islamov — stills, fonts, doctor, new
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openComp, run, has, log, die } from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// контактный лист: кадры в выбранные моменты + сетка
export async function stills(comp, o) {
  const times = String(o.times || '').split(',').filter(Boolean).map(Number); if (!times.length) die('укажите --times 1,4.5,9');
  const dir = resolve(o.dir || 'stills'); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const browser = await launch(); const { page, errors } = await openComp(browser, comp, { query: '?hud' });
  for (let i = 0; i < times.length; i++) { await page.evaluate(t => window.oneshot.seek(t), times[i]); await page.screenshot({ path: join(dir, `${String(i).padStart(2, '0')}_${times[i]}s.png`) }); }
  await browser.close();
  const cols = Number(o.cols || 3), rows = Math.ceil(times.length / cols);
  const sheet = resolve(o.out || join(dir, 'sheet.png'));
  await run('ffmpeg', ['-y', '-v', 'error', '-framerate', '1', '-pattern_type', 'glob', '-i', join(dir, '*s.png'), '-vf', `scale=640:-1,tile=${cols}x${rows}:padding=4:color=black`, '-frames:v', '1', sheet]);
  log(`stills: ${times.length} кадров → ${sheet}` + (errors.length ? `\n  ошибки страницы: ${errors.slice(0, 3).join(' | ')}` : ''));
}

// шрифты Google внутрь fonts.css (base64), чтобы file://-страница и рендер видели настоящий шрифт
// oneshot fonts "Golos Text:400;600" "Sofia Sans Extra Condensed:800;900" --out fonts.css
export async function fonts(families, o) {
  if (!families.length) die('укажите семейства, например: oneshot fonts "Golos Text:400;600"');
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
  const keep = (o.subsets || 'cyrillic,latin').split(',');
  let css = '/* создано `oneshot fonts` — шрифты Google Fonts (лицензия OFL), встроены в файл */\n';
  for (const fam of families) {
    const [name, w] = fam.split(':'); const q = `family=${encodeURIComponent(name).replace(/%20/g, '+')}${w ? ':wght@' + w : ''}`;
    const r = await fetch(`https://fonts.googleapis.com/css2?${q}&display=block`, { headers: { 'User-Agent': UA } }); if (!r.ok) die(`Google Fonts не знает «${name}» (${r.status})`);
    const src = await r.text(); const blocks = src.split('/* ').slice(1).map(b => ({ subset: b.slice(0, b.indexOf(' */')), body: b.slice(b.indexOf('*/') + 2) }));
    for (const b of blocks.filter(b => keep.includes(b.subset))) {
      const url = (b.body.match(/url\((https:[^)]+)\)/) || [])[1]; if (!url) continue;
      const data = Buffer.from(await (await fetch(url)).arrayBuffer()).toString('base64');
      css += `/* ${name} · ${b.subset} */` + b.body.replace(url, `data:font/woff2;base64,${data}`).trim() + '\n';
    }
    log(`fonts: ${name} ${w || ''} ✓`);
  }
  const out = resolve(o.out || 'fonts.css'); writeFileSync(out, css); log('fonts → ' + out);
}

export async function doctor() {
  const row = (ok, name, hint) => log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  → ' + hint}`);
  const major = +process.versions.node.split('.')[0]; row(major >= 18, `Node ${process.versions.node}`, 'нужен Node 18+ (nodejs.org)');
  row(has('ffmpeg'), 'ffmpeg', 'macOS: brew install ffmpeg · Windows: winget install ffmpeg · Linux: apt install ffmpeg');
  row(has('ffprobe'), 'ffprobe', 'ставится вместе с ffmpeg');
  row(existsSync(join(ROOT, 'node_modules/gsap')), 'gsap', `cd ${ROOT} && npm install`);
  let chrome = false; try { const b = await launch(); await b.close(); chrome = true; } catch { /* нет браузера */ }
  row(chrome, 'Chromium для Playwright', `cd ${ROOT} && npx playwright install chromium`);
  row(has('say'), 'say (черновой голос, только macOS)', 'не обязательно: без него тайминг оценивается по длине текста');
}

// положить свежие gsap.min.js и oneshot.js в папку ролика (после клонирования примера или обновления скилла)
export async function vendor(dir) {
  const target = resolve(dir || '.'); mkdirSync(join(target, 'vendor'), { recursive: true });
  cpSync(join(ROOT, 'node_modules/gsap/dist/gsap.min.js'), join(target, 'vendor/gsap.min.js'));
  cpSync(join(ROOT, 'lib/oneshot.js'), join(target, 'vendor/oneshot.js'));
  log('vendor → ' + join(target, 'vendor'));
}

// новый ролик из шаблона
export async function create(dir, o) {
  const target = resolve(dir || 'film'); if (existsSync(target) && readdirSync(target).length && !o.force) die(`${target} не пуст (добавьте --force)`);
  cpSync(join(ROOT, 'templates/film'), target, { recursive: true });
  await vendor(target);
  log(`новый ролик: ${target}\n  дальше: напишите текст диктора в vo/lines.txt и запустите\n  node ${join(ROOT, 'bin/oneshot.mjs')} vo plan ${join(target, 'vo/lines.txt')}`);
}
