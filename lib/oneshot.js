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
 * Подробности: docs/composition.md
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

  function film(opts = {}) {
    const W = opts.width || 1920, H = opts.height || 1080;
    const F = {
      duration: opts.duration || 10, fps: opts.fps || 30, width: W, height: H,
      tl: root.gsap.timeline({ paused: true, defaults: { ease: 'power3.out' } }),
      stage: $(opts.stage || '#stage'), world: $(opts.world || '#world'), ground: $(opts.ground || '#ground'),
      _segs: {}, _beats: [], _threads: {}, _keeps: [], _sounds: [], _cuts: [], _cam: null, _hand: [], _shakes: [], _ready: [],
      _grid: opts.grid === undefined ? 56 : opts.grid, _t: 0, _cid: 0,
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

    // ─── движения (GSAP) ───
    const px = v => (typeof v === 'number' ? v + 'px' : v);
    F.place = (el, r) => { root.gsap.set($(el), { left: r.x, top: r.y, width: r.w, height: r.h, ...(r.r !== undefined ? { borderRadius: px(r.r) } : {}) }); return F; };
    F.hide = el => { root.gsap.set($(el), { autoAlpha: 0 }); return F; };
    F.pop = (el, t, o = {}) => {
      el = $(el); root.gsap.set(el, { autoAlpha: 0 });
      F.tl.fromTo(el, { autoAlpha: 0, y: o.y ?? 28, scale: o.from ?? 0.9, rotation: o.rot ?? 0 },
        { autoAlpha: 1, y: 0, scale: 1, rotation: 0, duration: o.dur ?? 0.55, ease: o.ease || 'back.out(1.8)', immediateRender: false }, t);
      return F;
    };
    F.rise = (el, t, o = {}) => F.pop(el, t, { y: 40, from: 1, dur: 0.6, ease: 'expo.out', ...o });
    F.leave = (el, t, o = {}) => { F.tl.to($(el), { autoAlpha: 0, y: o.y ?? -24, scale: o.to ?? 1, duration: o.dur ?? 0.35, ease: o.ease || 'power2.in' }, t); return F; };
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
      F.seg(keyOf(el), t, t + dur, (k, tc) => {
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

    // ─── камера ───
    // keys: [{t, x, y, zoom, rot, ease}] — (x, y) точка мира в центре кадра; ease — как камера приходит в этот ключ.
    F.camera = keys => { F._cam = keys.slice().sort((a, b) => a.t - b.t); return F; };
    F.handheld = (ranges, amp = 4) => { F._hand.push(...ranges.map(([a, b]) => ({ a, b, amp }))); return F; };
    F.shake = (t, amp = 10, decay = 7) => { F._shakes.push({ t, amp, decay }); return F; };
    F.cam = t => {
      const K = F._cam; if (!K || !K.length) return { x: W / 2, y: H / 2, zoom: 1, rot: 0 };
      let x, y, zoom, rot;
      if (t <= K[0].t) ({ x, y, zoom = 1, rot = 0 } = K[0]);
      else if (t >= K[K.length - 1].t) ({ x, y, zoom = 1, rot = 0 } = K[K.length - 1]);
      else {
        let i = 0; while (K[i + 1].t < t) i++;
        const A = K[i], B = K[i + 1], k = easeOf(B.ease)(clamp((t - A.t) / (B.t - A.t)));
        x = lerp(A.x, B.x, k); y = lerp(A.y, B.y, k);
        zoom = Math.exp(lerp(Math.log(A.zoom || 1), Math.log(B.zoom || 1), k)); rot = lerp(A.rot || 0, B.rot || 0, k);
      }
      let e = 0, amp = 0; for (const h of F._hand) { const w = window01(t, h.a, h.b, 0.5); if (w > e) { e = w; amp = h.amp; } }
      x += (e * amp * wobble(t, 1.3)) / zoom; y += (e * amp * wobble(t, 4.1)) / zoom;
      for (const s of F._shakes) { const d = t - s.t; if (d > 0 && d < 1.5) { const a = s.amp * Math.exp(-s.decay * d); x += (a * Math.sin(d * 71)) / zoom; y += (a * 0.7 * Math.sin(d * 89 + 1)) / zoom; } }
      return { x, y, zoom, rot };
    };
    F.toScreen = (x, y, t) => { const c = F.cam(t ?? F._t); const dx = x - c.x, dy = y - c.y, cs = Math.cos(c.rot), sn = Math.sin(c.rot); return [W / 2 + (dx * cs - dy * sn) * c.zoom, H / 2 + (dx * sn + dy * cs) * c.zoom]; };
    function applyCamera(t) {
      if (!F.world) return;
      const c = F.cam(t);
      F.world.style.transform = `translate(${W / 2}px,${H / 2}px) rotate(${c.rot}rad) scale(${c.zoom}) translate(${-c.x}px,${-c.y}px)`;
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
      applyCamera(t);
      const hud = document.getElementById('os-hud'); if (hud) hud.textContent = t.toFixed(2) + ' с';
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
          const r = el.getBoundingClientRect(), x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(W, r.right), y1 = Math.min(H, r.bottom);
          const area = (x1 - x0) * (y1 - y0); if (x1 <= x0 || y1 <= y0 || area < W * H * 0.004 || area > W * H * 0.85) continue;
          const cs = getComputedStyle(el), own = [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) || el.tagName === 'svg' || el.tagName === 'IMG' ||
            (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') || parseFloat(cs.borderTopWidth) > 1 || cs.backgroundImage !== 'none';
          if (!own) continue;
          const op = visibility(el); if (op < 0.02) continue;
          if (!el.dataset.osid) el.dataset.osid = 'c' + (++F._cid);
          const txt = [...el.childNodes].filter(c => c.nodeType === 3).map(c => c.textContent).join('').trim().toLowerCase().slice(0, 40);
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
      }).then(() => { seek(0); return true; });
      root.oneshot = {
        duration: F.duration, fps: F.fps, width: W, height: H, ready,
        seek: async t => { seek(t); return true; },
        beats: F._beats.slice().sort((a, b) => a.t - b.t), cuts: F._cuts, threads: Object.keys(F._threads), inspect, cam: t => F.cam(t),
        gestures: () => F._gest.slice(),
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

  root.OS = { film, clamp, lerp, esc };
})(typeof window !== 'undefined' ? window : globalThis);
