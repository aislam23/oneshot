#!/usr/bin/env node
// oneshot · MIT © 2026 Artem Islamov — командная строка скилла
import { args, die, log } from '../lib/util.mjs';

const HELP = `oneshot — ролики на HTML + GSAP, собранные от голоса диктора

  oneshot doctor                                  проверить окружение (Node, ffmpeg, Chromium)
  oneshot new <папка>                             новый ролик из шаблона
  oneshot vendor <папка>                          обновить gsap и oneshot.js в папке ролика
  oneshot fonts "Golos Text:400;600" [--out fonts.css]   шрифты Google внутрь файла
  oneshot vo plan  vo/lines.txt [--say vo/say.txt] [--voice Milena] [--speed 0.9] [--duration 90]
                                                  тайминг от текста + черновой голос + субтитры
  oneshot vo audio vo/lines.txt voice.mp3         тайминг по готовой озвучке (ElevenLabs и т. п.)
  oneshot stills comp.html --times 1,4.5,9        контактный лист кадров
  oneshot sfx comp.html [--out sfx.wav]           звуки из событий композиции
  oneshot mix --voice v.mp3 [--sfx s.wav] [--music m.mp3] --out mix.wav
  oneshot render comp.html [--out draft.mp4] [--audio mix.wav] [--from 10 --to 20]
                                                  черновик 1080p30 с размытием движения
  oneshot render comp.html --final                финал 4K60 (только после утверждения)
  oneshot check comp.html [--video draft.mp4]     проверка: переходы (сама), подмены, ритм, однообразие, камера, мусор, текст, звук
  oneshot lint comp.html                          синтаксис, съеденный код, лишние элементы (без браузера, за секунду)
  oneshot snap comp.html [--update]               снимки ключевых кадров до и после правки — что изменилось во всём ролике
  oneshot ref reference.mp4                       разбор референса в цифрах: покой, склейки, длины планов, энергия
  oneshot gallery                                 словарь движений: gallery/moves.png и замеры в docs/moves.md
`;

const [cmd, ...rest] = process.argv.slice(2);
const o = args(rest, { flags: ['final', 'force', 'noSay', 'update'] });
try {
  switch (cmd) {
    case 'doctor': await (await import('../lib/tools.mjs')).doctor(); break;
    case 'new': await (await import('../lib/tools.mjs')).create(o._[0], o); break;
    case 'vendor': await (await import('../lib/tools.mjs')).vendor(o._[0]); break;
    case 'fonts': await (await import('../lib/tools.mjs')).fonts(o._, o); break;
    case 'stills': await (await import('../lib/tools.mjs')).stills(o._[0], o); break;
    case 'vo': {
      const vo = await import('../lib/vo.mjs');
      if (o._[0] === 'plan') await vo.plan(o._[1], o); else if (o._[0] === 'audio') await vo.fromAudio(o._[1], o._[2], o); else die('vo plan … или vo audio …');
      break;
    }
    case 'sfx': await (await import('../lib/sfx.mjs')).sfx(o._[0], o); break;
    case 'mix': await (await import('../lib/sfx.mjs')).mix(o); break;
    case 'render': await (await import('../lib/render.mjs')).render(o._[0], o); break;
    case 'lint': { const r = await (await import('../lib/lint.mjs')).lint(o._[0]); process.exitCode = r.problems.length ? 2 : 0; break; }
    case 'snap': await (await import('../lib/snap.mjs')).snap(o._[0], o); break;
    case 'ref': await (await import('../lib/ref.mjs')).ref(o._[0], o); break;
    case 'gallery': await (await import('../lib/gallery.mjs')).gallery(); break;
    case 'check': { const v = await (await import('../lib/check.mjs')).check(o._[0], o); process.exitCode = v === 'ПРОВАЛ' ? 2 : 0; break; }
    default: log(HELP);
  }
} catch (e) { die(e.message); }
