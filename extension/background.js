// Coordinator: opens the watcher tabs, paces checks, decides when to buy, makes
// sure only one order is ever placed, and sends alerts.
importScripts('lib/config.js', 'lib/detect.js', 'lib/fastlane.js');

const C = PS5Config;
const D = PS5Detect;
const FL = PS5Fast;

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
  hot: 'low',
  trigger: 'low',
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
const next = {}; // per-listing check schedule; fine to lose on worker restart
const notificationTabs = {};
let tickTimer = null;

const ready = load();

function freshRuntime() {
  return {
    running: false,
    windowId: null,
    // A "watch" is one listing being watched; its key is the store id, or
    // "bestbuy#2" for a second Best Buy listing.
    watchers: {}, // watch key -> tabId
    watches: {}, // watch key -> { storeId, url }
    roles: {}, // tabId -> { role: 'watch'|'checkout'|'keeper', storeId, key, url, practice, ... }
    status: {}, // watch key -> last detection summary
    speed: {}, // watch key -> { quickMs, reloadMs, factor }
    hot: { all: 0, stores: {}, reason: '' }, // checking faster until these times
    apiIn: {}, // watch key -> when a quick check last said in stock
    apiMisses: {}, // watch key -> quick-check "in stock" that the real page didn't confirm
    distrust: {}, // watch key -> ignore quick checks until this time
    refusals: {}, // watch key -> times the store refused a quick check
    quickOff: {}, // watch key -> reloads only (store refuses quick checks) until this time
    lastTrigger: {}, // storeId -> last outside alert handled
    triggerConnected: false,
    discordTabs: {}, // channel url -> tabId
    discord: {}, // channel url -> { signedIn, hasMessages, at }
    lastAlert: null, // { at, source, text }
    probes: {}, // storeId -> when a listing linked in an alert was last opened
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
  if (area === 'local' && changes.settings) {
    const before = settings.trigger.ntfyTopic;
    settings = C.resolveSettings(changes.settings.newValue);
    if (settings.trigger.ntfyTopic !== before) {
      stopTriggerStream();
      startTriggerStream();
    }
  }
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
  return Object.keys(C.STORES).filter((id) => settings.stores[id] && settings.stores[id].enabled && C.watchUrls(id, settings).length);
}

function watchList() {
  return enabledStores().flatMap((id) => C.watchUrls(id, settings).map((url, i) => ({ key: i ? `${id}#${i + 1}` : id, storeId: id, url })));
}

function keysFor(storeId) {
  return Object.keys(rt.watchers).filter((k) => rt.watches[k] && rt.watches[k].storeId === storeId);
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
  rt.watches = {};
  rt.speed = {};
  rt.apiIn = {};
  rt.apiMisses = {};
  rt.distrust = {};
  rt.refusals = {};
  rt.quickOff = {};
  const now = Date.now();
  for (const [i, w] of watchList().entries()) {
    const tabId = await openRoleTab(win.id, w.url, { role: 'watch', storeId: w.storeId, key: w.key, url: w.url, lastReport: now });
    rt.watchers[w.key] = tabId;
    rt.watches[w.key] = { storeId: w.storeId, url: w.url };
    // Stagger listings so their checks don't all land in the same second.
    const firstReloadSec = alertsMode() ? settings.safetyReloadSec : settings.reloadIntervalSec;
    next[w.key] = { fetch: now + 2000 + i * 300, reload: now + jitter(firstReloadSec * 1000) + i * 1500 };
  }
  rt.discordTabs = {};
  rt.discord = {};
  rt.probes = {};
  for (const url of discordChannels()) await openDiscord(url);
  if (blankTab) chrome.tabs.remove(blankTab.id).catch(() => {});
  ensureTicking();
  startTriggerStream();
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
  stopTriggerStream();
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

// ------------------------------------------------------------------ speed

let windowsCache = { text: null, list: [] };
function hotWindows() {
  if (windowsCache.text !== settings.hotWindows) windowsCache = { text: settings.hotWindows, list: FL.parseWindows(settings.hotWindows) };
  return windowsCache.list;
}

function isHot(storeId, now = Date.now()) {
  return Math.max(rt.hot.all || 0, (rt.hot.stores || {})[storeId] || 0) > now;
}

// 'hot', 'warm' or 'normal', and the multiplier applied to check intervals.
function speedMode(storeId, now, warm) {
  if (isHot(storeId, now)) return { mode: 'hot', factor: settings.hotFactor };
  if (warm) return { mode: 'warm', factor: settings.warmFactor };
  return { mode: 'normal', factor: 1 };
}

// Check faster for a while. stores = null means every store.
function goHot(stores, minutes, reason) {
  const now = Date.now();
  const until = now + minutes * 60000;
  const ids = stores || Object.keys(C.STORES);
  const wasHot = ids.some((id) => isHot(id, now));
  if (stores) for (const id of stores) rt.hot.stores[id] = Math.max(rt.hot.stores[id] || 0, until);
  else rt.hot.all = Math.max(rt.hot.all || 0, until);
  rt.hot.reason = reason;
  if (!wasHot) addLog('hot', `Hot mode for ${minutes} min (${stores ? stores.map(storeName).join(', ') : 'all stores'}): ${reason}`);
  // Pull the next quick checks in so the faster pace starts now.
  for (const key of Object.keys(rt.watchers)) {
    const w = rt.watches[key];
    if (w && ids.includes(w.storeId) && next[key]) {
      next[key].fetch = Math.min(next[key].fetch, now + 250);
      if (alertsMode()) next[key].reload = Math.min(next[key].reload, now + settings.burstReloadSec * 1000);
    }
  }
}

// Reload every listing at a store right now (an outside alert says it dropped).
function checkNow(storeId) {
  for (const key of keysFor(storeId)) {
    const tabId = rt.watchers[key];
    const role = rt.roles[tabId];
    if (!role || role.role !== 'watch' || rt.paused[storeId]) continue;
    reloadTab(tabId);
    const sec = settings.detection === 'alerts' ? settings.burstReloadSec : settings.reloadIntervalSec;
    if (next[key]) next[key].reload = Date.now() + jitter(sec * 1000);
  }
}

function alertsMode() {
  return settings.detection === 'alerts';
}

// Hot mode across every store, except in alerts mode: there one store's drop
// shouldn't send every store into a burst of page loads.
function goHotEverywhere(storeId, reason) {
  if (alertsMode()) goHot([storeId], settings.burstMinutes, reason);
  else goHot(null, settings.hotMinutes, reason);
}

function tick() {
  if (!rt.running) return stopTicking();
  const now = Date.now();
  const warm = FL.inWindows(new Date(now), hotWindows());

  for (const [key, tabId] of Object.entries(rt.watchers)) {
    const role = rt.roles[tabId];
    const id = role && role.storeId;
    if (!role || role.role !== 'watch' || rt.paused[id]) continue;
    let { mode, factor } = speedMode(id, now, warm);
    const st = rt.status[key] || {};
    const apiLane = st.lane === 'learned' || st.lane === 'template';
    const baseSec = apiLane ? settings.apiIntervalSec : settings.fetchIntervalSec;
    // If the store refuses quick checks, watch that listing by reloading the page more often instead.
    const quickOff = (rt.quickOff[key] || 0) > now;
    let quickMs = baseSec > 0 && !quickOff ? Math.max(1000, baseSec * 1000 * factor) : 0;
    const reloadSec = quickOff ? Math.min(settings.reloadIntervalSec, settings.reloadOnlySec) : settings.reloadIntervalSec;
    let reloadMs = Math.max(5000, reloadSec * 1000 * factor);
    if (alertsMode()) {
      // Alerts do the spotting: a slow safety-net reload, and a short burst of
      // reloads after an alert about this store.
      quickMs = 0;
      mode = mode === 'hot' ? 'burst' : 'alerts';
      reloadMs = Math.max(5000, (mode === 'burst' ? settings.burstReloadSec : settings.safetyReloadSec) * 1000);
    }
    rt.speed[key] = { quickMs, reloadMs, mode, quickOff };
    const n = next[key] || (next[key] = { fetch: now + jitter(quickMs || 4000), reload: now + jitter(reloadMs) });
    const bo = rt.backoff[id] || {};
    if (bo.until > now) continue;

    if (now >= n.reload) {
      n.reload = now + jitter(reloadMs);
      n.fetch = now + jitter(quickMs || 4000) + 1500; // let the reloaded page settle first
      reloadTab(tabId);
    } else if (quickMs && now >= n.fetch && !(bo.fetchUntil > now)) {
      n.fetch = now + jitter(quickMs);
      chrome.tabs.sendMessage(tabId, { type: 'fetchCheck' }).catch(() => {});
    }

    if (role.lastReport && now - role.lastReport > 3 * reloadMs + 15000) {
      role.lastReport = now;
      alert('stale', `${storeName(id)} watcher went quiet`, 'Reloading it. If this keeps happening, check that tab.', { key: 'stale:' + key, dedupeMs: 15 * 60000 });
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

function checkoutCtx(id, practice, role) {
  // Set for a few seconds after jumping straight to checkout, so the next page
  // knows to fall back to the cart if the shortcut didn't work.
  const viaDirect = !!(role && role.viaDirect && Date.now() - role.viaDirect < 20000);
  return {
    role: 'checkout',
    storeId: id,
    store: store(id),
    checkout: { mode: settings.mode, practice: !!practice, priceCap: settings.priceCap, minPrice: settings.minPrice, viaDirect },
  };
}

function roleFor(tabId) {
  const role = rt.roles[tabId];
  if (!role) return { role: 'none' };
  if (role.role === 'watch') {
    role.lastReport = Date.now();
    const distrustApi = (rt.distrust[role.key] || 0) > Date.now();
    return {
      role: 'watch',
      storeId: role.storeId,
      store: store(role.storeId),
      settings: { distrustApi, priceCap: settings.priceCap, minPrice: settings.minPrice },
    };
  }
  if (role.role === 'checkout') {
    role.lastEvent = Date.now();
    return checkoutCtx(role.storeId, role.practice, role);
  }
  if (role.role === 'keeper') return { role: 'keeper', storeId: role.storeId, store: store(role.storeId) };
  if (role.role === 'discord') return { role: 'discord' };
  return { role: 'none' };
}

function onStatus(tabId, result) {
  const role = rt.roles[tabId];
  if (!role || role.role !== 'watch') return { go: false };
  const id = role.storeId;
  const key = role.key || id;
  const name = storeName(id);
  const productUrl = role.url || store(id).productUrl;
  const now = Date.now();
  role.lastReport = now;
  const quick = result.source === 'fetch' || result.source === 'api';

  // The store's bot protection turned away a quick check (an error code, or a
  // challenge page instead of the product). Not a problem with the store page,
  // so don't show the store as blocked or ping your phone: three refusals in
  // 10 minutes and that listing is watched by page reloads for 30 minutes.
  if (quick && (result.state === 'refused' || result.state === 'blocked')) {
    const recent = (rt.refusals[key] || []).filter((t) => now - t < 10 * 60000).concat(now);
    rt.refusals[key] = recent;
    if (rt.status[key]) rt.status[key].quickNote = `quick checks refused${result.httpStatus ? ' (HTTP ' + result.httpStatus + ')' : ''}`;
    if (recent.length >= 3 && !((rt.quickOff[key] || 0) > now)) {
      rt.quickOff[key] = now + 30 * 60000;
      rt.refusals[key] = [];
      if (next[key]) next[key].reload = Math.min(next[key].reload, now + settings.reloadOnlySec * 1000);
      addLog('info', `${name} refuses the quick checks, so that listing is watched by reloading the page every ${settings.reloadOnlySec}s for the next 30 minutes`);
    }
    return { go: false };
  }

  rt.status[key] = {
    state: result.state,
    source: result.source,
    lane: result.lane || (rt.status[key] && rt.status[key].lane) || 'html',
    rtt: result.rtt ?? (rt.status[key] && rt.status[key].rtt) ?? null,
    signal: result.signal || '',
    at: result.at || now,
    price: result.price ?? null,
    seller: result.seller || '',
    firstParty: result.firstParty ?? null,
    title: result.title || '',
    signals: result.signals || null,
    error: result.error || (result.httpStatus ? 'HTTP ' + result.httpStatus : ''),
  };

  if (result.state === 'error') return { go: false };
  if (result.state === 'blocked') {
    // A real bot check on the page itself: only a person can clear it.
    applyBackoff(id, 'live');
    alert('blocked', `${name} is showing a bot check`, `Open the watcher window, go to the ${name} tab and solve it once. Watching continues by itself after that.`, { key: 'blocked:' + key, dedupeMs: 20 * 60000, tabId });
    return { go: false };
  }
  clearBackoff(id, quick ? 'fetch' : 'live');

  if (result.state === 'queue') {
    if (rt.paused[id] !== 'queue') {
      rt.paused[id] = 'queue';
      goHotEverywhere(id, `${name} opened a queue`);
      alert('queue', `${name} queue is open`, `A waiting room just appeared at ${name}, which usually means a drop. Holding your place; don't close the tab.`, { key: 'queue:' + id, dedupeMs: 10 * 60000, tabId, url: productUrl });
    }
    return { go: false };
  }
  if (rt.paused[id] === 'queue') delete rt.paused[id];

  if (result.state === 'invite') {
    alert('invite', `${name} is invite-only`, `${name} is selling the PS5 Pro by invitation. Open the listing and press "Request invitation".`, { key: 'invite:' + id, dedupeMs: 6 * 3600000, url: productUrl });
    return { go: false };
  }

  // The real page disagreed with a quick check that said "in stock". Three of
  // those in 10 minutes and that listing's quick checks are ignored for 30.
  if (!quick && result.state !== 'in_stock' && now - (rt.apiIn[key] || 0) < 30000) {
    rt.apiIn[key] = 0;
    const misses = (rt.apiMisses[key] || []).filter((t) => now - t < 10 * 60000).concat(now);
    rt.apiMisses[key] = misses;
    if (misses.length >= 3) {
      rt.distrust[key] = now + 30 * 60000;
      rt.apiMisses[key] = [];
      addLog('info', `${name}: quick checks said in stock 3 times but the page didn't agree; using page checks only for 30 min`);
    }
  }
  if (result.state !== 'in_stock') return { go: false };
  if (role.oneShot && quick) return { go: false };

  if (quick) {
    // The quick check thinks it's in stock: reload now to confirm on the real page.
    rt.apiIn[key] = now;
    goHotEverywhere(id, `${name} quick check saw stock`);
    if (!rt.lastFetchReload[key] || now - rt.lastFetchReload[key] > 10000) {
      rt.lastFetchReload[key] = now;
      next[key] = Object.assign(next[key] || {}, { reload: now + jitter(settings.reloadIntervalSec * 1000) });
      reloadTab(tabId);
    }
    return { go: false };
  }

  const verdict = D.evaluate(result, settings);
  rt.status[key].verdict = verdict;
  if (!verdict.ok) {
    if (verdict.alert) {
      alert('needs_you', `${name}: in stock, needs a look`, `${verdict.reasons.join('; ')}. Not buying automatically.`, { key: 'check:' + key, dedupeMs: 5 * 60000, tabId, url: productUrl });
    } else if (id === 'amazon' && now - (rt.apiIn[key] || 0) < 30000 && result.firstParty === false) {
      // Amazon's own offer is listed, but a third-party seller holds the buy box.
      alert('needs_you', 'Amazon has its own PS5 Pro offer', `It's under "Other sellers" on the listing, not in the buy box, so it can't be bought automatically. Open the listing and pick the offer sold by Amazon.com.`, { key: 'aod:' + key, dedupeMs: 5 * 60000, tabId, url: productUrl });
    }
    return { go: false };
  }
  if (purchased) return { go: false };
  goHotEverywhere(id, `${name} is in stock`);

  const price = result.price != null ? `$${result.price.toFixed(2)}` : '';
  const buying = settings.mode === 'armed' ? 'Buying now.' : settings.mode === 'dryrun' ? 'Dry run: going to Place Order but not clicking it.' : 'Go buy it!';
  const lead = rt.apiIn[key] ? ` Spotted by the quick check ${((now - rt.apiIn[key]) / 1000).toFixed(1)}s ago.` : '';
  alert('in_stock', `PS5 Pro IN STOCK at ${name}`, `${price} sold by ${name}. ${buying}${lead}`, { key: 'instock:' + key, dedupeMs: 2 * 60000, tabId, url: productUrl });

  if (settings.mode === 'armed' || settings.mode === 'dryrun') {
    // A checkout that keeps failing the same way (e.g. a changed page) shouldn't
    // hammer the store: at most 5 tries per store per 10 minutes.
    const recent = (rt.attempts[id] || []).filter((t) => now - t < 10 * 60000);
    if (recent.length >= 5) {
      alert('needs_you', `${name}: checkout keeps failing`, `Tried 5 times in 10 minutes. Not retrying for now. It's in stock, so try it by hand.`, { key: 'attempts:' + id, dedupeMs: 10 * 60000, tabId, url: productUrl });
      return { go: false };
    }
    rt.attempts[id] = recent.concat(now);
    rt.roles[tabId] = { role: 'checkout', storeId: id, key, url: productUrl, watchUrl: productUrl, practice: false, startedAt: now, lastEvent: now };
    rt.paused[id] = 'checkout';
    focusTab(tabId);
    save();
    return { go: true, ctx: checkoutCtx(id, false, rt.roles[tabId]) };
  }
  focusTab(tabId);
  return { go: false };
}

// ------------------------------------------------------------------ checkout

async function backToWatching(tabId, role) {
  const key = role.key || role.storeId;
  if (String(key).startsWith('probe:')) {
    // A listing opened from an alert link: done with it.
    delete rt.roles[tabId];
    delete rt.watchers[key];
    delete rt.watches[key];
    chrome.tabs.remove(tabId).catch(() => {});
    return;
  }
  if (role.practice || !rt.running || rt.watchers[key] !== tabId) {
    delete rt.roles[tabId];
    return;
  }
  const url = (rt.watches[key] && rt.watches[key].url) || store(role.storeId).productUrl;
  rt.roles[tabId] = { role: 'watch', storeId: role.storeId, key, url, lastReport: Date.now() };
  delete rt.paused[role.storeId];
  await chrome.tabs.update(tabId, { url }).catch(() => {});
}

// The dry-run tab stays open for you to finish by hand, so open a fresh watcher.
async function replaceWatcher(key) {
  if (String(key).startsWith('probe:')) return;
  const w = rt.watches[key];
  if (!rt.running || rt.windowId == null || !w) return;
  try {
    const tabId = await openRoleTab(rt.windowId, w.url, { role: 'watch', storeId: w.storeId, key, url: w.url, lastReport: Date.now() });
    rt.watchers[key] = tabId;
    delete rt.paused[w.storeId];
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
      if (msg.direct === true) role.viaDirect = Date.now();
      if (msg.direct === false || msg.step === 'cart') role.viaDirect = 0;
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
      if (!role.practice) await replaceWatcher(role.key || id);
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

// ------------------------------------------------------------------ outside alerts

// Listens on an ntfy topic for restock alerts from elsewhere (HotStock forwarded
// from your phone, a Discord bot, anything that can POST a line of text). An
// alert never buys anything by itself: it makes us check that store right now.
let triggerAbort = null;

function startTriggerStream() {
  const topic = settings.trigger && settings.trigger.ntfyTopic;
  if (!topic || !rt.running || triggerAbort) return;
  const ctrl = new AbortController();
  triggerAbort = ctrl;
  (async () => {
    let wait = 1000;
    while (!ctrl.signal.aborted && rt.running) {
      try {
        const server = settings.alerts.ntfyServer.replace(/\/+$/, '');
        const resp = await fetch(`${server}/${encodeURIComponent(topic)}/json`, { signal: ctrl.signal, cache: 'no-store' });
        if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
        rt.triggerConnected = true;
        wait = 1000;
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) onTriggerLine(line);
          }
        }
      } catch (_) {
        // Dropped connection; retry below.
      }
      rt.triggerConnected = false;
      if (ctrl.signal.aborted) break;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 30000);
    }
    if (triggerAbort === ctrl) triggerAbort = null;
  })();
}

function stopTriggerStream() {
  if (triggerAbort) triggerAbort.abort();
  triggerAbort = null;
  rt.triggerConnected = false;
}

function onTriggerLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return;
  }
  if (msg.event !== 'message') return;
  const text = [msg.title, msg.message].filter(Boolean).join(' ');
  const links = (text.match(/https?:\/\/\S+/g) || []).map((u) => u.replace(/[)\].,!]+$/, ''));
  onAlert(text, links, 'Outside');
}

