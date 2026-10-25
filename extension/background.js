// Coordinator: opens the watcher tabs, paces checks, decides when to buy, makes
// sure only one order is ever placed, and sends alerts.
importScripts('lib/config.js', 'lib/detect.js');

const C = PS5Config;
const D = PS5Detect;

const LEVEL = {
  in_stock: 'urgent',
  needs_you: 'urgent',
  ordered: 'urgent',
  queue: 'urgent',
  placing: 'high',
  dry_run: 'high',
  failed: 'high',
  blocked: 'high',
  stale: 'high',
  invite: 'high',
  signin: 'high',
  info: 'low',
  heartbeat: 'low',
};
const STALL_MS = 30000;
const REMIND_MS = 60000;
const KEEPER_TIMEOUT_MS = 75000;

let settings = C.resolveSettings({});
let rt = freshRuntime();
let purchased = null;
let log = [];
const next = {}; // per-store check schedule; fine to lose on worker restart
const notificationTabs = {};
let tickTimer = null;

const ready = load();

function freshRuntime() {
  return {
    running: false,
    windowId: null,
    watchers: {}, // storeId -> tabId
    roles: {}, // tabId -> { role: 'watch'|'checkout', storeId, practice, ... }
    status: {}, // storeId -> last detection summary
    backoff: {}, // storeId -> { level, until, fetchLevel, fetchUntil }
    paused: {}, // storeId -> 'queue' | 'checkout'
    lock: null, // { storeId, tabId, at, clicked }
    placeClicks: {},
    attempts: {}, // storeId -> checkout start times, to stop runaway retry loops
    signin: {}, // storeId -> { state: 'ok'|'auto'|'needs_you'|'timeout', at, reason }
    signinAttempts: {}, // storeId -> password submissions, to avoid locking the account
    lastKeeper: 0,
    alerted: {},
    lastFetchReload: {},
  };
}

async function load() {
  const local = await chrome.storage.local.get(['settings', 'purchased', 'log']);
  settings = C.resolveSettings(local.settings);
  purchased = local.purchased || null;
  log = local.log || [];
  const session = await chrome.storage.session.get('rt');
  if (session.rt) rt = Object.assign(freshRuntime(), session.rt);
  if (rt.running) ensureTicking();
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.session.set({ rt });
    chrome.storage.local.set({ log: log.slice(-300) });
  }, 300);
}

function addLog(kind, text) {
  log.push({ at: Date.now(), kind, text });
  if (log.length > 400) log = log.slice(-300);
  save();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settings = C.resolveSettings(changes.settings.newValue);
});

const storeName = (id) => (C.STORES[id] ? C.STORES[id].name : id);
const store = (id) => C.resolveStore(id, settings);
const jitter = (ms) => Math.max(500, ms * (1 + ((Math.random() * 2 - 1) * settings.jitterPct) / 100));

// ------------------------------------------------------------------ alerts

async function alert(kind, title, body, opts = {}) {
  if (opts.key) {
    const last = rt.alerted[opts.key];
    if (last && Date.now() - last < (opts.dedupeMs || 60000)) return;
    rt.alerted[opts.key] = Date.now();
  }
  const level = LEVEL[kind] || 'default';
  addLog(kind, `${title}: ${body}`);
  const a = settings.alerts;
  // Tapping a "needs you" alert can open remote access to this PC instead.
  if ((kind === 'needs_you' || kind === 'signin') && a.needsYouLink) opts = { ...opts, url: a.needsYouLink };
  const jobs = [];
  if (a.desktop) jobs.push(desktopNotify(title, body, level, opts.tabId));
  if (a.siren && level === 'urgent') jobs.push(siren(kind === 'ordered' ? 6 : 15));
  if (a.ntfyTopic) jobs.push(ntfy(title, body, level, kind, opts.url));
  if (a.pushoverUser && a.pushoverToken) jobs.push(pushover(title, body, level, opts.url));
  if (a.discordWebhook) jobs.push(discord(title, body, opts.url));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') addLog('error', 'alert failed: ' + r.reason);
}

