// oneshot · MIT © 2026 Artem Islamov
// check — проверка ролика до того, как его увидит человек.
//   oneshot check comp.html [--video draft.mp4]
// По композиции: нить на каждом переходе, ритм сцен, объекты в кадре, размер текста.
// По видео (если дано): передышки (доля неподвижных кадров), длительность, громкость.
import { existsSync, writeFileSync } from 'node:fs';
import { launch, openComp, run, log, num } from './util.mjs';

const mark = { PASS: '  ОК   ', WARN: ' ВНИМ. ', FAIL: ' ПРОВАЛ' };

export async function check(comp, o) {
  const legs = []; const leg = (name, status, msg) => legs.push({ name, status, msg });
  const browser = await launch(); const { page, meta, errors } = await openComp(browser, comp);
  const W = meta.width, H = meta.height, diag = Math.hypot(W, H);
  const beats = meta.beats;

  // 1 · нить на каждом переходе
  if (beats.length < 2) leg('нить', 'WARN', 'размечено меньше двух переходов (F.beat) — проверять нечего');
  else {
    const bad = [], ok = [];
    for (const b of beats.slice(1)) {
      if (b.cut) { ok.push(`${b.t.toFixed(2)} склейка (объявлена)`); continue; }
      if (!b.thread) { bad.push(`${b.t.toFixed(2)} «${b.name}»: у перехода нет нити`); continue; }
      const [A, B] = await page.evaluate(([t, id]) => [window.oneshot.inspect(t - 0.3).threads[id], window.oneshot.inspect(t + 0.3).threads[id]], [b.t, b.thread]);
      const seen = r => r && r.op > 0.3 && r.x + r.w > 0 && r.x < W && r.y + r.h > 0 && r.y < H && r.w * r.h > 400;
      if (!A || !B) { bad.push(`${b.t.toFixed(2)} «${b.name}»: нить «${b.thread}» не найдена (F.thread?)`); continue; }
      if (!seen(A) || !seen(B)) { bad.push(`${b.t.toFixed(2)} «${b.name}»: нить «${b.thread}» не видна ${!seen(A) ? 'до' : 'после'} перехода`); continue; }
      const moved = Math.hypot(A.x + A.w / 2 - B.x - B.w / 2, A.y + A.h / 2 - B.y - B.h / 2) / diag, sc = Math.abs(Math.log((B.w * B.h + 1) / (A.w * A.h + 1))) / 2;
      ok.push(`${b.t.toFixed(2)} «${b.name}» → ${b.thread} ${moved > 0.025 || sc > 0.1 ? 'несёт' : 'держит'}`);
    }
    leg('нить', bad.length ? 'FAIL' : 'PASS', bad.length ? bad.join('\n          ') : `${ok.length} переходов, у каждого есть нить`);
  }

  // 2 · ритм: длины сцен должны отличаться
  if (beats.length >= 3) {
    const ts = [...beats.map(b => b.t), meta.duration], L = ts.slice(1).map((t, i) => t - ts[i]).filter(x => x > 0.05);
    const m = L.reduce((a, b) => a + b, 0) / L.length, cv = Math.sqrt(L.reduce((a, b) => a + (b - m) ** 2, 0) / L.length) / m, span = Math.max(...L) / Math.min(...L);
    leg('ритм', cv >= 0.3 && span >= 3 ? 'PASS' : cv >= 0.2 ? 'WARN' : 'FAIL', `сцены ${L.map(x => x.toFixed(1)).join(' · ')} с · разброс ${cv.toFixed(2)} (нужно ≥ 0.30), самая длинная / короткая ${span.toFixed(1)}× (нужно ≥ 3)`);
  }

  // 3 · кадр и 4 · текст — пробегаем ролик
  const step = num(o.step, 0.25); const out = [], tiny = {};
  for (let t = 0; t <= meta.duration + 1e-6; t += step) {
    const r = await page.evaluate(([t, texts]) => window.oneshot.inspect(t, { texts }), [t, Math.abs((t / 0.5) - Math.round(t / 0.5)) < 1e-6]);
    for (const k of r.keeps) { const b = k.box; if (!b || b.op < 0.3) continue; const m = 0.02; if (b.x < -W * m || b.y < -H * m || b.x + b.w > W * (1 + m) || b.y + b.h > H * (1 + m)) out.push(`${t.toFixed(2)} ${k.sel}`); }
    // мельче 9px — уже не текст, а фактура (общий план), не считаем
    for (const x of r.texts) { if (x.px >= 9 && x.px < 22) { const e = tiny[x.s] || (tiny[x.s] = { px: x.px, ts: [] }); e.px = Math.min(e.px, x.px); e.ts.push(t); } }
  }
  const outU = [...new Set(out.map(s => s.split(' ')[1]))];
  leg('кадр', out.length ? 'FAIL' : 'PASS', out.length ? `выходят за кадр: ${outU.join(', ')} (например, ${out.slice(0, 3).join('; ')})` : 'всё, что объявлено через F.keep, остаётся в кадре');
  const T = Object.entries(tiny).filter(([, e]) => e.ts.length >= 2);   // текст, который виден хотя бы ~1 с
  const fail = T.filter(([, e]) => e.px < 16);
  leg('текст', fail.length ? 'FAIL' : T.length ? 'WARN' : 'PASS', T.length ? T.slice(0, 8).map(([s, e]) => `«${s}» ${e.px}px около ${e.ts[0].toFixed(1)} с`).join('\n          ') + (T.length > 8 ? `\n          …и ещё ${T.length - 8}` : '') + '\n          (на телефоне читается от ~22px при 1080p; мельче 9px не считаем — это фактура общего плана)' : 'весь заметный текст крупнее 22px');
  await browser.close();
  if (errors.length) leg('страница', 'FAIL', errors.slice(0, 3).join(' | ')); else leg('страница', 'PASS', 'без ошибок в консоли');

  // 5 · по видео
  if (o.video && existsSync(o.video)) {
    const { err } = await run('ffmpeg', ['-v', 'info', '-i', o.video, '-vf', 'scale=192:108,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-']).catch(e => ({ err: String(e) }));
    const vals = [...err.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map(m => +m[1]);
    if (vals.length) {
      const still = vals.map(v => v < 0.35); const share = still.filter(Boolean).length / still.length;
      let best = 0, cur = 0; for (const s of still) { cur = s ? cur + 1 : 0; best = Math.max(best, cur); }
      const fps = meta.fps || 30;
      leg('передышки', share >= 0.15 && best / fps >= 0.8 ? 'PASS' : 'WARN', `неподвижных кадров ${(share * 100).toFixed(0)} % (нужно ≥ 15 %), самая длинная пауза ${(best / fps).toFixed(1)} с (нужно ≥ 0,8)`);
    }
    const dur = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', o.video]).then(r => +r.out.trim());
    leg('длина', Math.abs(dur - meta.duration) < 0.2 ? 'PASS' : 'WARN', `видео ${dur.toFixed(2)} с, композиция ${meta.duration} с`);
    const a = await run('ffmpeg', ['-v', 'info', '-i', o.video, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).catch(e => ({ err: String(e) }));
    const mx = (a.err.match(/max_volume:\s*(-?[\d.]+)/) || [])[1];
    if (mx !== undefined) leg('звук', +mx <= -1 ? 'PASS' : 'FAIL', `пик ${mx} дБ (нужно ≤ −1, иначе хрипит)`);
    else leg('звук', 'WARN', 'в видео нет звуковой дорожки');
  }

  log('');
  for (const l of legs) log(`${mark[l.status]}  ${l.name.padEnd(10)} ${l.msg}`);
  const verdict = legs.some(l => l.status === 'FAIL') ? 'ПРОВАЛ' : legs.some(l => l.status === 'WARN') ? 'ОК С ЗАМЕЧАНИЯМИ' : 'ОК';
  log(`\nИТОГ: ${verdict}`);
  if (o.json) writeFileSync(o.json, JSON.stringify({ verdict, legs }, null, 2));
  return verdict;
}