// A restock post from Discord or an outside alert: check the stores it names
// right now, and open any product link it carries. Never buys by itself; the
// usual checks on the real store page decide.
function onAlert(text, links, source) {
  const t = FL.parseTrigger(text, { anyProduct: settings.trigger.anyProduct }, links || []);
  if (!t.matched) {
    // Restock channels post about lots of products; only log ignored ntfy alerts.
    if (source === 'Outside') addLog('trigger', `Ignored an outside alert that isn't about a PS5 Pro: "${text.slice(0, 80)}"`);
    return;
  }
  const now = Date.now();
  const enabled = enabledStores();
  rt.lastAlert = { at: now, source, text: text.slice(0, 140) };
  const ids = (t.stores.length ? t.stores : enabled).filter((id) => enabled.includes(id) && now - (rt.lastTrigger[id] || 0) > 5000);
  for (const id of ids) rt.lastTrigger[id] = now;
  if (ids.length) {
    goHot(ids, alertsMode() ? settings.burstMinutes : settings.hotMinutes, `${source} alert`);
    for (const id of ids) checkNow(id);
  }
  const opened = [];
  if (settings.discord.openLinks) {
    for (const l of t.links) if (enabled.includes(l.storeId) && !isWatched(l.storeId, l.url) && probe(l.storeId, l.url)) opened.push(storeName(l.storeId));
  }
  if (!ids.length && !opened.length) return;
  addLog('trigger', `${source} alert, checking ${ids.map(storeName).join(', ') || 'linked listing'} now${opened.length ? ` (opened the linked ${opened.join(', ')} listing)` : ''}: "${text.slice(0, 100)}"`);
  save();
}

