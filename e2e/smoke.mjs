// Drives the real app in a real browser against a running demo server.
// Usage: npm run demo (in one terminal), then: node e2e/smoke.mjs [screenshot-dir]
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4310';
const shots = process.argv[2];
// Fake microphones give both call tabs a real audio stream to send over WebRTC.
// Real Chrome, because macOS's firewall blocks call audio to Playwright's unsigned browser.
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1360, height: 840 }, permissions: ['microphone'] });
// Keeps a handle on each call so the test can measure the audio itself.
await context.addInitScript(() => {
  const Native = RTCPeerConnection;
  window.__peers = [];
  window.RTCPeerConnection = function (...args) { const pc = new Native(...args); window.__peers.push(pc); return pc; };
  window.RTCPeerConnection.prototype = Native.prototype;
});
const audioBytes = (p) => p.evaluate(async () => {
  let bytes = 0;
  (await window.__peers.at(-1).getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes += s.bytesReceived; });
  return bytes;
});
async function assertAudioBothWays() {
  await page.waitForTimeout(1500);
  const [a, b] = [await audioBytes(page), await audioBytes(phone)];
  assert.ok(a > 1000 && b > 1000, `audio not flowing: agent ${a} bytes, customer ${b} bytes`);
  return `${a} and ${b} bytes`;
}
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) problems.push(`console: ${m.text()}`); });
const shot = async (name, p = page) => { if (shots) await p.screenshot({ path: `${shots}/${name}.png` }); };
const step = (s) => console.log(`  ✓ ${s}`);

await page.goto(BASE);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('link', { name: /Maya Fictional/ }).click();
await page.locator('.bubble', { hasText: 'Can I pick it up today?' }).waitFor();
await shot('inbox');
step('signed in and opened a seeded chat');

// Agent replies with a styled message.
const box = page.getByLabel('Message', { exact: true });
await box.fill('Your pair is ready');
await page.getByRole('button', { name: /Style/ }).click();
await page.getByRole('menuitem', { name: /𝓨/ }).click();
assert.equal(await box.inputValue(), '𝓨𝓸𝓾𝓻 𝓹𝓪𝓲𝓻 𝓲𝓼 𝓻𝓮𝓪𝓭𝔂');
await page.getByRole('button', { name: 'Send', exact: true }).click();
await page.locator('.bubble', { hasText: '𝓨𝓸𝓾𝓻 𝓹𝓪𝓲𝓻 𝓲𝓼 𝓻𝓮𝓪𝓭𝔂' }).waitFor();
await page.locator('.bubble.out').last().locator('svg[aria-label="Read"]').waitFor({ timeout: 6000 });
step('sent a styled message and watched it reach two read ticks live');

// A second tab plays the customer through the simulator.
const phone = await context.newPage();
await phone.goto(`${BASE}/#/simulator`);
await phone.getByRole('textbox', { name: 'Phone' }).fill('+15550142');
await phone.getByLabel('Channel').selectOption({ label: 'Simulator: Sales' });
await phone.getByLabel('Customer message').fill('You are the best, thanks!');
await phone.getByRole('button', { name: 'Send', exact: true }).click();
await page.locator('.bubble', { hasText: 'You are the best, thanks!' }).waitFor();
await page.locator('svg[aria-label="Replied: the third tick"]').last().waitFor();
await shot('third-tick');
step('customer reply arrived live and lit the third tick');

// Bot flow from a brand new customer.
await phone.getByRole('textbox', { name: 'Phone' }).fill('+15550199');
await phone.getByLabel('Customer message').fill('menu');
await phone.getByRole('button', { name: 'Send', exact: true }).click();
await phone.getByRole('button', { name: 'Track order' }).click();
await phone.getByText("What's your order number?").waitFor();
await phone.getByLabel('Customer message').fill('A-1234');
await phone.getByRole('button', { name: 'Send', exact: true }).click();
await phone.getByText('Order A-1234 is on the way').waitFor();
await shot('simulator', phone);
step('bot ran buttons, a question, and filled a saved variable');

