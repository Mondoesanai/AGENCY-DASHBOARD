// Cold outreach cannot route through the account that emails paying clients.
//
// R19.6. Resend's acceptable-use policy prohibits unsolicited outreach, and
// Resend is the account that delivers client reports and revision mail. A
// single spam complaint against prospecting would put that account at risk, so
// the two must be unable to share a sender — not by convention, by refusal.
//
// The separation used to hold only because `getEmailAdapter` happened to know
// about one provider. That is true until somebody adds a second. These checks
// are against the RULE: an adapter is built only for a provider whose entry
// says its terms permit cold outreach.
//
// Three things are checked, and the third is the one that is easy to break
// while fixing the first two: client reports must still send.

import { check, section, done } from './world.mjs';
import {
  PROVIDERS, RECOMMENDED, getEmailAdapter, coldSenderDependency, sendReadiness,
} from '../lib/outreach-email.js';

const RESEND_ONLY = { RESEND_API_KEY: 're_fake_key_for_test', REPORT_FROM: 'reports@example.test' };
const COLD_OK = { INSTANTLY_API_KEY: 'inst_fake_key_for_test' };

// ---------------------------------------------------------------------------
section('S1  each category has a named sender');
check('Resend is recorded as a provider', !!PROVIDERS.resend);
check('and recorded as NOT permitting cold outreach', PROVIDERS.resend.permitsColdOutreach === false);
check('and says why in plain language', /transactional|opt-in/i.test(PROVIDERS.resend.why), PROVIDERS.resend.why);
check('the recommended cold sender permits it', PROVIDERS[RECOMMENDED].permitsColdOutreach === true);
check('and is a different account entirely',
  PROVIDERS[RECOMMENDED].envKey !== PROVIDERS.resend.envKey);

section('S2  a present Resend key never yields a cold adapter');
const withResend = getEmailAdapter({ env: RESEND_ONLY, fetchImpl: async () => { throw new Error('must not be called'); } });
check('the cold adapter is NOT configured', withResend.configured() === false);
check('and it is not a Resend adapter', withResend.name !== 'resend', withResend.name);
check('creating a campaign is refused', (await withResend.createCampaign({})).ok === false);
check('adding leads is refused', (await withResend.addLeads('c', [{}])).ok === false);
check('and the refusal names the reason, rather than looking like a missing key',
  /do not permit cold outreach|not permit/i.test((await withResend.createCampaign({})).error || ''),
  (await withResend.createCampaign({})).error);
check('while saying the account is still in use for client reports',
  /client reports/i.test((await withResend.createCampaign({})).error || ''));

section('S2b  NEGATIVE CONTROL: a permitted sender DOES yield an adapter');
const withCold = getEmailAdapter({ env: COLD_OK, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }) });
check('a permitted provider is connected', withCold.configured() === true,
  'without this, every check above would pass simply because nothing is ever connected');
check('and it is the recommended one', withCold.name === RECOMMENDED, withCold.name);

section('S2c  both keys present: the permitted one wins, not the forbidden one');
const both = getEmailAdapter({ env: { ...RESEND_ONLY, ...COLD_OK }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }) });
check('the cold sender is used', both.name === RECOMMENDED, both.name);
check('and it is configured', both.configured() === true,
  'the production environment WILL have a Resend key — it must not disable prospecting either');

// ---------------------------------------------------------------------------
section('S3  the cold sender is an owner dependency, not a default');
const dep = coldSenderDependency({ env: RESEND_ONLY });
check('nothing has been selected', dep.selected === null,
  'Instantly is a recommendation; no account has been opened');
check('it is named as what blocks cold email', dep.blocksColdEmail === true);
check('the recommendation is still given', dep.recommended === RECOMMENDED);
check('the owner action says what to do', /Choose and open an account/i.test(dep.ownerAction), dep.ownerAction);
check('and says Resend specifically cannot be used',
  /Resend cannot be used/i.test(dep.ownerAction), dep.ownerAction);
check('naming the actual reason, not a preference',
  /acceptable-use policy|prohibits/i.test(dep.ownerAction), dep.ownerAction);

const chosen = coldSenderDependency({ env: COLD_OK });
check('NEGATIVE CONTROL: with a permitted key it reports selected', chosen.selected === RECOMMENDED);
check('and stops blocking', chosen.blocksColdEmail === false);
check('with no leftover owner action', chosen.ownerAction === null);

// Resend alone must never satisfy it.
const resendIsNotEnough = coldSenderDependency({ env: RESEND_ONLY });
check('a Resend key does not satisfy the dependency', resendIsNotEnough.selected === null,
  'the key IS set in production — it must not read as a cold sender being available');

section('S3b  readiness names it as a blocker');
const readiness = await sendReadiness({ env: RESEND_ONLY });
check('outreach is not ready', readiness.ready === false);
const codes = (readiness.blockers || []).map((b) => b.code);
check('and the missing cold sender is one of the reasons', codes.includes('no-cold-sender'), codes.join(', '));
const blocker = (readiness.blockers || []).find((b) => b.code === 'no-cold-sender');
check('marked as needing the owner', blocker.ownerAction === true);
check('with the same wording the dependency gives', blocker.text === dep.ownerAction);

// ---------------------------------------------------------------------------
section('S4  the client-report path is untouched');
// The thing most easily broken while separating the two: Resend still has to
// send reports and revision mail. Its senders must not consult the cold-email
// adapter at all.
import { readFile } from 'node:fs/promises';
const alerts = await readFile(new URL('../lib/alerts.js', import.meta.url), 'utf8');
const revisions = await readFile(new URL('../lib/revisions.js', import.meta.url), 'utf8');

check('alerts still sends via Resend', /new Resend\(/.test(alerts));
check('revision mail still sends via Resend', /new Resend\(/.test(revisions));
check('neither consults the cold-email adapter',
  !/getEmailAdapter/.test(alerts) && !/getEmailAdapter/.test(revisions),
  'client mail must not be able to be disabled by a prospecting blocker');
check('and neither imports the outreach module at all',
  !/outreach-email/.test(alerts) && !/outreach-email/.test(revisions));

const { statusOf, INTEGRATIONS } = await import('../lib/integrations.js');
check('the integrations list knows about Resend', !!INTEGRATIONS?.resend,
  'no `|| fallback` here: a missing entry must fail, not quietly satisfy the check');
check('and describes it as client mail only',
  /Not used for outreach/i.test(INTEGRATIONS.resend.what), INTEGRATIONS.resend.what);
check('and statusOf exists for it', typeof statusOf === 'function');

section('S4b  the two categories cannot be confused in the health view');
const { systemHealth } = await import('../lib/health.js');
const health = await systemHealth({ env: RESEND_ONLY }).catch(() => null);
check('health reports something', !!health);
const text = JSON.stringify(health || {});
check('a configured Resend is not reported as outreach being ready',
  !/outreach.{0,40}ready.{0,10}true/i.test(text),
  'the one conflation that would matter: a client-mail key reading as a prospecting capability');

done();
