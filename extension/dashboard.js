const C = PS5Config;
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

const MODE_HELP = {
  monitor: 'Monitor: alerts your phone and PC the moment it is in stock. Never adds to cart.',
  dryrun: 'Dry run: on a drop it adds to cart and goes all the way to Place Order, then stops and alerts you to click it.',
  armed: 'ARMED: on a drop it buys automatically: one console, at or under your max price, new, sold by the store itself.',
};
const STATE_PILL = {
  in_stock: ['IN STOCK', 'ok'],
  out_of_stock: ['Sold out', 'neutral'],
  queue: ['Queue open', 'warn'],
  invite: ['Invite only', 'warn'],
  blocked: ['Blocked', 'bad'],
  error: ['Error', 'bad'],
  unknown: ["Can't tell", 'warn'],
};

let settings = C.resolveSettings({});
let lastState = null;

async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  settings = C.resolveSettings(saved);
  for (const k of ['priceCap', 'minPrice', 'fetchIntervalSec', 'reloadIntervalSec', 'jitterPct', 'cvv']) $(k).value = settings[k];
  $('cacheBust').checked = !!settings.cacheBust;
  for (const k of ['ntfyTopic', 'ntfyServer', 'pushoverUser', 'pushoverToken', 'discordWebhook']) $(k).value = settings.alerts[k] || '';
  $('desktop').checked = !!settings.alerts.desktop;
  $('siren').checked = !!settings.alerts.siren;
  $('overrides').value = JSON.stringify(settings.overrides || {}, null, 2);
  buildStoreRows();
  renderMode();
}

async function persist() {
  await chrome.storage.local.set({ settings });
}

function buildStoreRows() {
  const tbody = document.querySelector('#stores tbody');
  tbody.textContent = '';
  for (const [id, def] of Object.entries(C.STORES)) {
    const tr = document.createElement('tr');
    tr.dataset.store = id;
    tr.innerHTML = `
      <td><input type="checkbox" class="enabled" aria-label="Watch ${def.name}"></td>
      <td><b>${def.name}</b></td>
      <td><input type="url" class="url" spellcheck="false" placeholder="${def.productUrl || 'Paste the PS5 Pro listing link'}"></td>
      <td class="state"><span class="pill neutral">-</span></td>
      <td class="price">-</td>
      <td class="seller" title="">-</td>
      <td class="age">-</td>
      <td><button class="small practice">Practice</button></td>`;
    const s = settings.stores[id] || {};
    tr.querySelector('.enabled').checked = !!s.enabled;
    tr.querySelector('.url').value = s.productUrl || '';
    tr.querySelector('.practice').addEventListener('click', () => runPractice(id, def.name));
    tbody.appendChild(tr);
  }
}

function readForm() {
  const num = (id) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : C.DEFAULT_SETTINGS[id];
  };
  settings.priceCap = num('priceCap');
  settings.minPrice = num('minPrice');
  settings.fetchIntervalSec = Math.max(0, num('fetchIntervalSec'));
  settings.reloadIntervalSec = Math.max(5, num('reloadIntervalSec'));
  settings.jitterPct = Math.min(80, Math.max(0, num('jitterPct')));
  settings.cacheBust = $('cacheBust').checked;
  settings.cvv = $('cvv').value.trim();
  for (const k of ['ntfyTopic', 'ntfyServer', 'pushoverUser', 'pushoverToken', 'discordWebhook']) settings.alerts[k] = $(k).value.trim();
  if (!settings.alerts.ntfyServer) settings.alerts.ntfyServer = 'https://ntfy.sh';
  settings.alerts.desktop = $('desktop').checked;
  settings.alerts.siren = $('siren').checked;
  for (const tr of document.querySelectorAll('#stores tbody tr')) {
    const id = tr.dataset.store;
    settings.stores[id] = { enabled: tr.querySelector('.enabled').checked, productUrl: tr.querySelector('.url').value.trim() };
  }
}

function renderMode() {
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode));
  $('modeHelp').textContent = MODE_HELP[settings.mode] || '';
}

async function setMode(mode) {
  if (mode === 'armed' && settings.mode !== 'armed') {
    const ok = confirm(
      `Arm automatic buying?\n\nOn a drop it will place a real order for one PS5 Pro at up to $${settings.priceCap}, using the address and card saved in each store account.\n\nMake sure Practice passed at every store you have enabled and that their carts are empty.`
    );
    if (!ok) return renderMode();
  }
  settings.mode = mode;
  await persist();
  renderMode();
}

async function runPractice(id, name) {
  const url = prompt(
    `Practice checkout at ${name}\n\nPaste a link to any cheap, in-stock item sold by ${name}. It adds it to the cart and goes to the Place Order step, then stops. Nothing is bought.\n\nBe signed in to ${name} in this Chrome profile first.`
  );
  if (!url) return;
  const r = await send({ type: 'practice', storeId: id, url: url.trim() });
  if (r && r.error) alert(r.error);
}

function ago(ts) {
  if (!ts) return '-';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}