// Customer calls in, agent answers, real WebRTC audio connects between the tabs.
await page.goto(`${BASE}/#/inbox`);
await phone.getByRole('button', { name: '📞 Call' }).click();
const dock = page.getByRole('alertdialog', { name: 'Incoming call' });
await dock.getByRole('button', { name: 'Answer' }).click();
await page.locator('[data-testid="call-state"][data-net="connected"]').waitFor({ timeout: 15000 });
await phone.getByTestId('sim-call-state').getByText('Connected').waitFor({ timeout: 15000 });
const inboundAudio = await assertAudioBothWays();
await shot('call-active');
await page.getByRole('button', { name: 'Hang up' }).click();
await phone.getByRole('button', { name: '📞 Call' }).waitFor();
await page.locator('.sys', { hasText: 'Call ended after' }).waitFor();
step(`customer called, agent answered, audio flowed both ways (${inboundAudio}), call logged`);

// Agent calls out, customer picks up.
await page.getByRole('button', { name: '📞 Call' }).click();
await phone.getByText('The business is calling').waitFor();
await phone.getByRole('button', { name: 'Answer' }).click();
await page.locator('[data-testid="call-state"][data-net="connected"]').waitFor({ timeout: 15000 });
const outboundAudio = await assertAudioBothWays();
await phone.getByRole('button', { name: 'Hang up' }).click();
await page.locator('.call-dock').waitFor({ state: 'detached' });
step(`agent called out, customer answered, audio flowed both ways (${outboundAudio}), dock closed itself`);

// Form inside the chat.
await page.getByRole('button', { name: /📋 Form/ }).click();
await page.getByRole('button', { name: /Book a fitting/ }).click();
await phone.getByRole('button', { name: 'Book now' }).click();
await phone.getByLabel('Preferred day').selectOption('Friday');
await phone.getByLabel('Shoe size').fill('9');
await phone.getByRole('button', { name: 'Submit' }).click();
await page.locator('.bubble', { hasText: 'Form submitted' }).waitFor();
await page.locator('dd', { hasText: 'Friday' }).waitFor();
step('sent a form, customer filled it in, answers landed on the contact');

// Log a sale.
page.once('dialog', (d) => d.accept('49.99'));
await page.getByRole('button', { name: /Log a sale/ }).click();
await page.getByText(/Sale logged/).waitFor();
step('logged a sale');

// Opt out.
await phone.getByRole('button', { name: 'STOP', exact: true }).click();
await phone.getByText("You're unsubscribed").waitFor();
step('STOP opted the customer out');
await phone.close();

// Note, magic reply and summary.
await page.getByRole('tab', { name: 'Internal note' }).click();
await page.getByLabel('Internal note').fill('VIP, be nice');
await page.getByRole('button', { name: 'Add note' }).click();
await page.locator('.note', { hasText: 'VIP, be nice' }).waitFor();
await page.getByRole('tab', { name: 'Reply' }).click();
await page.getByRole('button', { name: /Magic reply/ }).click();
await page.locator('.magic .chip').first().waitFor();
await page.getByRole('button', { name: 'Summarise chat' }).click();
await page.locator('.summary').waitFor();
step('added a note, got magic replies and a summary');

// Broadcast.
await page.goto(`${BASE}/#/campaigns`);
await page.getByRole('button', { name: 'New broadcast' }).click();
await page.getByLabel('Name').fill('Spring drop');
await page.getByLabel('Audience').selectOption({ index: 1 });
await page.getByRole('button', { name: 'Create broadcast' }).click();
await page.getByText('done', { exact: true }).first().waitFor({ timeout: 15000 });
await page.getByText('Skipped:').first().waitFor({ timeout: 3000 }).catch(() => {});
await shot('campaigns');
step('broadcast sent through the scheduler');