function isWatched(storeId, url) {
  const pid = FL.productId(store(storeId), url);
  return Object.values(rt.watches).some((w) => w.storeId === storeId && (pid ? FL.productId(store(storeId), w.url) === pid : w.url.split('?')[0] === url.split('?')[0]));
}

// Opens a listing linked in an alert as a temporary watch for 90 seconds, so
// the normal checks (PS5 Pro, new, sold by the store, under the cap) run on it.
function probe(storeId, url) {
  const now = Date.now();
  if (!rt.running || rt.windowId == null || rt.paused[storeId] === 'checkout') return false;
  if (now - (rt.probes[storeId] || 0) < 30000) return false;
  rt.probes[storeId] = now;
  const key = `probe:${storeId}`;
  (async () => {
    try {
      const tabId = await openRoleTab(rt.windowId, url, { role: 'watch', storeId, key, url, oneShot: true, lastReport: Date.now() });
      rt.watchers[key] = tabId;
      rt.watches[key] = { storeId, url };
      next[key] = { fetch: Date.now() + 60000, reload: Date.now() + settings.burstReloadSec * 1000 };
      setTimeout(() => {
        const role = rt.roles[tabId];
        if (role && role.oneShot && role.role === 'watch') chrome.tabs.remove(tabId).catch(() => {});
      }, 90000);
    } catch (_) {
      // Watcher window gone.
    }
  })();
  return true;
}