async function desktopNotify(title, message, level, tabId) {
  const id = 'ps5-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  if (tabId) notificationTabs[id] = tabId;
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    priority: level === 'urgent' ? 2 : level === 'high' ? 1 : 0,
    requireInteraction: level === 'urgent',
  });
}

chrome.notifications.onClicked.addListener((id) => {
  const tabId = notificationTabs[id];
  if (tabId) focusTab(tabId);
  chrome.notifications.clear(id);
});

async function ntfy(title, body, level, kind, url) {
  const server = settings.alerts.ntfyServer.replace(/\/+$/, '');
  const headers = {
    Title: title.replace(/[^\x20-\x7E]/g, ''),
    Priority: { urgent: '5', high: '4', default: '3', low: '2' }[level],
    Tags: { in_stock: 'rotating_light', ordered: 'tada', needs_you: 'warning', queue: 'hourglass' }[kind] || 'video_game',
  };
  if (url) headers.Click = url;
  const resp = await fetch(`${server}/${encodeURIComponent(settings.alerts.ntfyTopic)}`, { method: 'POST', body, headers });
  if (!resp.ok) throw new Error('ntfy HTTP ' + resp.status);
}

async function pushover(title, message, level, url) {
  const form = new URLSearchParams({
    token: settings.alerts.pushoverToken,
    user: settings.alerts.pushoverUser,
    title,
    message,
    priority: level === 'urgent' ? '2' : level === 'high' ? '1' : '0',
    sound: level === 'urgent' ? 'siren' : 'pushover',
  });
  if (level === 'urgent') {
    form.set('retry', '30');
    form.set('expire', '1800');
  }
  if (url) form.set('url', url);
  const resp = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body: form });
  if (!resp.ok) throw new Error('Pushover HTTP ' + resp.status);
}

async function discord(title, body, url) {
  const resp = await fetch(settings.alerts.discordWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `**${title}**\n${body}${url ? '\n' + url : ''}` }),
  });
  if (!resp.ok) throw new Error('Discord HTTP ' + resp.status);
}

async function siren(seconds) {
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Sound an alarm when a PS5 Pro is in stock or checkout needs you',
      });
    }
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'siren', seconds });
  } catch (e) {
    addLog('error', 'siren failed: ' + e);
  }
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
  } catch (_) {
    // Tab already closed.
  }
}

// ------------------------------------------------------------------ watching

function enabledStores() {
  return Object.keys(C.STORES).filter((id) => settings.stores[id] && settings.stores[id].enabled && store(id).productUrl);
}

// Opens a tab with a role already assigned, so its content script knows what to do
// on first load.
async function openRoleTab(windowId, url, role) {
  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
  rt.roles[tab.id] = role;
  await chrome.tabs.update(tab.id, { url, autoDiscardable: false });
  return tab.id;
}

async function start() {
  if (purchased) return { error: `Already bought one at ${storeName(purchased.storeId)}. Reset on the dashboard to hunt again.` };
  const ids = enabledStores();
  if (!ids.length) return { error: 'No stores enabled with a product link.' };
  if (rt.running) await stop();

  const win = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal' });
  const blankTab = win.tabs && win.tabs[0];
  rt.running = true;
  rt.windowId = win.id;
  rt.watchers = {};
  rt.paused = {};
  rt.backoff = {};
  rt.lock = null;
  rt.placeClicks = {};
  rt.attempts = {};
  rt.status = {};
  const now = Date.now();
  for (const [i, id] of ids.entries()) {
    const tabId = await openRoleTab(win.id, store(id).productUrl, { role: 'watch', storeId: id, lastReport: now });
    rt.watchers[id] = tabId;
    // Stagger stores so their checks don't all land in the same second.
    next[id] = { fetch: now + 2000 + i * 400, reload: now + jitter(settings.reloadIntervalSec * 1000) + i * 1500 };
  }
  if (blankTab) chrome.tabs.remove(blankTab.id).catch(() => {});
  ensureTicking();
  save();
  rt.lastKeeper = 0; // check sign-ins on the next keepalive tick
  const vault = await vaultState();
  const locked = vault === 'locked' ? ' The vault is LOCKED, so automatic sign-in and CVV are off until you unlock it on the dashboard.' : '';
  alert(locked ? 'signin' : 'info', 'PS5 Pro watcher started', `Watching ${ids.map(storeName).join(', ')} in ${settings.mode} mode. Price cap $${settings.priceCap}.${locked}`);
  return { ok: true };
}