// Call list.
await page.getByRole('tab', { name: 'Call lists' }).click();
await page.getByRole('button', { name: 'New call list' }).click();
await page.getByLabel('Name').fill('VIP check-ins');
await page.getByLabel('Who').selectOption({ label: 'VIPs' });
await page.getByLabel('Call script').fill('Hi! Just checking in on your last order.');
await page.getByRole('button', { name: 'Create list' }).click();
await page.getByRole('button', { name: 'Next call' }).click();
await page.getByText('Now calling').waitFor();
await page.getByRole('button', { name: /Interested/ }).first().click();
await page.getByText('interested: 1').waitFor();
await shot('call-lists');
step('worked a call list and recorded an outcome');

// Integrations.
await page.goto(`${BASE}/#/settings`);
await page.getByRole('tab', { name: 'Integrations' }).click();
await page.getByRole('heading', { name: /Inbound hook/ }).locator('..').getByRole('button', { name: 'Connect' }).click();
await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
const hook = await page.locator('pre.snippet').innerText();
await page.getByRole('button', { name: 'Close' }).click();
const added = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+15550399', name: 'Hooked Lead', tags: ['tally'] }) });
assert.equal(added.status, 200);
await page.goto(`${BASE}/#/contacts`);
await page.getByText('Hooked Lead').waitFor();
await shot('integrations-contacts');
step('connected an inbound hook and a contact arrived through it');

// Installable app.
const sw = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state);
assert.ok(['activating', 'activated'].includes(sw));
const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
assert.equal((await fetch(`${BASE}/icon-512.png`)).status, 200);
await page.evaluate(() => caches.keys()).then(async () => {
  const leaked = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls = (await Promise.all(names.map(async (n) => (await (await caches.open(n)).keys()).map((r) => r.url)))).flat();
    return urls.filter((u) => u.includes('/api/'));
  });
  assert.deepEqual(leaked, []);
});
step('service worker active, installable, and no API data cached');

// Every page renders, in every theme family.
for (const route of ['tools', 'contacts', 'bots', 'bots/1', 'knowledge', 'analytics', 'arena', 'vibe', 'tools', 'settings']) {
  await page.goto(`${BASE}/#/${route}`);
  await page.locator('h1').first().waitFor();
  await page.waitForTimeout(250);
  await shot(route.replace('/', '-'));
}
step('every page rendered');

for (const name of ['Neon Arcade', 'Brutal Banana', 'Comic Book', 'Terminal', 'Paper & Ink']) {
  await page.goto(`${BASE}/#/vibe`);
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.goto(`${BASE}/#/inbox/1`);
  await page.locator('.bubble', { hasText: 'Can I pick it up today?' }).waitFor();
  await page.waitForTimeout(250);
  await shot(`theme-${name.split(' ')[0].toLowerCase()}`);
}
step('themes applied');

await page.keyboard.press('Meta+k');
await page.getByPlaceholder(/Jump anywhere/).fill('grape');
await page.keyboard.press('Enter');
await page.reload();
await page.locator('.bubble', { hasText: 'Can I pick it up today?' }).waitFor();
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'grape');
step('command palette switched theme and it survived a reload');

await page.setViewportSize({ width: 390, height: 780 });
await page.waitForTimeout(250);
await shot('mobile-chat');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
assert.equal(overflow, false, 'page scrolls sideways on mobile');
await page.goto(`${BASE}/#/inbox`);
await page.getByRole('link', { name: /Maya Fictional/ }).waitFor();
await shot('mobile-list');
step('phone layout works with no sideways scroll');

// Agent role limits, seen through the UI.
await page.setViewportSize({ width: 1360, height: 840 });
await page.getByRole('button', { name: 'Sign out' }).click();
await page.getByLabel('Email').fill('sky@tripletick.local');
await page.getByLabel('Password').fill('tripletick');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('link', { name: /Maya Fictional/ }).click();
await page.getByText(/\+15•+142/).first().waitFor();
assert.equal(await page.getByRole('link', { name: 'Campaigns' }).count(), 0);
step('agent sees masked numbers and no admin navigation');

await browser.close();
if (problems.length) { console.error('\nBrowser problems:\n' + [...new Set(problems)].join('\n')); process.exit(1); }
console.log('\nAll flows passed with no browser errors.');
