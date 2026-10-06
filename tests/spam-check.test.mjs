// The safety check that was refusing ordinary English.
//
// `looksSpammy` guards text we are about to write to a real client's live site.
// It has two jobs that pull against each other: catch what would get a client
// penalised, and let normal writing through. It was failing the second so badly
// that the first stopped mattering — revisions backed up because almost every
// substantial copy change was refused as "keyword stuffing".
//
// Both halves are checked here, and the second half is the one that matters:
// a check that refuses everything is not a strict check, it is a broken one.

import { check, section, done } from './world.mjs';
import { looksSpammy } from '../lib/agent.js';

// ---------------------------------------------------------------------------
section('K1  ordinary English is not keyword stuffing');

const plainProse = '<p>We are a family run detailing business based in Glade Hill. We come to you, '
  + 'so you do not have to drop the car off anywhere or wait around in a lobby. We bring the water, '
  + 'the power and everything else we need. You pick the time that works and we turn up. Most of the '
  + 'work takes about two hours, and we will tell you before we start if it is going to take longer.</p>';
check('a normal paragraph is allowed', looksSpammy(plainProse) === false,
  'the word "we" is 9% of this against the old 6% ceiling — this is the check that stopped revisions');

const aboutPage = '<p>The shop opened in 2019 and has been run by the same two people since. '
  + 'They started out washing boats at the lake on weekends and the work grew from there. '
  + 'Today the team covers most of the county, and the van carries everything needed to finish '
  + 'a job in one visit without plugging into anything at the property. Appointments are usually '
  + 'available within the week, and sooner when the weather is good.</p>';
check('a normal About paragraph is allowed', looksSpammy(aboutPage) === false);

section('K2  structural repetition is structure, not stuffing');
const fields = ['Full name', 'Phone number', 'Email address', 'Street address', 'City', 'ZIP code',
  'Vehicle make', 'Vehicle model', 'Vehicle year', 'Preferred date', 'Preferred time', 'Notes'];
// A field repeats its own label in three places by design.
const intakeForm = '<form>' + fields.map((l) =>
  `<label>${l}</label><input placeholder="${l}" required aria-label="${l}">`).join('')
  + '<p>Your phone number is required so we can confirm the appointment and reach you on the day.</p></form>';
check('a twelve-field intake form is allowed', looksSpammy(intakeForm) === false,
  'this is the exact change that was refused on a real client site');

const packages = ['Basic', 'Better', 'Best', 'Boat', 'Interior', 'Exterior', 'Ceramic',
  'Headlight', 'Engine', 'Monthly', 'Weekly', 'Fleet', 'Showroom', 'Express'];
const priceList = '<ul>' + packages.map((p, i) =>
  `<li>${p} Package — mobile detailing package starting at $${100 + i * 20} per package</li>`).join('') + '</ul>';
check('a fourteen-row price list is allowed', looksSpammy(priceList) === false,
  'fourteen packages containing the word "Package" is a price list');

const faq = '<div>' + Array.from({ length: 12 }, (_, i) =>
  `<h3>Do you detail boats near Smith Mountain Lake (${i})?</h3>`
  + '<p>Yes, we detail boats and we detail cars and we detail trucks across the whole area.</p>').join('') + '</div>';
check('a twelve-question FAQ is allowed', looksSpammy(faq) === false);

const nav = '<nav>' + ['Home', 'About', 'Services', 'Gallery', 'FAQ', 'Blog', 'Book', 'Contact',
  'Pricing', 'Reviews', 'Areas', 'Boats'].map((l) => `<a href="/${l.toLowerCase()}">${l}</a>`).join('') + '</nav>';
check('a twelve-item nav is allowed', looksSpammy(nav) === false);

section('K2b  the original regression stays fixed');
const SOCIAL = '<title>Apostello Detailing — Mobile Detailing in Glade Hill</title>'
  + '<meta name="description" content="Mobile car and boat detailing in Glade Hill, Virginia.">'
  + '<meta property="og:title" content="Apostello Detailing — Mobile Detailing in Glade Hill">'
  + '<meta property="og:description" content="Mobile car and boat detailing in Glade Hill, Virginia.">'
  + '<meta name="twitter:title" content="Apostello Detailing — Mobile Detailing in Glade Hill">'
  + '<meta name="twitter:description" content="Mobile car and boat detailing in Glade Hill, Virginia.">';
check('a title reused across social tags is still allowed', looksSpammy(SOCIAL) === false,
  'the earlier fix for this must survive');

// ---------------------------------------------------------------------------
section('K3  NEGATIVE CONTROLS: real stuffing is still caught');
// Without these, everything above would pass simply because nothing is ever
// refused — which is the failure being fixed, in the opposite direction.

const wordStuffing = '<p>best bookkeeping bookkeeping bookkeeping services bookkeeping dallas '
  + 'bookkeeping bookkeeper bookkeeping cheap bookkeeping near me bookkeeping '
  + 'we do bookkeeping and more bookkeeping for you and bookkeeping '.repeat(4) + '</p>';
check('a word repeated through a paragraph is still refused', looksSpammy(wordStuffing) === true,
  JSON.stringify(wordStuffing.slice(0, 80)));

const phraseStuffing = '<p>Looking for mobile detailing roanoke? Our mobile detailing roanoke team '
  + 'offers mobile detailing roanoke at the best price. When you need mobile detailing roanoke '
  + 'call the mobile detailing roanoke experts for mobile detailing roanoke today.</p>';
check('a PHRASE repeated through a paragraph is refused', looksSpammy(phraseStuffing) === true,
  'this is the pattern stuffing actually takes, and a single-word ratio can miss it');

const cityStuffing = '<p>We serve Roanoke, detailing Roanoke, car detailing Roanoke, boat detailing '
  + 'Roanoke, mobile detailing Roanoke, auto detailing Roanoke, interior detailing Roanoke, '
  + 'exterior detailing Roanoke, ceramic detailing Roanoke, fleet detailing Roanoke.</p>';
check('a city-name list stuffed into prose is refused', looksSpammy(cityStuffing) === true);

section('K3b  the two checks are independent');
// A phrase repeated often enough to be caught by the shingle check, inside copy
// whose single-word density is unremarkable.
const phraseOnly = '<p>Book a slot today. ' + 'We handle cars and boats. '.repeat(6)
  + 'Prices vary with size, condition and how far we travel, and we will quote before starting.</p>';
check('a repeated sentence is caught by the phrase check',
  looksSpammy(phraseOnly) === true,
  'no single word dominates here — only the repetition does');

section('K4  short changes are not guessed at');
check('a one-line change is allowed', looksSpammy('<p>Call us on (555) 555-0101.</p>') === false,
  'there is not enough text to say anything about density, and guessing refuses real edits');
check('empty is allowed', looksSpammy('') === false);
check('null is allowed', looksSpammy(null) === false);

section('K5  it judges copy, not code');
const styled = '<style>.a{color:red}.a{color:red}.a{color:red}</style>'
  + '<script>var x=1;var x=1;var x=1;var x=1;var x=1;var x=1;</script>'
  + plainProse;
check('script and style are not counted as copy', looksSpammy(styled) === false,
  'repetition in code is not a claim made to a reader');

done();