async function stop() {
  rt.running = false;
  stopTicking();
  const windowId = rt.windowId;
  for (const [tabId, role] of Object.entries(rt.roles)) if (!role.practice) delete rt.roles[tabId];
  rt.windowId = null;
  rt.watchers = {};
  rt.paused = {};
  if (windowId != null) await chrome.windows.remove(windowId).catch(() => {});
  addLog('info', 'Watcher stopped');
  save();
  return { ok: true };
}

function ensureTicking() {
  if (!tickTimer) tickTimer = setInterval(tick, 1000);
}

function stopTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

function reloadTab(tabId) {
  chrome.tabs.reload(tabId, { bypassCache: true }).catch(() => {});
}

function tick() {
  if (!rt.running) return stopTicking();
  const now = Date.now();
  const fetchMs = Math.max(1, settings.fetchIntervalSec) * 1000;
  const reloadMs = Math.max(5, settings.reloadIntervalSec) * 1000;

  for (const [id, tabId] of Object.entries(rt.watchers)) {
    const role = rt.roles[tabId];
    if (!role || role.role !== 'watch' || rt.paused[id]) continue;
    const n = next[id] || (next[id] = { fetch: now + jitter(fetchMs), reload: now + jitter(reloadMs) });
    const bo = rt.backoff[id] || {};
    if (bo.until > now) continue;

    if (now >= n.reload) {
      n.reload = now + jitter(reloadMs);
      n.fetch = now + jitter(fetchMs) + 1500; // let the reloaded page settle first
      reloadTab(tabId);
    } else if (settings.fetchIntervalSec > 0 && now >= n.fetch && !(bo.fetchUntil > now)) {
      n.fetch = now + jitter(fetchMs);
      chrome.tabs.sendMessage(tabId, { type: 'fetchCheck' }).catch(() => {});
    }

    if (role.lastReport && now - role.lastReport > 3 * reloadMs + 15000) {
      role.lastReport = now;
      alert('stale', `${storeName(id)} watcher went quiet`, 'Reloading it. If this keeps happening, check that tab.', { key: 'stale:' + id, dedupeMs: 15 * 60000 });
      reloadTab(tabId);
    }
  }

  for (const [tabId, role] of Object.entries(rt.roles)) {
    // Keep nagging (every minute, 5 times) while a checkout waits on you.
    if (role.role === 'checkout' && role.waiting && role.waiting !== 'queue' && (role.reminders || 0) < 5 && now - (role.lastAlertAt || 0) > REMIND_MS) {
      role.reminders = (role.reminders || 0) + 1;
      role.lastAlertAt = now;
      alert('needs_you', `${storeName(role.storeId)} still needs you (${role.reminders}/5)`, role.waiting, { tabId: +tabId, url: role.url });
    }
    if (role.role !== 'checkout' || role.stallAlerted || role.waiting) continue;
    if (now - role.lastEvent > STALL_MS) {
      role.stallAlerted = true;
      alert('needs_you', `${storeName(role.storeId)} checkout stalled`, `No progress for 30s (last step: ${role.step || 'none'}). Take over in the open tab.`, { tabId: +tabId, url: role.url });
      focusTab(+tabId);
    }
  }
  // A stalled checkout that never pressed Place Order shouldn't block other stores.
  if (rt.lock && !rt.lock.clicked && now - rt.lock.at > 3 * 60000) {
    addLog('info', `Released ${storeName(rt.lock.storeId)}'s order lock after 3 minutes without Place Order`);
    rt.lock = null;
  }
  save();
}

