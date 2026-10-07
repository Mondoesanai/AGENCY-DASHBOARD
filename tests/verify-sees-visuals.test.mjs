// The verifier could not see a single image or icon, ever.
//
// R21.3. Shipped-change verification fetches the live page, strips it to text,
// and asks whether the client's request was carried out. `strip()` deleted every
// tag, so an inline <svg>, an <img> and its alt text all became nothing. Any
// request naming something visual was therefore UNVERIFIABLE — and because the
// verdict is "not done", the ticket stays open no matter how many times the work
// ships correctly.
//
// This is not hypothetical. On One More Thing, Angie asked for a paw icon on the
// Pet Preparedness section. It shipped, it renders live — a 52px navy tile with
// a five-circle paw, confirmed by screenshot — and verification reported:
//   "Pet Preparedness Packet section is missing the requested paw icon."

import { check, section, done } from './world.mjs';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../lib/revisions.js', import.meta.url), 'utf8');

// `strip` is a closure inside verifyShipped, so it is reconstructed here from
// the same source rather than re-implemented: the point is to exercise the real
// expression, and a hand-written copy could drift from it silently.
const from = src.indexOf('const strip = (h) =>');
const to = src.indexOf('.trim();', from) + '.trim();'.length;
const stripSrc = src.slice(from, to);
// eslint-disable-next-line no-new-func
const strip = new Function(`${stripSrc}\nreturn strip;`)();

// ---------------------------------------------------------------------------
section('V1  an inline SVG icon survives as something nameable');
const pawHtml = `<section><h2>Don't forget your pets</h2>
  <div class="paw-icon"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="16" r="4.2"/><circle cx="5.5" cy="9" r="2.2"/></svg></div>
  <h3>Pet Preparedness Packet</h3><p>$65</p></section>`;
const paw = strip(pawHtml);
check('the section text is still there', /Pet Preparedness Packet/.test(paw), paw.slice(0, 120));
check('and the icon is now visible to the checker', /icon/i.test(paw), paw);
check('named by the class the author gave it', /paw/i.test(paw),
  'a request for "a paw icon" is only checkable if the word paw survives');

section('V1b  this is exactly the case that was failing');
check('the string a reviewer would search for is present',
  /paw/i.test(paw) && /Pet Preparedness Packet/.test(paw),
  'both the request\'s subject and its visual are in the text now');

section('V2  images keep their alt text and their filename');
const imgs = strip('<img src="/images/angie-founder.jpg" alt="Angie, founder of One More Thing">');
check('alt text survives', /Angie, founder/.test(imgs), imgs);
check('and the filename survives', /angie-founder\.jpg/.test(imgs), imgs);
const noAlt = strip('<img src="/images/hero-banner.webp">');
check('an unlabelled image still reports its filename', /hero-banner\.webp/.test(noAlt), noAlt);
const bare = strip('<img>');
check('and an image with neither is still reported as an image',
  /image/.test(bare), bare);

section('V3  what was already working still works');
check('link targets are still preserved',
  /\[link: https:\/\/buy\.stripe\.com\/abc\]/.test(strip('<a href="https://buy.stripe.com/abc">Pay</a>')),
  'a button carrying a payment URL is the other thing text-stripping used to lose');
check('script contents are still removed',
  !/secretValue/.test(strip('<script>var secretValue=1</script><p>hi</p>')));
check('style contents are still removed',
  !/display:none/.test(strip('<style>.x{display:none}</style><p>hi</p>')));
check('block tags still become line breaks',
  strip('<h2>One</h2><h2>Two</h2>').includes('\n'),
  'four date cards used to read as one ambiguous sentence; that fix must survive');

section('V4  NEGATIVE CONTROL: a page with no visual says so');
const plain = strip('<section><h2>Mobile Notary</h2><p>Keep exactly as is.</p></section>');
check('no icon is invented where there is none', !/\[icon/.test(plain), plain);
check('no image is invented either', !/\[image/.test(plain), plain);
check('and the real text is intact', /Mobile Notary/.test(plain), plain);

section('V5  a real page, end to end');
// Angie's actual markup shape: heading, icon tile, price, and a notary block
// that must be left alone.
const page = `<main>
  <section><h2>The One More Thing Clarity Package</h2><p>$349</p>
    <ul><li>Emergency contact setup</li><li>Medical snapshot</li></ul></section>
  <section><div class="paw-icon"><svg class="paw"><circle/></svg></div>
    <h2>Pet Preparedness Packet</h2><p>$65</p></section>
  <section><h2>Mobile notarization</h2><p>$10 /signature</p></section>
</main>`;
const outp = strip(page);
for (const want of ['Clarity Package', '349', 'Pet Preparedness Packet', '65', 'Mobile notarization', '10']) {
  check(`"${want}" is in the verifier's view`, outp.includes(want), outp.slice(0, 160));
}
check('and so is the paw icon', /paw/i.test(outp),
  'which is the one thing it could not see before, and the only reason the ticket stayed open');

done();
