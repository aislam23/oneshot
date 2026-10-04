/* oneshot runtime · MIT © 2026 Artem Islamov
 *
 * Тонкий слой поверх GSAP для роликов, которые рендерятся кадр за кадром.
 * Ролик = один paused-таймлайн GSAP + «сегменты» (чистые функции времени для текста, камеры, курсора).
 * Любой кадр получается вызовом oneshot.seek(t) — в любом порядке, сколько угодно раз.
 *
 *   const F = OS.film({ duration: 90 });
 *   F.camera([{ t: 0, x: 960, y: 540, zoom: 1 }, { t: 4, x: 2400, y: 540, zoom: 1.4, ease: 'expo.inOut' }]);
 *   F.pop('#title', F.W(1, 'голос'));            // появится на слове «голос» первой фразы диктора
 *   F.type('#cmd', F.L(3), 'git clone …');       // печатается с начала третьей фразы
 *   F.beat(F.L(4), 'установка', { thread: 'bar' });
 *   F.expose();
 *
 * v0.4: жизнь элемента (F.life, строгий режим), физичные движения (F.drop, F.land, F.throw, F.anticipate, F.wobble,
 * F.punch, F.follow), камера-оператор (move: 'whip' | 'chase' | 'glide' в ключах), слои глубины (F.layer).
 * Подробности: docs/composition.md, docs/moves.md
 */