function applyBackoff(id, source) {
  const bo = rt.backoff[id] || (rt.backoff[id] = { level: 0, until: 0, fetchLevel: 0, fetchUntil: 0 });
  const now = Date.now();
  if (source === 'fetch') {
    bo.fetchLevel = Math.min(bo.fetchLevel + 1, 6);
    bo.fetchUntil = now + Math.min(10 * 60000, 15000 * 2 ** bo.fetchLevel);
  } else {
    bo.level = Math.min(bo.level + 1, 6);
    bo.until = now + Math.min(15 * 60000, 30000 * 2 ** bo.level);
  }
}

function clearBackoff(id, source) {
  const bo = rt.backoff[id];
  if (!bo) return;
  if (source === 'fetch') bo.fetchLevel = 0;
  else bo.level = 0;
}

function checkoutCtx(id, practice) {
  return {
    role: 'checkout',
    storeId: id,
    store: store(id),
    checkout: { mode: settings.mode, practice: !!practice, priceCap: settings.priceCap, minPrice: settings.minPrice },
  };
}

function roleFor(tabId) {
  const role = rt.roles[tabId];
  if (!role) return { role: 'none' };
  if (role.role === 'watch') {
    role.lastReport = Date.now();
    return { role: 'watch', storeId: role.storeId, store: store(role.storeId), settings: { cacheBust: settings.cacheBust } };
  }
  if (role.role === 'checkout') {
    role.lastEvent = Date.now();
    return checkoutCtx(role.storeId, role.practice);
  }
  if (role.role === 'keeper') return { role: 'keeper', storeId: role.storeId, store: store(role.storeId) };
  return { role: 'none' };
}

function onStatus(tabId, result) {
  const role = rt.roles[tabId];
  if (!role || role.role !== 'watch') return { go: false };
  const id = role.storeId;
  const name = storeName(id);
  const s = store(id);
  role.lastReport = Date.now();
  rt.status[id] = {
    state: result.state,
    source: result.source,
    at: result.at || Date.now(),
    price: result.price ?? null,
    seller: result.seller || '',
    firstParty: result.firstParty ?? null,
    title: result.title || '',
    signals: result.signals || null,
    error: result.error || (result.httpStatus ? 'HTTP ' + result.httpStatus : ''),
  };

  if (result.state === 'error') return { go: false };
  if (result.state === 'blocked') {
    applyBackoff(id, result.source);
    const what = result.source === 'fetch' ? 'is rate-limiting the quick checks (slowing them down)' : 'is showing a bot check in the watcher tab. Solve it once so watching can continue.';
    alert('blocked', `${name} blocked a check`, `${name} ${what}`, { key: 'blocked:' + id + ':' + result.source, dedupeMs: 20 * 60000, tabId });
    return { go: false };
  }
  clearBackoff(id, result.source);

  if (result.state === 'queue') {
    if (rt.paused[id] !== 'queue') {
      rt.paused[id] = 'queue';
      alert('queue', `${name} queue is open`, `A waiting room just appeared at ${name}, which usually means a drop. Holding your place; don't close the tab.`, { key: 'queue:' + id, dedupeMs: 10 * 60000, tabId, url: s.productUrl });
    }
    return { go: false };
  }
  if (rt.paused[id] === 'queue') delete rt.paused[id];

  if (result.state === 'invite') {
    alert('invite', `${name} is invite-only`, `${name} is selling the PS5 Pro by invitation. Open the listing and press "Request invitation".`, { key: 'invite:' + id, dedupeMs: 6 * 3600000, url: s.productUrl });
    return { go: false };
  }
  if (result.state !== 'in_stock') return { go: false };

  if (result.source === 'fetch') {
    // The quick check thinks it's in stock: reload now to confirm on the real page.
    if (!rt.lastFetchReload[id] || Date.now() - rt.lastFetchReload[id] > 20000) {
      rt.lastFetchReload[id] = Date.now();
      next[id] = Object.assign(next[id] || {}, { reload: Date.now() + jitter(settings.reloadIntervalSec * 1000) });
      reloadTab(tabId);
    }
    return { go: false };
  }

  const verdict = D.evaluate(result, settings);
  rt.status[id].verdict = verdict;
  if (!verdict.ok) {
    if (verdict.alert) {
      alert('needs_you', `${name}: in stock, needs a look`, `${verdict.reasons.join('; ')}. Not buying automatically.`, { key: 'check:' + id, dedupeMs: 5 * 60000, tabId, url: s.productUrl });
    }
    return { go: false };
  }
  if (purchased) return { go: false };

  const price = result.price != null ? `$${result.price.toFixed(2)}` : '';
  const buying = settings.mode === 'armed' ? 'Buying now.' : settings.mode === 'dryrun' ? 'Dry run: going to Place Order but not clicking it.' : 'Go buy it!';
  alert('in_stock', `PS5 Pro IN STOCK at ${name}`, `${price} sold by ${name}. ${buying}`, { key: 'instock:' + id, dedupeMs: 2 * 60000, tabId, url: s.productUrl });

  if (settings.mode === 'armed' || settings.mode === 'dryrun') {
    // A checkout that keeps failing the same way (e.g. a changed page) shouldn't
    // hammer the store: at most 5 tries per store per 10 minutes.
    const recent = (rt.attempts[id] || []).filter((t) => Date.now() - t < 10 * 60000);
    if (recent.length >= 5) {
      alert('needs_you', `${name}: checkout keeps failing`, `Tried 5 times in 10 minutes. Not retrying for now. It's in stock, so try it by hand.`, { key: 'attempts:' + id, dedupeMs: 10 * 60000, tabId, url: s.productUrl });
      return { go: false };
    }
    rt.attempts[id] = recent.concat(Date.now());
    rt.roles[tabId] = { role: 'checkout', storeId: id, practice: false, startedAt: Date.now(), lastEvent: Date.now() };
    rt.paused[id] = 'checkout';
    focusTab(tabId);
    save();
    return { go: true, ctx: checkoutCtx(id, false) };
  }
  focusTab(tabId);
  return { go: false };
}