// ------------------------------------------------------------------ Discord

function discordChannels() {
  return String((settings.discord && settings.discord.channels) || '')
    .split(/\s+/)
    .filter((u) => /^https:\/\/(www\.)?discord\.com\/channels\//i.test(u));
}

async function openDiscord(url) {
  if (!rt.running || rt.windowId == null) return;
  try {
    const tab = await chrome.tabs.create({ windowId: rt.windowId, url: 'about:blank', active: false, index: 0 });
    rt.roles[tab.id] = { role: 'discord', url };
    rt.discordTabs[url] = tab.id;
    await chrome.tabs.update(tab.id, { url, autoDiscardable: false, pinned: true });
  } catch (e) {
    addLog('error', 'could not open the Discord channel: ' + e);
  }
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
    case 'discordAlert': {
      const role = rt.roles[tabId];
      if (role && role.role === 'discord' && rt.running) onAlert(String(msg.text || ''), msg.links || [], 'Discord');
      return {};
    }
    case 'discordReady': {
      const role = rt.roles[tabId];
      if (role && role.role === 'discord') {
        const before = rt.discord[role.url];
        rt.discord[role.url] = { signedIn: !!msg.signedIn, hasMessages: !!msg.hasMessages, at: Date.now() };
        if (!msg.signedIn && (!before || before.signedIn)) {
          alert('needs_you', 'Sign in to Discord', 'The Discord channel in the watcher window needs you to sign in once, so restock posts can be read.', { key: 'discord-signin', dedupeMs: 3600000, tabId });
        }
        save();
      }
      return {};
    }
    case 'checkSignins':
      runKeeper();
      return { ok: true };
    case 'goHot':
      goHot(null, msg.minutes || 30, 'you turned it on');
      save();
      return { ok: true };
    case 'coolDown':
      rt.hot = { all: 0, stores: {}, reason: '' };
      addLog('hot', 'Hot mode turned off');
      save();
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
    const key = role && (role.key || role.storeId);
    if (role && role.role === 'discord' && rt.running && !info.isWindowClosing) {
      addLog('info', 'Discord tab was closed; reopening it');
      openDiscord(role.url);
    }
    if (role && (role.oneShot || String(key).startsWith('probe:'))) {
      if (rt.watchers[key] === tabId) {
        delete rt.watchers[key];
        delete rt.watches[key];
      }
    } else if (role && rt.running && !info.isWindowClosing && rt.watchers[key] === tabId) {
      addLog('info', `${storeName(role.storeId)} watcher tab was closed; reopening it`);
      replaceWatcher(key);
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
      startTriggerStream();
      if (settings.keeperHours > 0 && Date.now() - rt.lastKeeper > settings.keeperHours * 3600000) runKeeper();
    }
    if (a.name === 'heartbeat' && rt.running) {
      const parts = Object.keys(rt.watchers).map((key) => `${storeName(rt.watches[key] ? rt.watches[key].storeId : key)}: ${(rt.status[key] && rt.status[key].state) || 'no data'}`);
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