function renderState(state) {
  lastState = state;
  const rt = state.rt;
  const btn = $('startStop');
  btn.textContent = rt.running ? 'Stop' : 'Start';
  btn.className = rt.running ? 'danger' : 'primary';

  const banner = $('banner');
  banner.textContent = '';
  const addBanner = (cls, text, action) => {
    const div = document.createElement('div');
    div.className = 'banner ' + cls;
    const span = document.createElement('span');
    span.textContent = text;
    div.appendChild(span);
    if (action) {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      div.appendChild(b);
    }
    banner.appendChild(div);
  };
  if (state.purchased) {
    addBanner('ok', `Ordered at ${C.STORES[state.purchased.storeId].name} on ${new Date(state.purchased.at).toLocaleString()}. Disarmed.`, {
      label: 'Hunt again',
      run: async () => {
        if (confirm('Clear the "already bought" flag so it can buy another?')) await send({ type: 'resetPurchased' });
      },
    });
  }
  if (rt.lock) {
    addBanner('warn', `Order lock held by ${C.STORES[rt.lock.storeId].name}${rt.lock.clicked ? ' (Place Order was pressed)' : ''}. Other stores won't place orders until it's released.`, {
      label: 'Release order lock',
      run: async () => {
        if (confirm('Only release this if you checked and the order did NOT go through.')) await send({ type: 'releaseLock' });
      },
    });
  }
  if (rt.running && !settings.alerts.ntfyTopic && !settings.alerts.pushoverUser && !settings.alerts.discordWebhook) {
    addBanner('warn', 'Running without phone alerts. Set an ntfy topic below so you hear about drops away from the PC.');
  }

  for (const tr of document.querySelectorAll('#stores tbody tr')) {
    const id = tr.dataset.store;
    const st = rt.status[id];
    const watching = rt.running && rt.watchers[id] != null;
    const paused = rt.paused[id];
    const enabled = tr.querySelector('.enabled').checked;
    const hasLink = !!(tr.querySelector('.url').value.trim() || C.STORES[id].productUrl);
    let label = enabled && !hasLink ? ['Needs link', 'warn'] : ['Off', 'neutral'];
    if (watching && !st) label = ['Loading', 'neutral'];
    if (st) label = STATE_PILL[st.state] || [st.state, 'neutral'];
    if (paused === 'checkout') label = ['Checking out', 'ok'];
    if (st && st.state === 'in_stock' && st.verdict && !st.verdict.ok) label = ['In stock (skipped)', 'warn'];
    const pill = tr.querySelector('.state');
    pill.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'pill ' + label[1];
    span.textContent = label[0];
    span.title = st ? [st.verdict && st.verdict.reasons.join('; '), st.error, st.signals && JSON.stringify(st.signals)].filter(Boolean).join('\n') : '';
    pill.appendChild(span);
    tr.querySelector('.price').textContent = st && st.price != null ? st.price.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '-';
    const sellerCell = tr.querySelector('.seller');
    const seller = st ? (st.firstParty === true ? 'Store' : st.firstParty === false ? '3rd party' : 'Unknown') + (st.seller ? ': ' + st.seller : '') : '-';
    sellerCell.textContent = seller;
    sellerCell.title = seller;
    tr.querySelector('.age').textContent = st ? `${ago(st.at)} (${st.source})` : '-';
  }

  const ol = $('log');
  ol.textContent = '';
  for (const e of state.log.slice().reverse()) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = new Date(e.at).toLocaleTimeString();
    const k = document.createElement('span');
    k.className = 'kind k-' + e.kind;
    k.textContent = e.kind.replace('_', ' ');
    const m = document.createElement('span');
    m.textContent = e.text;
    li.append(t, k, m);
    ol.appendChild(li);
  }
}

async function refresh() {
  const state = await send({ type: 'state' });
  if (state) renderState(state);
}

function randomTopic() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return 'ps5pro-' + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

$('startStop').addEventListener('click', async () => {
  if (lastState && lastState.rt.running) {
    await send({ type: 'stop' });
  } else {
    readForm();
    await persist();
    const r = await send({ type: 'start' });
    if (r && r.error) alert(r.error);
  }
  refresh();
});

$('save').addEventListener('click', async () => {
  readForm();
  await persist();
  $('saveMsg').textContent = 'Saved. Running watchers pick up the new settings right away.';
  setTimeout(() => ($('saveMsg').textContent = ''), 4000);
});

$('testAlert').addEventListener('click', async () => {
  readForm();
  await persist();
  await send({ type: 'testAlert' });
  $('saveMsg').textContent = 'Test alert sent. Check your phone.';
});

$('genTopic').addEventListener('click', () => {
  $('ntfyTopic').value = randomTopic();
});

$('clearLog').addEventListener('click', async () => {
  await send({ type: 'clearLog' });
  refresh();
});

$('saveOverrides').addEventListener('click', async () => {
  try {
    const parsed = JSON.parse($('overrides').value || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object keyed by store id');
    const unknown = Object.keys(parsed).filter((k) => !C.STORES[k]);
    if (unknown.length) throw new Error('unknown store id: ' + unknown.join(', '));
    settings.overrides = parsed;
    await persist();
    $('overridesMsg').textContent = 'Overrides saved.';
  } catch (e) {
    $('overridesMsg').textContent = 'Not saved: ' + e.message;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = C.resolveSettings(changes.settings.newValue);
    renderMode();
  }
});

loadSettings().then(refresh);
setInterval(refresh, 1000);