// ------------------------------------------------------------------ checkout

async function backToWatching(tabId, role) {
  if (role.practice || !rt.running || rt.watchers[role.storeId] !== tabId) {
    delete rt.roles[tabId];
    return;
  }
  rt.roles[tabId] = { role: 'watch', storeId: role.storeId, lastReport: Date.now() };
  delete rt.paused[role.storeId];
  await chrome.tabs.update(tabId, { url: store(role.storeId).productUrl }).catch(() => {});
}

// The dry-run tab stays open for you to finish by hand, so open a fresh watcher.
async function replaceWatcher(storeId) {
  if (!rt.running || rt.windowId == null) return;
  try {
    const tabId = await openRoleTab(rt.windowId, store(storeId).productUrl, { role: 'watch', storeId, lastReport: Date.now() });
    rt.watchers[storeId] = tabId;
    delete rt.paused[storeId];
  } catch (_) {
    // Watcher window is gone; nothing to replace into.
  }
}

async function onCheckout(tabId, msg) {
  const role = rt.roles[tabId];
  if (!role || role.role !== 'checkout') return {};
  const id = role.storeId;
  const name = storeName(id);
  const label = role.practice ? `Practice at ${name}` : name;
  role.lastEvent = Date.now();
  role.url = msg.url;
  role.stallAlerted = false;

  switch (msg.event) {
    case 'step':
      role.step = msg.step;
      role.waiting = null;
      addLog('step', `${label}: ${msg.step}`);
      break;

    case 'guard':
      addLog('step', `${label}: review page subtotal ${msg.subtotal != null ? '$' + msg.subtotal.toFixed(2) : 'not found'}${msg.problems && msg.problems.length ? ' (' + msg.problems.join('; ') + ')' : ''}`);
      break;

    case 'needs_you':
      role.waiting = msg.reason;
      role.lastAlertAt = Date.now();
      role.reminders = 0;
      alert('needs_you', `${label}: needs you`, msg.reason, { key: `needs:${id}:${msg.reason}`, dedupeMs: 3 * 60000, tabId, url: msg.url });
      focusTab(tabId);
      break;

    case 'queue':
      role.waiting = 'queue';
      alert('queue', `${label}: in the queue`, 'Waiting in line. The order continues automatically when it lets you in.', { key: 'cqueue:' + id, dedupeMs: 10 * 60000, tabId });
      break;

    case 'request_lock': {
      if (role.practice) return { granted: false, reason: 'practice runs never place orders' };
      if (settings.mode !== 'armed') return { granted: false, reason: 'not armed' };
      if (purchased) return { granted: false, reason: 'already bought one' };
      if (rt.lock && rt.lock.storeId !== id) return { granted: false, reason: `${storeName(rt.lock.storeId)} is already placing an order` };
      if ((rt.placeClicks[id] || 0) >= 3) return { granted: false, reason: 'tried Place Order 3 times at this store already' };
      rt.lock = { storeId: id, tabId, at: Date.now(), clicked: false };
      save();
      return { granted: true };
    }

    case 'placed_click':
      if (rt.lock && rt.lock.storeId === id) rt.lock.clicked = true;
      rt.placeClicks[id] = (rt.placeClicks[id] || 0) + 1;
      alert('placing', `Placing order at ${name}`, `Pressed Place Order (subtotal $${(msg.subtotal || 0).toFixed(2)}). Waiting for confirmation.`);
      break;

    case 'confirmed': {
      if (role.practice) break;
      if (!(rt.lock && rt.lock.storeId === id && rt.lock.clicked)) {
        addLog('info', `${name}: saw a confirmation-looking page without pressing Place Order; ignoring`);
        break;
      }
      // Update in-memory state before any await so nothing interleaves half-done.
      purchased = { storeId: id, at: Date.now(), url: msg.url, subtotal: msg.subtotal ?? null };
      settings.mode = 'monitor';
      rt.running = false;
      stopTicking();
      for (const [t, r] of Object.entries(rt.roles)) if (r.role === 'watch') delete rt.roles[t];
      const saved = (await chrome.storage.local.get('settings')).settings || {};
      await chrome.storage.local.set({ purchased, settings: { ...saved, mode: 'monitor' } });
      alert('ordered', `ORDER PLACED at ${name}!`, 'You got a PS5 Pro. Watching has stopped and the extension is disarmed. Check your email for the confirmation.', { tabId, url: msg.url });
      focusTab(tabId);
      break;
    }

    case 'dry_run_final': {
      const subtotal = msg.subtotal != null ? `$${msg.subtotal.toFixed(2)}` : 'unknown';
      if (role.practice) {
        alert('dry_run', `Practice passed at ${name}`, `Got all the way to "${msg.button}" with subtotal ${subtotal}. Nothing was bought. Empty that cart now.`, { tabId });
      } else {
        alert('needs_you', `Dry run reached Place Order at ${name}`, `A PS5 Pro (${subtotal}) is in your checkout. Dry-run mode doesn't click Place Order, so click it yourself now if you want it!`, { tabId, url: msg.url });
        focusTab(tabId);
      }
      delete rt.roles[tabId];
      if (!role.practice) await replaceWatcher(id);
      break;
    }

    case 'place_failed':
      if (rt.lock && rt.lock.storeId === id) rt.lock = null;
      alert('failed', `${name}: order didn't go through`, msg.reason || 'The store showed an error. Back to watching.', { tabId });
      await backToWatching(tabId, role);
      break;

    case 'failed':
      if (rt.lock && rt.lock.storeId === id && !rt.lock.clicked) rt.lock = null;
      alert('failed', `${label}: checkout stopped`, msg.reason || 'Unknown reason. Back to watching.', { key: `failed:${id}:${msg.reason}`, dedupeMs: 60000, tabId });
      await backToWatching(tabId, role);
      break;

    case 'uncertain':
      role.waiting = 'uncertain';
      alert('needs_you', `${name}: did the order go through?`, 'Pressed Place Order but never saw a confirmation. Check your email or order history. If there is no order, press "Release order lock" on the dashboard.', { tabId, url: msg.url });
      focusTab(tabId);
      break;
  }
  save();
  return {};
}