(function (root) {
  'use strict';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const $ = s => (typeof s === 'string' ? document.querySelector(s) : s);
  const easeOf = e => (typeof e === 'function' ? e : root.gsap.parseEase(e || 'power2.inOut'));
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // детерминированный шум для «ручной» камеры: сумма синусов с несоизмеримыми частотами
  const wobble = (t, seed) => Math.sin(t * 1.31 + seed) * 0.6 + Math.sin(t * 2.17 + seed * 1.7) * 0.3 + Math.sin(t * 3.73 + seed * 0.3) * 0.1;
  // плавная «ступенька» для окон
  const window01 = (t, a, b, fade) => clamp((t - a) / fade) * clamp((b - t) / fade);

  // ─── физика: чистые функции, общие для ролика, галереи и замеров (docs/moves.md) ───
  const TAU = Math.PI * 2;
  const phys = {
    // пружина: отклик 0 → 1 на скачок. f — собственная частота (Гц), d — затухание (1 — без перелёта, 0.3 — живая)
    spring(t, f = 2.2, d = 0.45) {
      if (t <= 0) return 0; const w = TAU * f;
      if (d >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
      const wd = w * Math.sqrt(1 - d * d); return 1 - Math.exp(-d * w * t) * (Math.cos(wd * t) + (d / Math.sqrt(1 - d * d)) * Math.sin(wd * t));
    },
    // затухающий звон вокруг нуля: отдача удара, желе, дрожь
    ring(t, f = 6, decay = 6) { return t <= 0 ? 0 : Math.exp(-decay * t) * Math.sin(TAU * f * t); },
    // падение с высоты h (px) с ускорением g (px/с²) и отскоками (bounce — доля скорости после удара).
    // Возвращает y (0 — земля, отрицательный — над землёй), скорость и времена касаний со скоростью удара.
    drop(t, h = 600, g = 5200, bounce = 0.32, n = 3) {
      const hits = []; let t0 = Math.sqrt(2 * h / g), v = g * t0; hits.push({ t: t0, v });
      for (let i = 1; i < n; i++) { const v2 = v * bounce, dur = 2 * v2 / g; if (v2 < 60) break; hits.push({ t: hits[i - 1].t + dur, v: v2 }); v = v2; }
      if (t <= 0) return { y: -h, vy: 0, hits };
      if (t < hits[0].t) return { y: -h + 0.5 * g * t * t, vy: g * t, hits };
      for (let i = 1; i < hits.length; i++) if (t < hits[i].t) { const u = t - hits[i - 1].t, v0 = hits[i].v; return { y: -(v0 * u - 0.5 * g * u * u), vy: -v0 + g * u, hits }; }
      return { y: 0, vy: 0, hits };
    },
    // замер движения: резкость = доля времени до 80 % пути (меньше — резче), перелёт, время успокоения
    measure(fn, dur, steps = 600) {
      let t80 = 1, over = 0, settle = 0; const end = fn(dur) || 1;
      for (let i = 0; i <= steps; i++) { const t = dur * i / steps, v = fn(t) / end; if (t80 === 1 && v >= 0.8) t80 = i / steps; over = Math.max(over, v - 1); if (Math.abs(v - 1) > 0.02) settle = t; }
      return { sharpness: +t80.toFixed(2), overshoot: +(over * 100).toFixed(1), settle: +settle.toFixed(2) };
    },
  };
  // пружинная кривая для камеры: прогресс 0 → 1 за отрезок, с перелётом и успокоением к концу
  const OPER = { whip: { c: 1.75, d: 0.55 }, chase: { c: 1.3, d: 0.72 }, glide: { c: 1.2, d: 1 } };
  const operEase = kind => { const o = OPER[kind]; return u => (u >= 1 ? 1 : phys.spring(u, o.c, o.d)); };

  function film(opts = {}) {
    const W = opts.width || 1920, H = opts.height || 1080;
    const F = {
      duration: opts.duration || 10, fps: opts.fps || 30, width: W, height: H,
      tl: root.gsap.timeline({ paused: true, defaults: { ease: 'power3.out' } }),
      stage: $(opts.stage || '#stage'), world: $(opts.world || '#world'), ground: $(opts.ground || '#ground'),
      _segs: {}, _beats: [], _threads: {}, _keeps: [], _sounds: [], _cuts: [], _cam: null, _hand: [], _shakes: [], _ready: [],
      _grid: opts.grid === undefined ? 56 : opts.grid, _t: 0, _cid: 0,
      strict: opts.strict !== false, _life: new Map(), _autoLife: new Map(), _orphans: [], _phys: [], _layers: [],
    };

    // ─── журнал жестов: что и когда двигается — для проверки однообразия ───
    F._gest = []; let depth = 0;
    const SKIP = new Set(['duration', 'ease', 'immediateRender', 'keyframes', 'delay', 'transformOrigin', 'overwrite', 'stagger']);
    const sigOf = (kind, v, f) => `${kind}|${(v && v.ease) || ''}|${f ? Object.keys(f).filter(k => !SKIP.has(k)).sort().join(',') : ''}>${v ? Object.keys(v.keyframes ? Object.assign({}, ...v.keyframes) : v).filter(k => !SKIP.has(k)).sort().join(',') : ''}`;
    const gest = (kind, t, sig) => { if (depth === 0 && typeof t === 'number' && !/>(autoAlpha|opacity)?$/.test(sig || '') && !/^to\|\{"autoAlpha":[^,}]*\}$/.test(sig || '')) F._gest.push({ t, sig: sig || kind }); };   // показать/спрятать — не жест
    const inner = fn => (...a) => { depth++; try { return fn(...a); } finally { depth--; } };
    for (const m of ['to', 'fromTo', 'from']) { const orig = F.tl[m].bind(F.tl);
      F.tl[m] = (target, a1, a2, a3) => { const pos = m === 'fromTo' ? a3 : a2; const vars = m === 'fromTo' ? a2 : a1; gest('tl.' + m, pos, sigOf('tl.' + m, vars, m === 'fromTo' ? a1 : null)); return orig(target, a1, a2, a3); }; }

    // ─── время из партитуры диктора (vo/plan.js → window.VO) ───
    const VO = () => root.VO || { lines: [] };
    F.L = i => { const l = VO().lines[i - 1]; if (!l) throw new Error(`oneshot: нет фразы ${i} в vo/plan.js`); return l.start; };
    F.E = i => { const l = VO().lines[i - 1]; if (!l) throw new Error(`oneshot: нет фразы ${i} в vo/plan.js`); return l.end; };
    F.W = (i, word, nth = 1) => {
      const l = VO().lines[i - 1]; if (!l) throw new Error(`oneshot: нет фразы ${i} в vo/plan.js`);
      const w = word.toLowerCase(); let n = 0;
      for (const x of l.words) if (x.w.toLowerCase().includes(w) && ++n === nth) return x.t;
      throw new Error(`oneshot: в фразе ${i} нет слова «${word}»`);
    };

    // ─── сегменты: чистые функции времени ───
    // На каждый ключ (обычно элемент) активен последний сегмент, начавшийся до t; до первого — первый в начальном состоянии.
    // fn(k, t, tRaw): k — прогресс 0…1 (без easing), t — время, зажатое в [t0, t1], tRaw — настоящее время кадра.
    F.seg = (key, t0, t1, fn) => { (F._segs[key] = F._segs[key] || []).push({ t0, t1: Math.max(t1, t0 + 1e-6), fn }); F._segs[key].sort((a, b) => a.t0 - b.t0); return F; };
    let uid = 0; const keyOf = el => { el = $(el); if (!el) throw new Error('oneshot: элемент не найден'); if (!el.id) el.id = 'os-auto-' + (++uid); return '#' + el.id; };

    // (autoLife определена ниже, рядом с F.life; здесь — ранняя ссылка)
    let autoLifeImpl = null; const autoLifeRef = (...a) => autoLifeImpl && autoLifeImpl(...a);

    // ─── движения (GSAP) ───
    const px = v => (typeof v === 'number' ? v + 'px' : v);
    F.place = (el, r) => { root.gsap.set($(el), { left: r.x, top: r.y, width: r.w, height: r.h, ...(r.r !== undefined ? { borderRadius: px(r.r) } : {}) }); return F; };
    F.hide = el => { root.gsap.set($(el), { autoAlpha: 0 }); return F; };
    F.pop = (el, t, o = {}) => {
      el = $(el); root.gsap.set(el, { autoAlpha: 0 }); autoLifeRef(el, t);
      F.tl.fromTo(el, { autoAlpha: 0, y: o.y ?? 28, scale: o.from ?? 0.9, rotation: o.rot ?? 0 },
        { autoAlpha: 1, y: 0, scale: 1, rotation: 0, duration: o.dur ?? 0.55, ease: o.ease || 'back.out(1.8)', immediateRender: false }, t);
      return F;
    };
    F.rise = (el, t, o = {}) => F.pop(el, t, { y: 40, from: 1, dur: 0.6, ease: 'expo.out', ...o });
    F.leave = (el, t, o = {}) => { F.tl.to($(el), { autoAlpha: 0, y: o.y ?? -24, scale: o.to ?? 1, duration: o.dur ?? 0.35, ease: o.ease || 'power2.in' }, t);
      (typeof el === 'string' ? [...document.querySelectorAll(el)] : Array.isArray(el) ? el.map($) : [$(el)]).forEach(e => autoLifeRef(e, undefined, t + (o.dur ?? 0.35))); return F; };
    F.to = (el, t, vars) => { F.tl.to($(el), { duration: 0.6, ...vars }, t); return F; };
    F.morph = (el, t, dur, r, ease = 'expo.inOut') => {
      F.tl.to($(el), { left: r.x, top: r.y, width: r.w, height: r.h, ...(r.r !== undefined ? { borderRadius: px(r.r) } : {}), duration: dur, ease }, t);
      return F;
    };
    // стаггер по детям: каждый ребёнок появляется на своём времени
    F.popEach = (els, times, o) => { [...(typeof els === 'string' ? document.querySelectorAll(els) : els)].forEach((e, i) => F.pop(e, times[i] ?? times[times.length - 1] + 0.08 * i, o)); return F; };

    // ─── печать текста ───
    // parts: строка или [[cls, text], …]. Курсор мигает после окончания, пока не начнётся следующий сегмент этого элемента.
    F.type = (el, t, parts, o = {}) => {
      el = $(el); const P = typeof parts === 'string' ? [['', parts]] : parts; const len = P.reduce((a, p) => a + p[1].length, 0);
      const cps = o.cps || 22, caret = o.caret !== false, t1 = t + len / cps;
      F.seg(keyOf(el), t, t1, (k, tc, tr) => {
        let n = Math.floor((tc - t) * cps + 1e-6), html = '';
        if (tr >= t1) n = len;
        for (const [cls, s] of P) { if (n <= 0) break; const piece = esc(s.slice(0, n)); n -= s.length; html += cls ? `<span class="${cls}">${piece}</span>` : piece; }
        const on = caret && (tr < t1 ? true : Math.floor((tr - t1) * 2.2) % 2 === 0);
        el.innerHTML = html + (caret ? `<i class="os-caret" style="opacity:${on && tr >= t ? 1 : 0}"></i>` : '');
      });
      return F;
    };
    // буквы: разбивает текст элемента на <span class="ch"> (пробел — неразрывный); возвращает массив букв
    F.split = el => { el = $(el); const s = el.textContent; el.textContent = '';
      return [...s].map(c => { const sp = document.createElement('span'); sp.className = 'ch'; sp.style.display = 'inline-block'; sp.textContent = c === ' ' ? '\u00a0' : c; el.appendChild(sp); return sp; }); };
    // перебор символов: текст перещёлкивается из from в to, буквы встают на место слева направо
    F.scramble = (el, t, dur, to, o = {}) => {
      el = $(el); const from = o.from ?? el.textContent, pool = o.pool || 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ0123456789<>/#*=+';
      F.seg(keyOf(el), t, t + dur, (k, tc, tr) => {
        if (tr < t) { el.textContent = from; return; }   // до начала — исходное слово, а не шум
        const n = Math.round(lerp(from.length, to.length, Math.min(1, k * 1.6))), f = Math.floor(tc * 30); let out = '';
        for (let i = 0; i < n; i++) { const lock = (i + 1) / (n + 1); out += k >= 1 || k > lock ? (to[i] ?? '') : pool[(i * 7 + f * 13 + i * f) % pool.length]; }
        el.textContent = out;
      });
      return F;
    };
    F.text = (el, t, html) => { el = $(el); F.seg(keyOf(el), t, t, () => { el.innerHTML = html; }); return F; };
    // счётчик: число растёт от a до b
    F.count = (el, t, dur, a, b, o = {}) => {
      el = $(el); const e = easeOf(o.ease || 'power2.out'); const fmt = o.format || (v => Math.round(v).toLocaleString('ru-RU'));
      F.seg(keyOf(el), t, t + dur, k => { el.textContent = fmt(lerp(a, b, e(k))); }); return F;
    };

    // ─── курсор: путь через точки, нажатия ───
    F.cursor = (el, { path, clicks = [], show = [[path[0].t, path[path.length - 1].t]] }) => {
      el = $(el);   // можно вызывать несколько раз: каждый вызов — свой отрезок времени
      for (const [a, b] of show) { const L = F._life.get(el) || []; L.push({ a, b }); F._life.set(el, L); }
      F.seg(keyOf(el), show[0][0], show[show.length - 1][1], (k, tc, tr) => {
        const t = tc; let i = 0; while (i < path.length - 2 && path[i + 1].t <= t) i++;
        const a = path[i], b = path[Math.min(i + 1, path.length - 1)], u = b.t > a.t ? clamp((t - a.t) / (b.t - a.t)) : 1;
        const e = easeOf(b.ease || 'power2.inOut')(u); let s = 1;
        for (const c of clicks) { const d = t - c; if (d >= 0 && d < 0.16) s = 0.82; }
        const vis = show.some(([p, q]) => tr >= p && tr < q);
        el.style.transform = `translate(${lerp(a.x, b.x, e).toFixed(2)}px,${lerp(a.y, b.y, e).toFixed(2)}px) scale(${s})`;
        el.style.visibility = vis ? 'visible' : 'hidden';
      });
      return F;
    };

    // жесты F.* пишутся в журнал одной строкой (вместе с параметрами), внутренние твины — нет
    for (const name of ['pop', 'rise', 'leave', 'to', 'morph', 'type', 'scramble', 'count', 'cursor']) {
      const fn = F[name];
      F[name] = (...a) => { const t = name === 'cursor' ? a[1].show[0][0] : name === 'morph' ? a[1] : a[1];
        const o = name === 'to' ? a[2] : name === 'morph' ? { ease: a[4] } : a[2];
        gest(name, t, `${name}|${JSON.stringify(o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => ['ease', 'from', 'y', 'rot', 'x', 'scale', 'autoAlpha', 'width', 'backgroundColor'].includes(k))) : '')}`);
        depth++; try { return fn(...a); } finally { depth--; } };
    }

    // ─── жизнь элемента ───
    // F.life(el, { at, from, to, enter, exit }) — вся жизнь элемента в одном месте: где стоит, когда виден, как входит и уходит.
    // Вне окон жизни элемент невидим. В строгом режиме (по умолчанию) невидимо и всё, у чего жизни нет вовсе (ни у него,
    // ни у предков) — забытый элемент не может попасть в кадр, а `oneshot check` его назовёт.
    //   enter / exit: 'pop' | 'rise' | 'drop' | 'leave' | 'fall' | { move: 'pop', ...параметры }
    F.life = (el, spec = {}) => {
      el = $(el); if (!el) throw new Error('oneshot: F.life — элемент не найден');
      const a = spec.from ?? 0, b = spec.to ?? Infinity;
      const L = F._life.get(el) || []; L.push({ a, b }); F._life.set(el, L);
      if (spec.at) { if (spec.at.w !== undefined) F.place(el, spec.at); else root.gsap.set(el, { left: spec.at.x, top: spec.at.y }); }
      const run = (m, t) => { if (!m) return; const o = typeof m === 'string' ? { move: m } : m; const fn = F[o.move]; if (!fn) throw new Error('oneshot: нет движения ' + o.move); fn(el, t, o); };
      if (spec.enter) run(spec.enter, a);
      if (spec.exit && b !== Infinity) { const o = typeof spec.exit === 'string' ? { move: spec.exit } : spec.exit; run(o, b - (o.dur ?? 0.35)); }
      return F;
    };
    const autoLife = (el, a, b) => { el = $(el); if (!el) return; const L = F._autoLife.get(el) || []; if (a !== undefined) L.push({ a, b: Infinity }); if (b !== undefined && L.length) L[L.length - 1].b = Math.max(L[L.length - 1].a, b); F._autoLife.set(el, L); };
    autoLifeImpl = autoLife;
    const windowsOf = el => F._life.get(el) || F._autoLife.get(el);
    F.fall = (el, t, o = {}) => { F.tl.to($(el), { y: o.y ?? 900, rotation: o.rot ?? 12, duration: o.dur ?? 0.6, ease: 'power2.in' }, t); autoLife(el, undefined, t + (o.dur ?? 0.6)); return F; };

    // ─── физичные движения ───
    // Пишут в отдельные CSS-свойства translate / scale / rotate — они складываются с transform от GSAP и не спорят с ним.
    // Вклады нескольких движений в один элемент суммируются.
    const addPhys = (el, t0, fn) => { F._phys.push({ el: $(el), t0, fn }); };
    const vel = (fn, t, h = 1 / 240) => (fn(t + h) - fn(t - h)) / (2 * h);
    // падение сверху с отскоками; на каждом касании сплющивается пропорционально скорости удара
    F.drop = (el, t, o = {}) => {
      el = $(el); const h = o.height ?? 640, g = o.g ?? 5200, sq = o.squash ?? 0.28, bounce = o.bounce ?? 0.32;
      const hits = phys.drop(0, h, g, bounce).hits;
      F._phys.push({ el, t0: t, before: true, fn: tt => { tt = Math.max(0, tt); const d = phys.drop(tt, h, g, bounce); let s = 0;
        for (const hh of d.hits) s += (hh.v / 2400) * sq * phys.ring(tt - hh.t, 3.2, 7);
        const stretch = tt < d.hits[0].t ? Math.min(0.18, Math.abs(d.vy) / 22000) : 0;   // в полёте чуть вытянут вдоль падения
        return { dy: d.y, sx: 1 + s - stretch * 0.5, sy: 1 - s + stretch }; } });
      autoLife(el, t); F._lastHits = hits.map(x => ({ t: t + x.t, v: x.v }));
      return F;
    };
    // приземление: удар в точке (x, y) расходится кольцом по соседям — каждый подпрыгивает, когда до него дошла волна
    F.land = (t, els, o = {}) => {
      const amp = o.amp ?? 26, speed = o.speed ?? 2600, at = o.at;
      [...(typeof els === 'string' ? document.querySelectorAll(els) : els)].forEach(e => { e = $(e);
        const r = e.getBoundingClientRect(), d = at ? Math.hypot(r.x + r.width / 2 - at.x, r.y + r.height / 2 - at.y) : 0, delay = d / speed, k = Math.exp(-d / (o.reach ?? 900));
        addPhys(e, t + delay, tt => ({ dy: -amp * k * Math.abs(phys.ring(tt, 2.4, 6)), rot: (o.tilt ?? 1.5) * k * phys.ring(tt, 3.1, 7) })); });
      return F;
    };
    // бросок по дуге: из текущего места на (dx, dy), с высотой дуги и вращением; вытягивается вдоль скорости
    F.throw = (el, t, o = {}) => {
      const dur = o.dur ?? 0.7, dx = o.dx ?? 0, dy = o.dy ?? 0, arc = o.arc ?? 260, spin = o.spin ?? 0;
      const X = tt => dx * Math.min(1, tt / dur), Y = tt => { const u = Math.min(1, tt / dur); return dy * u - arc * 4 * u * (1 - u); };
      addPhys(el, t, tt => { const v = tt < dur ? Math.hypot(vel(X, tt), vel(Y, tt)) : 0, st = Math.min(0.25, v / 14000);
        return { dx: X(tt), dy: Y(tt), rot: spin * Math.min(1, tt / dur), sx: 1 + st, sy: 1 - st * 0.6 }; });
      return F;
    };
    // замах и переход: чуть назад, потом на (dx, dy) с перелётом и успокоением
    F.anticipate = (el, t, o = {}) => {
      const dx = o.dx ?? 0, dy = o.dy ?? 0, back = o.back ?? 0.14, wind = o.wind ?? 0.16, f = o.f ?? 2.4, d = o.d ?? 0.5;
      const P = tt => (tt < wind ? -back * Math.sin(Math.PI / 2 * tt / wind) : -back + (1 + back) * phys.spring(tt - wind, f, d));
      addPhys(el, t, tt => ({ dx: dx * P(tt), dy: dy * P(tt), sx: 1 + (tt < wind ? 0.04 * tt / wind : 0) }));
      return F;
    };
    // желе: качнулся и успокоился (после удара, нажатия, приземления)
    F.wobble = (el, t, o = {}) => { const a = o.amp ?? 0.08; addPhys(el, t, tt => ({ rot: (o.rot ?? 4) * phys.ring(tt, o.f ?? 3, 5), sx: 1 + a * phys.ring(tt, 4.2, 6), sy: 1 - a * phys.ring(tt, 4.2, 6) })); return F; };
    // удар-акцент: резко больше и обратно с перелётом
    F.punch = (el, t, o = {}) => { const k = (o.scale ?? 1.16) - 1; addPhys(el, t, tt => { const v = tt <= 0 ? 0 : k * (1 - phys.spring(tt, o.f ?? 3.2, o.d ?? 0.35)) * Math.min(1, tt / 0.04); return { sx: 1 + v, sy: 1 + v }; }); return F; };
    // догонялка: элемент тянется за целью target(t) → {x, y} (смещение) с запаздыванием и перелётом; интегрируется заранее
    F.follow = (el, t0, t1, target, o = {}) => {
      const f = o.f ?? 1.6, d = o.d ?? 0.6, hz = 240, n = Math.ceil((t1 - t0) * hz) + 2, X = new Float32Array(n), Y = new Float32Array(n);
      let x = target(t0).x, y = target(t0).y, vx = 0, vy = 0; const w = TAU * f;
      for (let i = 0; i < n; i++) { const tg = target(t0 + i / hz); vx += (w * w * (tg.x - x) - 2 * d * w * vx) / hz; vy += (w * w * (tg.y - y) - 2 * d * w * vy) / hz; x += vx / hz; y += vy / hz; X[i] = x; Y[i] = y; }
      addPhys(el, t0, tt => { const i = Math.min(n - 1, Math.max(0, Math.round(tt * hz))); return { dx: X[i], dy: Y[i] }; });
      return F;
    };
    function applyPhys(t) {
      const acc = new Map();
      for (const p of F._phys) { if (t < p.t0 && !p.before) continue; const v = p.fn(t - p.t0); const a = acc.get(p.el) || { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 };
        a.dx += v.dx || 0; a.dy += v.dy || 0; a.sx *= v.sx ?? 1; a.sy *= v.sy ?? 1; a.rot += v.rot || 0; acc.set(p.el, a); }
      for (const p of F._phys) if (!acc.has(p.el)) acc.set(p.el, { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 });
      for (const [el, a] of acc) { el.style.translate = `${a.dx.toFixed(2)}px ${a.dy.toFixed(2)}px`; el.style.scale = `${a.sx.toFixed(4)} ${a.sy.toFixed(4)}`; el.style.rotate = `${a.rot.toFixed(3)}deg`; }
    }

    // ─── камера ───
    // keys: [{t, x, y, zoom, rot, ease}] — (x, y) точка мира в центре кадра; ease — как камера приходит в этот ключ.
    // ключ с move: 'whip' (резкий переброс), 'chase' (догоняет с перелётом), 'glide' (плавно, без перелёта) — камера-оператор.
    // opts.hand: амплитуда «руки», которая сама работает только в движении.
    F.camera = (keys, o = {}) => { F._cam = keys.slice().sort((a, b) => a.t - b.t); F._autoHand = o.hand || 0; return F; };
    const rawCam = t => { const K = F._cam; if (!K || !K.length) return { x: W / 2, y: H / 2, zoom: 1 };
      if (t <= K[0].t) return { x: K[0].x, y: K[0].y, zoom: K[0].zoom || 1 }; if (t >= K[K.length - 1].t) { const k = K[K.length - 1]; return { x: k.x, y: k.y, zoom: k.zoom || 1 }; }
      let i = 0; while (K[i + 1].t < t) i++; const A = K[i], B = K[i + 1], u = clamp((t - A.t) / (B.t - A.t)), k = B.move ? operEase(B.move)(u) : easeOf(B.ease)(u);
      const z = Math.exp(lerp(Math.log(A.zoom || 1), Math.log(B.zoom || 1), k)); return { x: lerp(A.x, B.x, k), y: lerp(A.y, B.y, k), zoom: z }; };
    F._camSpeed = t => { const a = rawCam(t - 0.03), b = rawCam(t + 0.03); return Math.hypot((b.x - a.x) * b.zoom, (b.y - a.y) * b.zoom) / 0.06 + Math.abs(Math.log(b.zoom / a.zoom)) / 0.06 * 600; };
    // слой глубины: контейнер вне #world, едет с камерой медленнее (depth > 0, дальний план) или быстрее (depth < 0, ближний)
    F.layer = (el, depth) => { el = $(el); el.style.transformOrigin = '0 0'; F._layers.push({ el, depth }); return F; };
    F.handheld = (ranges, amp = 4) => { F._hand.push(...ranges.map(([a, b]) => ({ a, b, amp }))); return F; };
    F.shake = (t, amp = 10, decay = 7) => { F._shakes.push({ t, amp, decay }); return F; };
    F.cam = t => {
      const K = F._cam; if (!K || !K.length) return { x: W / 2, y: H / 2, zoom: 1, rot: 0 };
      let x, y, zoom, rot;
      if (t <= K[0].t) ({ x, y, zoom = 1, rot = 0 } = K[0]);
      else if (t >= K[K.length - 1].t) ({ x, y, zoom = 1, rot = 0 } = K[K.length - 1]);
      else {
        let i = 0; while (K[i + 1].t < t) i++;
        const A = K[i], B = K[i + 1], u = clamp((t - A.t) / (B.t - A.t)), k = B.move ? operEase(B.move)(u) : easeOf(B.ease)(u);   // move: оператор с перелётом
        x = lerp(A.x, B.x, k); y = lerp(A.y, B.y, k);
        zoom = Math.exp(lerp(Math.log(A.zoom || 1), Math.log(B.zoom || 1), k)); rot = lerp(A.rot || 0, B.rot || 0, k);
      }
      let e = 0, amp = 0; for (const h of F._hand) { const w = window01(t, h.a, h.b, 0.5); if (w > e) { e = w; amp = h.amp; } }
      if (F._autoHand) {   // «рука» сама: включается, пока камера едет, и гаснет в паузах
        const sp = F._camSpeed(t); const w = clamp(sp / 220); if (w * F._autoHand > e * amp) { e = w; amp = F._autoHand; } }
      x += (e * amp * wobble(t, 1.3)) / zoom; y += (e * amp * wobble(t, 4.1)) / zoom;
      for (const s of F._shakes) { const d = t - s.t; if (d > 0 && d < 1.5) { const a = s.amp * Math.exp(-s.decay * d); x += (a * Math.sin(d * 71)) / zoom; y += (a * 0.7 * Math.sin(d * 89 + 1)) / zoom; } }
      return { x, y, zoom, rot };
    };
    F.toScreen = (x, y, t) => { const c = F.cam(t ?? F._t); const dx = x - c.x, dy = y - c.y, cs = Math.cos(c.rot), sn = Math.sin(c.rot); return [W / 2 + (dx * cs - dy * sn) * c.zoom, H / 2 + (dx * sn + dy * cs) * c.zoom]; };
    function applyCamera(t) {
      if (!F.world) return;
      const c = F.cam(t);
      F.world.style.transform = `translate(${W / 2}px,${H / 2}px) rotate(${c.rot}rad) scale(${c.zoom}) translate(${-c.x}px,${-c.y}px)`;
      for (const L of F._layers) { const f = 1 / (1 + Math.max(-0.9, L.depth)), z = Math.pow(c.zoom, f), cx = W / 2 + (c.x - W / 2) * f, cy = H / 2 + (c.y - H / 2) * f;
        L.el.style.transform = `translate(${W / 2}px,${H / 2}px) rotate(${c.rot * f}rad) scale(${z}) translate(${-cx}px,${-cy}px)`; }
      if (F.ground && F._grid) { // сетка на фоне едет медленнее мира: глубина 0.5
        const z = Math.pow(c.zoom, 0.5), g = F._grid * z;
        F.ground.style.backgroundSize = `${g}px ${g}px`;
        F.ground.style.backgroundPosition = `${(W / 2 - c.x * z * 0.5) % g}px ${(H / 2 - c.y * z * 0.5) % g}px`;
      }
    }

    // ─── разметка для проверки и звука ───
    // beat: граница сцены. thread — id элемента, который переходит через границу (нить), или 'camera' — сцены связывает
    // непрерывное движение камеры (переброс, нырок, отъезд). cut: true — честная склейка.
    F.beat = (t, name, o = {}) => { F._beats.push({ t, name, thread: o.thread || null, cut: !!o.cut }); if (o.cut) F._cuts.push(t); return F; };
    F.thread = (id, el) => { F._threads[id] = keyOf(el || '#' + id); return F; };
    F.keep = (el, t0, t1) => { F._keeps.push({ sel: keyOf(el), t0, t1 }); return F; };
    // звук: kind — whoosh | pop | tick | click | key | thump | rise | chord | swell; x — точка мира для панорамы
    F.sound = (t, kind, o = {}) => { F._sounds.push({ ...o, t, kind, x: o.x ?? null, gain: o.gain ?? 1 }); return F; };   // доп. поля (f — высота, dur) уходят в синтезатор
    F.ready = p => { F._ready.push(p); return F; };

    // ─── кадр ───
    function seek(t) {
      t = clamp(t, 0, F.duration); F._t = t;
      F.tl.seek(t, true);
      for (const key in F._segs) {
        const L = F._segs[key]; let s = L[0];
        for (const x of L) if (x.t0 <= t) s = x;
        const tc = clamp(t, s.t0, s.t1); s.fn((tc - s.t0) / (s.t1 - s.t0), tc, t);
      }
      applyPhys(t);
      applyLife(t);
      applyCamera(t);
      const hud = document.getElementById('os-hud'); if (hud) hud.textContent = t.toFixed(2) + ' с';
    }

    // видимость по окнам жизни; в строгом режиме сироты (без жизни у себя и предков) скрыты всегда
    function applyLife(t) {
      for (const [el, L] of F._life) el.style.visibility = L.some(w => t >= w.a && t < w.b) ? '' : 'hidden';
      for (const [el, L] of F._autoLife) if (!F._life.has(el)) { if (!L.some(w => t >= w.a && t < w.b)) el.style.visibility = 'hidden'; else if (el.style.visibility === 'hidden') el.style.visibility = ''; }
      for (const el of F._orphans) el.style.visibility = 'hidden';
    }
    // сироты: элементы с собственным содержимым, у которых нет жизни ни у них, ни у предков
    function findOrphans() {
      const has = el => { for (let e = el; e && e !== F.stage; e = e.parentElement) if (F._life.has(e) || F._autoLife.has(e)) return true; return false; };
      const skip = new Set([F.world, F.ground, F.stage, document.getElementById('vig'), document.getElementById('os-hud')]);
      const out = [];
      for (const el of (F.stage || document.body).querySelectorAll('*')) {
        if (skip.has(el) || el.closest('svg') && el.tagName !== 'svg') continue;
        const cs = getComputedStyle(el), own = [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) || el.tagName === 'svg' || el.tagName === 'IMG' ||
          (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') || parseFloat(cs.borderTopWidth) > 0 || cs.backgroundImage !== 'none';
        if (own && !has(el)) out.push(el);
      }
      return out;
    }

    // ─── инспекция для `oneshot check` ───
    function visibility(el) {
      let op = 1;
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return 0; op *= parseFloat(cs.opacity);
      }
      return op;
    }
    function inspect(t, o = {}) {
      seek(t);
      const box = sel => {
        const el = document.querySelector(sel); if (!el) return null; let r = el.getBoundingClientRect();
        if (r.width * r.height < 1) { const rg = document.createRange(); rg.selectNodeContents(el); r = rg.getBoundingClientRect(); }   // контейнер нулевого размера — меряем содержимое
        return { x: r.x, y: r.y, w: r.width, h: r.height, op: visibility(el) };
      };
      const out = { t, threads: {}, keeps: [], texts: [] };
      for (const id in F._threads) out.threads[id] = box(F._threads[id]);
      for (const k of F._keeps) if (t >= k.t0 && t <= k.t1) out.keeps.push({ sel: k.sel, box: box(k.sel) });
      if (o.content) {   // видимое содержимое кадра: элементы с текстом, фоном, рамкой или картинкой
        out.content = []; let n = 0;
        for (const el of (F.stage || document.body).querySelectorAll('*')) {
          if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) continue;
          const r = el.getBoundingClientRect(); let x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(W, r.right), y1 = Math.min(H, r.bottom);
          let clipBy = null;
          for (let p = el.parentElement; p && p !== F.stage; p = p.parentElement) {   // обрезка родителями с overflow: hidden
            const ov = getComputedStyle(p).overflow; if (ov !== 'hidden' && ov !== 'clip') continue;
            const q = p.getBoundingClientRect(), cut = r.left < q.left - 1 || r.top < q.top - 1 || r.right > q.right + 1 || r.bottom > q.bottom + 1;
            if (!clipBy) clipBy = p;   // содержимое контейнера с обрезкой — одно целое с ним (карточка, окно, маска счётчика)
            x0 = Math.max(x0, q.left); y0 = Math.max(y0, q.top); x1 = Math.min(x1, q.right); y1 = Math.min(y1, q.bottom); }
          const area = (x1 - x0) * (y1 - y0); if (x1 <= x0 || y1 <= y0 || area < W * H * 0.004) continue;   // полноэкранные элементы тоже содержимое (кадр 4K, чёрный фон удара); фон сцены отсеян ниже
          if (el === F.world || el === F.ground || el.id === 'vig' || el.id === 'os-hud') continue;
          const cs = getComputedStyle(el), own = [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) || el.tagName === 'svg' || el.tagName === 'IMG' ||
            (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') || parseFloat(cs.borderTopWidth) > 1 || cs.backgroundImage !== 'none';
          if (!own) continue;
          const op = visibility(el); if (op < 0.02) continue;
          // устойчивый ключ: путь от ближайшего предка с id — элементы, которые пересоздаются каждый кадр (печать, перебор), не теряют «личность»
          let key = '', e = clipBy || el; while (e && e !== F.stage) { if (e.id) { key = '#' + e.id + key; break; } const i = e.parentElement ? [...e.parentElement.children].indexOf(e) : 0; key = `>${e.tagName}${i}` + key; e = e.parentElement; }
          el.dataset.osid = key;
          const txt = [...el.childNodes].filter(c => c.nodeType === 3).map(c => c.textContent).join('').trim().toLowerCase().slice(0, 40);
          if (clipBy) { const prev = out.content.find(c => c.id === key); if (prev) { const nx0 = Math.min(prev.x, x0), ny0 = Math.min(prev.y, y0); prev.w = Math.max(prev.x + prev.w, x1) - nx0; prev.h = Math.max(prev.y + prev.h, y1) - ny0; prev.x = nx0; prev.y = ny0; prev.op = Math.max(prev.op, +op.toFixed(3)); continue; } }
          out.content.push({ id: el.dataset.osid, x: x0, y: y0, w: x1 - x0, h: y1 - y0, op: +op.toFixed(3), name: el.id || el.className || el.tagName, txt });
          if (++n > 400) break;
        }
      }
      if (o.texts) {
        const tw = document.createTreeWalker(F.stage || document.body, NodeFilter.SHOW_TEXT); let n;
        while ((n = tw.nextNode())) {
          const s = n.textContent.trim(); if (!s) continue; const el = n.parentElement; const op = visibility(el); if (op < 0.5) continue;
          const rg = document.createRange(); rg.selectNodeContents(n); const rs = rg.getClientRects(); if (!rs.length) continue;
          const r = rs[0]; if (r.right < 0 || r.left > W || r.bottom < 0 || r.top > H) continue;
          let blk = el; while (blk && !blk.offsetWidth) blk = blk.parentElement; if (!blk) continue;   // масштаб = экранная ширина / ширина в вёрстке
          const scale = blk.getBoundingClientRect().width / blk.offsetWidth, fs = parseFloat(getComputedStyle(el).fontSize);
          out.texts.push({ s: s.slice(0, 48), px: +(fs * scale).toFixed(1) });
        }
      }
      return out;
    }

    F.expose = () => {
      const ready = Promise.all([document.fonts.ready, ...F._ready]).then(() => document.fonts.ready).then(() => {
        return Promise.all([...document.images].map(i => (i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
      }).then(() => {
        if (F.strict) { F._orphans = findOrphans(); if (F._orphans.length) console.warn('oneshot: без жизни (скрыты):', F._orphans.map(e => e.id || e.className || e.tagName).join(', ')); }
        seek(0); return true; });
      root.oneshot = {
        duration: F.duration, fps: F.fps, width: W, height: H, ready,
        seek: async t => { seek(t); return true; },
        beats: F._beats.slice().sort((a, b) => a.t - b.t), cuts: F._cuts, threads: Object.keys(F._threads), inspect, cam: t => F.cam(t),
        gestures: () => F._gest.slice(),
        orphans: () => F._orphans.map(e => e.id || (typeof e.className === 'string' ? e.className : '') || e.tagName), strict: F.strict,
        // элементы мира, которые никто не поставил: абсолютные, left/top = 0, с собственным содержимым — они стоят в углу мира
        strays: t => { seek(t); const out = [];
          for (const el of (F.world || document.body).querySelectorAll('*')) {
            const cs = getComputedStyle(el); if (cs.position !== 'absolute' || parseFloat(cs.left) !== 0 || parseFloat(cs.top) !== 0) continue;
            if (el.parentElement !== F.world) continue;
            const own = [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && el.offsetWidth * el.offsetHeight > 0);
            if (!own || visibility(el) < 0.05) continue;
            const r = el.getBoundingClientRect(); if (r.right < 0 || r.left > W || r.bottom < 0 || r.top > H || r.width * r.height < 100) continue;
            out.push(el.id || el.className || el.tagName);
          } return out; },
        // насколько далеко что-то сдвинулось на экране между t0 и t1 (px) — по этому рендер решает, сколько подкадров нужно на смаз
        motion: (t0, t1) => {
          const snap = t => { seek(t); const m = new Map();
            for (const el of (F.stage || document.body).querySelectorAll('*')) {
              if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
              const r = el.getBoundingClientRect(); if (r.width * r.height < 4 || r.right < -W || r.left > 2 * W || r.bottom < -H || r.top > 2 * H) continue;
              m.set(el, r);
            } return m; };
          const A = snap(t0), B = snap(t1); let d = 0;
          for (const [el, a] of A) { const b = B.get(el); if (!b) continue;
            d = Math.max(d, Math.abs(a.left - b.left), Math.abs(a.right - b.right), Math.abs(a.top - b.top), Math.abs(a.bottom - b.bottom)); }
          return Math.min(d, 4 * W);
        },
        events: () => F._sounds.map(s => ({ ...s, pan: s.x === null ? 0 : clamp((F.toScreen(s.x, H / 2, s.t)[0] - W / 2) / (W / 2) * 0.7, -0.8, 0.8) })).sort((a, b) => a.t - b.t),
      };
      const q = new URLSearchParams(location.search);
      if (q.has('hud') && !document.getElementById('os-hud')) { const h = document.createElement('div'); h.id = 'os-hud'; h.style.cssText = 'position:fixed;right:14px;bottom:10px;font:14px ui-monospace,monospace;color:#f33;z-index:99999'; document.body.appendChild(h); }
      ready.then(() => {
        if (q.has('t')) seek(parseFloat(q.get('t')));
        if (q.has('play')) { const t0 = performance.now() - (parseFloat(q.get('from') || 0) * 1000); const loop = () => { seek(((performance.now() - t0) / 1000) % F.duration); requestAnimationFrame(loop); }; loop(); }
      });
      return root.oneshot;
    };
    return F;
  }

  root.OS = { film, clamp, lerp, esc, phys, operEase, OPER };
  if (typeof module === 'object' && module.exports) module.exports = { phys, operEase, OPER };
})(typeof window !== 'undefined' ? window : globalThis);
