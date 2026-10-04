// oneshot · MIT © 2026 Artem Islamov
// snap — снимки ключевых кадров до и после правки. Правка в одной сцене часто ломает другую; snap показывает, что
// изменилось во всём ролике, а не только там, куда вы смотрели.
//   oneshot snap comp.html            первый запуск — эталон; дальше — сравнение с эталоном
//   oneshot snap comp.html --update   принять текущее состояние как новый эталон
//   oneshot snap comp.html --step 2   шаг кадров (с), по умолчанию 2
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { launch, openComp, run, log, num } from './util.mjs';

export async function snap(comp, o) {
  const dir = join(dirname(resolve(comp)), '.oneshot', 'snaps', basename(comp, '.html')), base = join(dir, 'base'), cur = join(dir, 'current');
  const browser = await launch(); const { page, meta } = await openComp(browser, comp);
  const step = num(o.step, 2), times = []; for (let t = 0.5; t < meta.duration; t += step) times.push(+t.toFixed(2));
  const update = o.update || !existsSync(join(base, 'meta.json'));
  const target = update ? base : cur; rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
  for (const t of times) { await page.evaluate(x => window.oneshot.seek(x), t); await page.screenshot({ path: join(target, `${t.toFixed(2)}.png`) }); }
  writeFileSync(join(target, 'meta.json'), JSON.stringify({ times, at: new Date().toISOString() }));
  if (update) { await browser.close(); log(`snap: эталон — ${times.length} кадров (каждые ${step} с) → ${base}`); return; }
  // сравнение в браузере: доля пикселей, отличающихся заметно
  const cmp = await browser.newPage();
  const changed = [];
  for (const t of JSON.parse(readFileSync(join(base, 'meta.json'), 'utf8')).times) {
    const a = join(base, `${t.toFixed(2)}.png`), b = join(cur, `${t.toFixed(2)}.png`); if (!existsSync(b)) continue;
    const share = await cmp.evaluate(async ([A, B]) => {
      const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });
      const [ia, ib] = await Promise.all([load(A), load(B)]), w = 480, h = 270, c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      g.drawImage(ia, 0, 0, w, h); const da = g.getImageData(0, 0, w, h).data; g.drawImage(ib, 0, 0, w, h); const db = g.getImageData(0, 0, w, h).data;
      let n = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60) n++;
      return n / (w * h);
    }, ['data:image/png;base64,' + readFileSync(a).toString('base64'), 'data:image/png;base64,' + readFileSync(b).toString('base64')]);
    if (share > 0.002) { changed.push({ t, share }); await run('ffmpeg', ['-y', '-v', 'error', '-i', a, '-i', b, '-filter_complex', '[0][1]blend=all_mode=difference,eq=brightness=0.06:contrast=3,scale=960:-1', join(cur, `diff_${t.toFixed(2)}.png`)]); }
  }
  await browser.close();
  if (!changed.length) log(`snap: изменений нет (${times.length} кадров совпали с эталоном)`);
  else { log(`snap: изменились ${changed.length} кадров из ${times.length} — проверьте, что это только то, что вы правили:`);
    for (const c of changed) log(`  ${c.t.toFixed(2)} с — ${(c.share * 100).toFixed(1)} % кадра → ${join(cur, `diff_${c.t.toFixed(2)}.png`)}`);
    log('  принять как новый эталон: oneshot snap comp.html --update'); }
  return changed;
}