// ------------------------------------------------------------------ vault, sign-in, keeper

async function openVault() {
  return (await chrome.storage.session.get('vaultOpen')).vaultOpen || null;
}

// 'none' (never set up), 'locked' or 'open'.
async function vaultState() {
  if (await openVault()) return 'open';
  return (await chrome.storage.local.get('vault')).vault ? 'locked' : 'none';
}

async function signinCredentials(tabId, kind) {
  const role = rt.roles[tabId];
  if (!role || (role.role !== 'checkout' && role.role !== 'keeper')) return { error: 'not one of our tabs' };
  const id = role.storeId;
  const v = await openVault();
  if (!v) return { error: (await vaultState()) === 'locked' ? 'the vault is locked; unlock it on the dashboard' : 'no login saved; add it on the dashboard' };
  const login = v.logins && v.logins[id];
  if (!login || !login.email || !login.password) return { error: `no ${storeName(id)} login saved in the vault` };
  if (kind === 'password') {
    // Too many wrong passwords can lock the account; stop at 3 an hour.
    const recent = (rt.signinAttempts[id] || []).filter((t) => Date.now() - t < 3600000);
    if (recent.length >= 3) return { error: 'tried 3 times this hour; check the saved password' };
    rt.signinAttempts[id] = recent.concat(Date.now());
    role.signedInAuto = true;
    addLog('step', `${storeName(id)}: signing in automatically`);
    save();
  }
  return { email: login.email, password: login.password };
}

