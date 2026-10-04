// oneshot · MIT © 2026 Artem Islamov
// check — проверка ролика до того, как его увидит человек.
//   oneshot check comp.html [--video draft.mp4]
// По композиции: переходы (находит сама), подмены, ритм, однообразие, камера, мусор, кадр, текст, код.
// По видео (если дано): передышки (доля неподвижных кадров), длительность, громкость.
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { launch, openComp, run, log, num } from './util.mjs';

const mark = { PASS: '  ОК   ', WARN: ' ВНИМ. ', FAIL: ' ПРОВАЛ' };

export async function check(comp, o) {
  const legs = []; const leg = (name, status, msg) => legs.push({ name, status, msg });
  const browser = await launch(); const { page, meta, errors } = await openComp(browser, comp);
  const W = meta.width, H = meta.height, diag = Math.hypot(W, H);
  const beats = meta.beats;

  // 1 · переходы — находит их сама, по содержимому кадра, а не по разметке автора.
  // Кадр раз в 0,1 с раскладывается на видимые элементы. Граница — где за 0,4 с сменилась бо́льшая часть содержимого.
  // На каждой границе ищем, что её пересекло и изменилось (нить): элемент, который был до и остался после, но сдвинулся,
  // вырос или сменил форму; или камера, которая сама сделала переход (нырок, переброс). Неподвижное «держание» — не нить.
  const S = [];   // [{t, C: Map(id → box)}]
  {
    for (let t = 0; t <= meta.duration + 1e-6; t += 0.1) { const C = await page.evaluate(t => window.oneshot.inspect(t, { content: true }).content, t); S.push({ t: +t.toFixed(2), list: C, C: new Map(C.filter(c => c.op > 0.3).map(c => [c.id, c])) }); }
    const area = M => { let a = 0; for (const c of M.values()) a += c.w * c.h; return a; };
    const ctr = c => [c.x + c.w / 2, c.y + c.h / 2];
    const moved = (a, b) => { const [ax, ay] = ctr(a), [bx, by] = ctr(b); return { mv: Math.hypot(ax - bx, ay - by) / diag, sc: Math.abs(Math.log((b.w * b.h + 1) / (a.w * a.h + 1))) / 2, sh: Math.abs(Math.log(((b.w + 1) / (b.h + 1)) / ((a.w + 1) / (a.h + 1)))) }; };
    // замена между A и B: неподвижные «якоря» (есть и там, и там, не изменились) не считаются;
    // переход — когда заметная часть остального исчезла И заметная часть появилась
    const change = (A, B) => {
      let held = 0; for (const [id, a] of A.C) { const b = B.C.get(id); if (b) { const m = moved(a, b); if (m.mv < 0.01 && m.sc < 0.05 && m.sh < 0.1) held += Math.min(a.w * a.h, b.w * b.h); } }
      const aA = area(A.C) - held, aB = area(B.C) - held; if (aA < W * H * 0.03 || aB < W * H * 0.03) return 0;
      let gone = 0, came = 0; for (const [id, a] of A.C) if (!B.C.has(id)) gone += a.w * a.h; for (const [id, b] of B.C) if (!A.C.has(id)) came += b.w * b.h;
      return Math.min(1, gone / aA, came / aB) >= 0 ? Math.min(gone / aA, came / aB) : 0; };
    const LAGS = [4, 8, 15], ch = S.map((x, i) => { let best = 0, lag = 4; for (const L of LAGS) if (i + L < S.length) { const c = change(x, S[i + L]); if (c > best + 0.05) { best = c; lag = L; } } return { c: best, lag }; });
    const found = [];
    for (let i = 1; i < ch.length - 1; i++) if (ch[i].c >= 0.5 && ch[i].c >= ch[i - 1].c && ch[i].c >= ch[i + 1].c && (!found.length || S[i].t - found[found.length - 1].t > 1.2)) found.push({ i, t: S[i].t, amount: ch[i].c, lag: ch[i].lag });
    const cuts = meta.cuts || [], res = [], bad = [];
    for (const f of found) {
      const A = S[f.i], B = S[Math.min(S.length - 1, f.i + f.lag)], tm = +((A.t + B.t) / 2).toFixed(2);
      if (tm > meta.duration - 1.2) { res.push(`${tm} финал`); continue; }
      if (cuts.some(c => c >= A.t - 0.3 && c <= B.t + 0.3)) { res.push(`${tm} склейка (объявлена)`); continue; }
      // кто пересёк границу и изменился (нить), и из чего выросло новое
      const carriers = [];
      for (const [id, a] of A.C) { const b = B.C.get(id); if (!b) continue; const m = moved(a, b);
        if (m.mv > 0.025 || m.sc > 0.12 || m.sh > 0.2) carriers.push({ name: a.name + (a.txt ? ` «${a.txt.slice(0, 14)}»` : ''), box: b, from: a }); }
      // передача на месте, в том числе цепочкой (печать → фигуры → буквы): исчезающий элемент и появляющийся стоят в одной
      // точке в момент передачи; промежуточные элементы, живущие только внутри окна, тоже звенья цепи
      const win = S.slice(f.i, Math.min(S.length, f.i + f.lag + 1)), firstS = new Map(), lastS = new Map();
      for (const x of win) for (const [id, c] of x.C) { if (!firstS.has(id)) firstS.set(id, { c, t: x.t }); lastS.set(id, { c, t: x.t }); }
      const close = (g, a) => { const [gx, gy] = ctr(g), [ax, ay] = ctr(a); return Math.hypot(gx - ax, gy - ay) < Math.max(g.w, g.h, a.w, a.h) * 0.6 + 20; };
      const goneIds = [...A.C.keys()].filter(id => !B.C.has(id)), cameIds = [...B.C.keys()].filter(id => !A.C.has(id));
      const reach = new Set(goneIds), queue = [...goneIds], via = new Map();
      while (queue.length) { const g = queue.shift(), L = lastS.get(g) || { c: A.C.get(g), t: A.t };
        for (const [id, F0] of firstS) { if (reach.has(id) || A.C.has(id) || F0.t < L.t - 0.15 || !close(L.c, F0.c)) continue; reach.add(id); via.set(id, g); queue.push(id); } }
      const handoffs = cameIds.filter(id => reach.has(id)).map(id => { let r = id, chain = [B.C.get(id).name]; while (via.has(r)) { r = via.get(r); const n = (A.C.get(r) || firstS.get(r)?.c || {}).name; chain.unshift(n); } return { name: chain.slice(0, 4).join(' → '), box: B.C.get(id) }; });
      // новое объяснено, если появилось на месте нити/передачи или вплотную к ним (выросло из них)
      const near = (c, k) => c.x < k.x + k.w + 90 && c.x + c.w > k.x - 90 && c.y < k.y + k.h + 90 && c.y + c.h > k.y - 90;
      const sources = [...carriers.map(c => c.box), ...carriers.map(c => c.from), ...handoffs.map(h => h.box)];
      let came = 0, explained = 0; for (const [id, b] of B.C) if (!A.C.has(id)) { came += b.w * b.h; if (sources.some(k => near(b, k))) explained += b.w * b.h; }
      const share = came ? explained / came : 1;
      const [ca, cb] = await page.evaluate(([x, y]) => [window.oneshot.cam(x), window.oneshot.cam(y)], [Math.max(0, A.t - 0.4), B.t + 0.4]);
      const camMove = Math.abs(Math.log(cb.zoom / ca.zoom)) > 0.25 || Math.hypot(cb.x - ca.x, cb.y - ca.y) * Math.min(ca.zoom, cb.zoom) / diag > 0.08;
      const by = carriers[0]?.name || handoffs[0]?.name;
      if (camMove) res.push(`${tm} → камера${by ? ' + ' + by : ''}`);
      else if (by && share >= 0.3) res.push(`${tm} → ${carriers.length ? by : 'передача на месте (' + by + ')'}`);
      else if (by) bad.push(`${tm} с: «${by}» двигается, но новое появилось не из него (${Math.round((1 - share) * 100)} % нового — в другом месте) — якорь, а вокруг перелистывание`);
      else bad.push(`${tm} с: сменилось ${Math.round(f.amount * 100)} % кадра и ничего не перешло через границу — перелистывание`);
    }
    leg('переходы', bad.length ? 'FAIL' : 'PASS', (bad.length ? bad.join('\n          ') + '\n          ' : '') + `найдено ${found.length} переходов по содержимому кадра (разметка не нужна); нити: ${res.slice(0, 8).join(' · ')}${res.length > 8 ? ' …' : ''}`);
  }

  // 1б · подмены: один элемент гаснет, другой проявляется на его месте (оба полупрозрачны одновременно) — наплыв, а не превращение
  {
    const swaps = [];
    for (let k = 1; k < S.length; k++) {
      const C = S[k].list, P = new Map(S[k - 1].list.map(c => [c.id, c])), t = S[k].t;
      const fadingOut = C.filter(c => P.has(c.id) && c.op < 0.9 && c.op > 0.08 && c.op < P.get(c.id).op - 0.02);
      const fadingIn = C.filter(c => c.op < 0.9 && c.op > 0.08 && (!P.has(c.id) || c.op > P.get(c.id).op + 0.02));
      for (const g of fadingOut) for (const a of fadingIn) {
        if (g.id === a.id) continue;
        const ix = Math.max(0, Math.min(g.x + g.w, a.x + a.w) - Math.max(g.x, a.x)), iy = Math.max(0, Math.min(g.y + g.h, a.y + a.h) - Math.max(g.y, a.y));
        const inter = ix * iy, iou = inter / (g.w * g.h + a.w * a.h - inter);
        const sameText = g.txt && g.txt.length > 1 && g.txt === a.txt;   // тот же текст гаснет в одном элементе и проявляется в другом
        if ((iou > 0.2 && Math.min(g.w * g.h, a.w * a.h) > W * H * 0.01) || sameText) swaps.push({ t, g: g.name + (g.txt ? ` «${g.txt}»` : ''), a: a.name });
      }
    }
    const uniq = []; for (const s of swaps) if (!uniq.some(u => Math.abs(u.t - s.t) < 0.8)) uniq.push(s);
    leg('подмены', uniq.length ? 'FAIL' : 'PASS', uniq.length ? uniq.slice(0, 8).map(s => `${s.t.toFixed(1)} с: «${s.g}» гаснет, «${s.a}» проявляется на его месте`).join('\n          ') + '\n          (пусть сам элемент превратится: F.morph, F.scramble, смена содержимого внутри движущегося контейнера)' : 'нет наплывов одного элемента в другой');
  }

  // 2 · ритм: длины сцен должны отличаться
  if (beats.length >= 3) {
    const ts = [...beats.map(b => b.t), meta.duration], L = ts.slice(1).map((t, i) => t - ts[i]).filter(x => x > 0.05);
    const m = L.reduce((a, b) => a + b, 0) / L.length, cv = Math.sqrt(L.reduce((a, b) => a + (b - m) ** 2, 0) / L.length) / m, span = Math.max(...L) / Math.min(...L);
    leg('ритм', cv >= 0.3 && span >= 3 ? 'PASS' : cv >= 0.2 ? 'WARN' : 'FAIL', `сцены ${L.map(x => x.toFixed(1)).join(' · ')} с · разброс ${cv.toFixed(2)} (нужно ≥ 0.30), самая длинная / короткая ${span.toFixed(1)}× (нужно ≥ 3)`);
  }

  // 2б · однообразие: один и тот же жест в разные моменты ролика. Каскад (тот же жест на нескольких элементах
  // в пределах 0,6 с) считается одним использованием.
  const G = await page.evaluate(() => (window.oneshot.gestures ? window.oneshot.gestures() : []));
  if (G.length) {
    const uses = {};
    for (const g of G.slice().sort((a, b) => a.t - b.t)) { const u = uses[g.sig] || (uses[g.sig] = []); if (!u.length || g.t - u[u.length - 1] > 0.6) u.push(g.t); }
    const top = Object.entries(uses).map(([sig, u]) => ({ sig, n: u.length })).sort((a, b) => b.n - a.n);
    const kinds = top.length, worst = top[0], perMin = meta.duration >= 40 ? worst.n / (meta.duration / 60) : 0;   // на коротком ролике «в минуту» не считаем
    const nice = s => s.replace(/\|/g, ' ').replace(/[{}"]/g, '').slice(0, 70);
    const status = worst.n > 20 || perMin > 14 ? 'FAIL' : worst.n > 12 || perMin > 9 ? 'WARN' : 'PASS';
    leg('однообразие', status, `${kinds} разных жестов; чаще всего «${nice(worst.sig)}» — ${worst.n} раз` + (status !== 'PASS' ? ` (больше 12 — зритель начинает угадывать; меняйте жест или сделайте его частью развития)` : '') +
      (top[1] ? `\n          дальше: ${top.slice(1, 3).map(x => `«${nice(x.sig)}» ${x.n}`).join(', ')}` : ''));
  }

  // 2в · камера: перепад масштаба, нырки, перебросы, направление (для роликов от 30 с: в коротком хватает одного движения)
  if (meta.duration >= 30) {
    const S = []; for (let t = 0; t <= meta.duration; t += 0.1) S.push(await page.evaluate(t => window.oneshot.cam(t), t));
    const zs = S.map(c => c.zoom), zr = Math.max(...zs) / Math.min(...zs);
    let dives = 0, whips = 0; const dirs = { right: 0, left: 0, down: 0, up: 0 };
    for (let i = 15; i < S.length; i += 5) { const a = S[i - 15], b = S[i]; if (Math.abs(Math.log(b.zoom / a.zoom)) > Math.log(2)) { dives++; i += 10; } }
    for (let i = 6; i < S.length; i += 3) { const a = S[i - 6], b = S[i], dx = (b.x - a.x) * b.zoom, dy = (b.y - a.y) * b.zoom; if (Math.hypot(dx, dy) > 0.8 * W) { whips++; i += 6; } }
    for (let i = 5; i < S.length; i += 5) { const a = S[i - 5], b = S[i], dx = (b.x - a.x) * b.zoom, dy = (b.y - a.y) * b.zoom; if (Math.hypot(dx, dy) < 150) continue;
      if (Math.abs(dx) > Math.abs(dy)) dirs[dx > 0 ? 'right' : 'left']++; else dirs[dy > 0 ? 'down' : 'up']++; }
    const moves = Object.values(dirs).reduce((a, b) => a + b, 0), dom = Object.entries(dirs).sort((a, b) => b[1] - a[1])[0], mono = moves ? dom[1] / moves : 0;
    const name = { right: 'вправо', left: 'влево', down: 'вниз', up: 'вверх' }[dom[0]];
    const events = dives + whips, need = Math.max(1, Math.floor(meta.duration / 30));
    const bad = [];
    if (zr < 2.5 && dives === 0) bad.push(`масштаб меняется всего в ${zr.toFixed(1)} раза и ни одного нырка`);
    if (moves >= 4 && mono > 0.75) bad.push(`${Math.round(mono * 100)} % переездов — ${name}: камера листает, а не снимает`);
    if (events < need) bad.push(`нырков и перебросов ${events}, нужно хотя бы ${need} (по одному на 30 с)`);
    leg('камера', bad.length ? 'WARN' : 'PASS', `масштаб ${Math.min(...zs).toFixed(2)}–${Math.max(...zs).toFixed(2)} (×${zr.toFixed(1)}), нырков ${dives}, перебросов ${whips}` + (bad.length ? '\n          ' + bad.join('\n          ') : ''));
  }

  // 2г · мусор: элементы без позиции, видимые в кадре (забыли поставить или спрятать)
  {
    const seen = {};
    for (let t = 0; t <= meta.duration; t += 0.5) { const r = await page.evaluate(t => (window.oneshot.strays ? window.oneshot.strays(t) : []), t); for (const n of r) (seen[n] = seen[n] || []).push(t); }
    const names = Object.keys(seen);
    const orph = await page.evaluate(() => (window.oneshot.orphans ? window.oneshot.orphans() : []));
    if (orph.length) leg('без жизни', 'WARN', `скрыты строгим режимом, потому что у них нет F.life: ${orph.slice(0, 10).join(', ')}${orph.length > 10 ? ' …' : ''} — объявите жизнь или удалите из разметки`);
    leg('мусор', names.length ? 'FAIL' : 'PASS', names.length ? names.map(n => `«${n}» стоит в углу мира (0, 0) и виден около ${seen[n][0].toFixed(1)}–${seen[n][seen[n].length - 1].toFixed(1)} с`).join('\n          ') + '\n          (поставьте элемент через at()/F.place или удалите из разметки, если он больше не нужен)' : 'нет забытых элементов');
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
  // код: синтаксис, съеденный комментарием вызов, неиспользуемые элементы разметки (oneshot lint)
  { const { lint } = await import('./lint.mjs'); const r = await lint(comp, { quiet: true });
    leg('код', r.problems.length ? 'FAIL' : r.warns.length ? 'WARN' : 'PASS', r.problems.length || r.warns.length ? [...r.problems, ...r.warns].slice(0, 8).join('\n          ') : 'синтаксис чистый, комментарии не съедают код, лишних элементов нет'); }

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
