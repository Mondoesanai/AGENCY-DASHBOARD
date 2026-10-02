// R2.7 — the palette held to a number.
//
// A browser audit measures what is rendered and is the primary evidence. This
// is the other half: it reads the real token values out of the real stylesheet
// and does the WCAG arithmetic, so a token edited to an unreadable value fails
// the suite immediately rather than waiting for someone to open the page.
import fs from 'node:fs';
import { check, section, done } from './world.mjs';
import { parseColor, flatten, relativeLuminance, contrastRatio, required, readTokens } from '../lib/contrast.js';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const T = readTokens(html);

// ---------------------------------------------------------------------------
section('C1  the arithmetic itself');
check('black on white is the maximum', contrastRatio('#000000', '#ffffff') === 21);
check('a colour on itself is 1', contrastRatio('#46a878', '#46a878') === 1);
check('order does not change the ratio', contrastRatio('#000', '#fff') === contrastRatio('#fff', '#000'));
check('short hex is understood', JSON.stringify(parseColor('#fff')) === JSON.stringify({ r: 255, g: 255, b: 255, a: 1 }));
check('rgb() is understood', parseColor('rgb(18, 22, 15)').g === 22);
check('rgba() keeps its alpha', parseColor('rgba(18,22,15,0.5)').a === 0.5);
check('nonsense is refused rather than guessed', parseColor('chartreuse-ish') === null);
check('an unparseable colour yields no ratio', contrastRatio('nope', '#fff') === null);
// translucent text really is harder to read, and the maths has to show that
const solid = contrastRatio('#ffffff', '#000000');
const faded = contrastRatio('rgba(255,255,255,0.4)', '#000000');
check('translucent text scores lower than solid', faded < solid, `${faded} vs ${solid}`);
check('flattening 50% white on black lands mid-grey', Math.round(flatten({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 }).r) === 128);
check('luminance of white is 1', Math.round(relativeLuminance({ r: 255, g: 255, b: 255 })) === 1);
check('luminance of black is 0', relativeLuminance({ r: 0, g: 0, b: 0 }) === 0);
check('large text needs less', required(24) === 3 && required(14) === 4.5);
check('bold 19px counts as large', required(19, 700) === 3);
check('but normal 19px does not', required(19, 400) === 4.5);

// ---------------------------------------------------------------------------
section('C2  the real tokens, read out of the real stylesheet');
check('the tokens were found, not assumed', Object.keys(T).length >= 10, Object.keys(T).join(','));
for (const n of ['bg', 'surface', 'ink', 'muted', 'faint', 'green', 'green-br', 'pos', 'neg', 'warn', 'line'])
  check(`--${n} is defined`, !!T[n], JSON.stringify(Object.keys(T)));

// Every pair the dashboard actually puts together. Body text must clear 4.5.
const TEXT_PAIRS = [
  ['ink', 'bg'], ['ink', 'surface'], ['ink', 'surface2'],
  ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface2'],
  ['faint', 'bg'], ['faint', 'surface'],
  ['green-br', 'surface'], ['pos', 'surface'], ['neg', 'surface'], ['warn', 'surface'],
  ['green', 'bg'],
];
for (const [fg, bg] of TEXT_PAIRS) {
  const r = contrastRatio(T[fg], T[bg]);
  check(`--${fg} on --${bg} reaches 4.5:1`, r >= 4.5, `${r}:1`);
}

// ---------------------------------------------------------------------------
section('C3  control borders are visible (WCAG 1.4.11, 3:1)');
// An input you cannot see the edge of is an input you cannot find. This is the
// one the audit caught: --line is 1.65:1 on --surface, which is fine for a
// decorative rule and not fine for the border of a thing you type into.
check('--line-strong exists for interactive borders', !!T['line-strong'], Object.keys(T).join(','));
for (const bg of ['bg', 'surface', 'surface2']) {
  const r = contrastRatio(T['line-strong'], T[bg]);
  check(`--line-strong on --${bg} reaches 3:1`, r >= 3, `${r}:1`);
}
// the decorative rule is deliberately quieter, and that is allowed
check('--line stays subtle, as a separator should', contrastRatio(T.line, T.surface) < 3);

// ---------------------------------------------------------------------------
section('C4  the focus ring is visible against every surface it can land on');
check('a focus colour token exists', !!T['focus'], Object.keys(T).join(','));
// The ring is drawn OUTSIDE the control (outline-offset is positive everywhere,
// which the browser check confirms), so what it has to contrast with is the
// surface behind the control — not the control's own fill. Against --green it
// is only 1.75:1, which is why the ring must never be drawn on top of a button.
for (const bg of ['bg', 'surface', 'surface2', 'green-soft'])
  check(`the focus ring reaches 3:1 on --${bg}`, contrastRatio(T.focus, T[bg]) >= 3, `${contrastRatio(T.focus, T[bg])}:1`);
check('and the reason the offset matters is real', contrastRatio(T.focus, T.green) < 3, `${contrastRatio(T.focus, T.green)}:1 on the button fill`);

// ---------------------------------------------------------------------------
section('C5  restrained accents: green is an accent, not the palette');
// "Restrained dark-green accents" is the requirement. Measured as: the number
// of distinct green tokens stays small, and the page's own background and
// text colours are not themselves green-saturated.
const greens = Object.keys(T).filter((k) => /green|pos/.test(k));
check('there are few green tokens, not a green palette', greens.length <= 5, greens.join(','));
const sat = (c) => { const p = parseColor(c); const mx = Math.max(p.r, p.g, p.b), mn = Math.min(p.r, p.g, p.b); return mx ? (mx - mn) / mx : 0; };
check('the page background is near-neutral, not a green wash', sat(T.bg) < 0.25, String(Math.round(sat(T.bg) * 100) / 100));
check('card surfaces are near-neutral too', sat(T.surface) < 0.25, String(Math.round(sat(T.surface) * 100) / 100));
check('body text is near-neutral', sat(T.ink) < 0.1, String(Math.round(sat(T.ink) * 100) / 100));
check('the accent itself is actually green', (() => { const p = parseColor(T.green); return p.g > p.r && p.g > p.b; })());

done();