const keeperWaiters = {}; // tabId -> resolve
let keeperRunning = false;

// Visits each store's account page in turn; signs in if the session expired.
async function runKeeper() {
  if (keeperRunning) return;
  if (Object.values(rt.roles).some((r) => r.role === 'checkout' && !r.practice)) return; // never during a checkout
  keeperRunning = true;
  rt.lastKeeper = Date.now();
  try {
    for (const id of Object.keys(C.STORES).filter((i) => settings.stores[i] && settings.stores[i].enabled)) {
      const url = store(id).accountUrl;
      if (url) await keeperCheck(id, url);
    }
  } finally {
    keeperRunning = false;
    save();
  }
}

async function keeperCheck(id, url) {
  let tabId;
  try {
    const opts = { url: 'about:blank', active: false };
    if (rt.running && rt.windowId != null) opts.windowId = rt.windowId;
    const tab = await chrome.tabs.create(opts);
    tabId = tab.id;
    rt.roles[tabId] = { role: 'keeper', storeId: id, startedAt: Date.now() };
    await chrome.tabs.update(tabId, { url, autoDiscardable: false });
  } catch (e) {
    addLog('error', `sign-in check for ${storeName(id)} failed to open: ${e}`);
    return;
  }
  const result = await new Promise((resolve) => {
    keeperWaiters[tabId] = resolve;
    setTimeout(() => resolve({ result: 'timeout' }), KEEPER_TIMEOUT_MS);
  });
  delete keeperWaiters[tabId];
  const role = rt.roles[tabId] || {};
  const state = result.result === 'ok' ? (role.signedInAuto ? 'auto' : 'ok') : result.result;
  rt.signin[id] = { state, at: Date.now(), reason: result.reason || '' };
  addLog(state === 'ok' || state === 'auto' ? 'info' : 'signin', `${storeName(id)} sign-in check: ${state}${result.reason ? ' (' + result.reason + ')' : ''}`);
  if (state === 'ok' || state === 'auto' || state === 'timeout') {
    delete rt.roles[tabId];
    chrome.tabs.remove(tabId).catch(() => {});
  } else {
    // Leave the tab open so you can sign in there.
    rt.roles[tabId] = { role: 'none', storeId: id };
    alert('signin', `Sign in to ${storeName(id)} now`, `${result.reason || 'You were signed out'}. Do it before a drop so checkout doesn't stop there.`, { key: 'keeper:' + id, dedupeMs: 3 * 3600000, tabId });
  }
}

function onKeeper(tabId, msg) {
  const resolve = keeperWaiters[tabId];
  if (resolve) resolve(msg);
  return {};
}

// ------------------------------------------------------------------ dashboard actions

async function practice(storeId, url) {
  if (!C.STORES[storeId]) return { error: 'Unknown store' };
  if (!url) return { error: 'Paste a link to any cheap, in-stock item at that store.' };
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  rt.roles[tab.id] = { role: 'checkout', storeId, practice: true, startedAt: Date.now(), lastEvent: Date.now() };
  await chrome.tabs.update(tab.id, { url });
  addLog('info', `Practice checkout started at ${storeName(storeId)}`);
  save();
  return { ok: true };
}

async function handle(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case 'hello':
      return tabId != null ? roleFor(tabId) : { role: 'none' };
    case 'status':
      return tabId != null ? onStatus(tabId, msg.result) : {};
    case 'checkout':
      return tabId != null ? onCheckout(tabId, msg) : {};
    case 'cvv': {
      const role = rt.roles[tabId];
      if (!role || role.role !== 'checkout') return { error: 'not a checkout tab' };
      const v = await openVault();
      const cvv = (v && v.cvv) || settings.cvv || '';
      if (cvv) return { cvv };
      return { error: (await vaultState()) === 'locked' ? 'the vault is locked' : 'no CVV is saved' };
    }
    case 'signin':
      return tabId != null ? signinCredentials(tabId, msg.kind) : {};
    case 'keeper':
      return tabId != null ? onKeeper(tabId, msg) : {};
    case 'checkSignins':
      runKeeper();
      return { ok: true };
    case 'start':
      return start();
    case 'stop':
      return stop();
    case 'practice':
      return practice(msg.storeId, msg.url);
    case 'testAlert':
      await alert('in_stock', 'Test alert: PS5 Pro watcher', 'If you got this on your phone and PC, alerts work.', { url: 'https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console-2-tb' });
      return { ok: true };
    case 'releaseLock':
      addLog('info', 'Order lock released from the dashboard');
      rt.lock = null;
      save();
      return { ok: true };
    case 'resetPurchased':
      purchased = null;
      await chrome.storage.local.remove('purchased');
      addLog('info', 'Purchase flag reset; ready to hunt again');
      return { ok: true };
    case 'clearLog':
      log = [];
      save();
      return { ok: true };
    case 'state':
      return { rt, purchased, log: log.slice(-150) };
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === 'offscreen') return false;
  ready
    .then(() => handle(msg, sender))
    .then(sendResponse, (e) => {
      addLog('error', String((e && e.stack) || e));
      sendResponse(null);
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  ready.then(() => {
    const role = rt.roles[tabId];
    delete rt.roles[tabId];
    if (rt.lock && rt.lock.tabId === tabId && !rt.lock.clicked) rt.lock = null;
    if (role && rt.running && !info.isWindowClosing && rt.watchers[role.storeId] === tabId) {
      addLog('info', `${storeName(role.storeId)} watcher tab was closed; reopening it`);
      replaceWatcher(role.storeId);
    }
    save();
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  ready.then(() => {
    if (windowId === rt.windowId && rt.running) {
      addLog('info', 'Watcher window closed, so watching stopped');
      stop();
    }
  });
});

// Keeps the 1-second ticker alive if Chrome suspends the worker, and sends a
// periodic "still watching" so silence never means it died.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.create('heartbeat', { periodInMinutes: 360 });
chrome.alarms.onAlarm.addListener((a) => {
  ready.then(() => {
    if (a.name === 'keepalive' && rt.running) {
      ensureTicking();
      if (settings.keeperHours > 0 && Date.now() - rt.lastKeeper > settings.keeperHours * 3600000) runKeeper();
    }
    if (a.name === 'heartbeat' && rt.running) {
      const parts = Object.keys(rt.watchers).map((id) => `${storeName(id)}: ${(rt.status[id] && rt.status[id].state) || 'no data'}`);
      alert('heartbeat', 'PS5 Pro watcher is running', `${settings.mode} mode. ${parts.join(', ')}`);
    }
  });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Chrome restarted (e.g. after a Windows update): pick up where we left off.
chrome.runtime.onStartup.addListener(() => {
  ready.then(() => {
    if (settings.autoStart && !purchased) start();
  });
});
