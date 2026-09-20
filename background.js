globalThis.__AWG_BACKGROUND__ = true;

// Классический скрипт без import()/export: Chrome MV3 (classic SW) подтягивает
// api.js через importScripts, Firefox — через background.scripts. Это обходит
// ограничение "import() is disallowed on ServiceWorkerGlobalScope".
if (typeof awgRequest === 'undefined' && typeof importScripts === 'function') {
  try {
    importScripts('lib/api.js');
  } catch (_) {}
}

const NOTIFY_ID = 'awg-ruleset-notify';

// Выполнение всех сетевых запросов к AWG Manager здесь, в фоне:
// в Firefox MV3 fetch из попапа может зависнуть на CORS-preflight,
// а из фонового скрипта запросы к хостам из host_permissions всегда
// выполняются без ограничений CORS.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'awg:request') return;
  (async () => {
    try {
      const value = await awgRequest(msg.opts);
      sendResponse({ ok: true, value });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

const FAILED_KEY = 'failedDomains';
const IGNORE_DOMAINS_KEY = 'ignoreDomains';
const MAX_FAILED = 100;

async function notify(title, message) {
  try {
    await chrome.notifications.create(NOTIFY_ID, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
    });
  } catch (_) {}
}

function hostOf(url) {
  if (!url) return null;
  try {
    if (!url.includes('://') && /^[\w.-]+\.[a-z]{2,}$/i.test(url)) {
      return String(url).toLowerCase();
    }
    return new URL(url).hostname;
  } catch (_) {
    return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'awg-add-page-domain',
    title: 'Добавить домен этого сайта в rule-set AWG',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'awg-add-link-domain',
    title: 'Добавить домен ссылки в rule-set AWG',
    contexts: ['link'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let url = null;
  if (info.menuItemId === 'awg-add-link-domain') url = info.linkUrl;
  else url = info.pageUrl || (tab && tab.url);
  const domain = hostOf(url);
  if (!domain) {
    await notify('AWG Rule-Set', 'Не удалось определить домен');
    return;
  }
  const s = await chrome.storage.local.get(['baseUrl', 'apiKey', 'ruleSetTag', 'flavor', 'matcher']);
  const cfg = {
    baseUrl: s.baseUrl || '',
    apiKey: s.apiKey || '',
    ruleSetTag: s.ruleSetTag || '',
    flavor: s.flavor || 'fakeip',
    matcher: s.matcher || 'domain_suffix',
  };
  if (!cfg.baseUrl || !cfg.ruleSetTag) {
    await notify('AWG Rule-Set', 'Заполни Base URL и тег набора в настройках попапа');
    return;
  }
  try {
    const res = await addDomainToRuleSet(cfg, domain, cfg.matcher);
    await notify(
      'AWG Rule-Set',
      res.alreadyPresent
        ? res.domain + ' уже был в наборе ' + res.tag
        : res.domain + ' добавлен в ' + res.tag + ' (' + cfg.matcher + ')',
    );
  } catch (e) {
    await notify('AWG Rule-Set: ошибка', String((e && e.message) || e));
  }
});

function domainOfUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

async function isIgnoredDomain(domain) {
  const s = await chrome.storage.local.get(IGNORE_DOMAINS_KEY);
  const list = Array.isArray(s[IGNORE_DOMAINS_KEY]) ? s[IGNORE_DOMAINS_KEY] : [];
  return list.some((e) => {
    if (e.kind === 'domain' || !e.kind) return domain === e.host;
    if (e.kind === 'domain_regex') {
      try {
        return new RegExp(e.host).test(domain);
      } catch (_) {
        return false;
      }
    }
    return domain === e.host || domain.endsWith('.' + e.host);
  });
}

async function recordFailedDomain(domain, page, code) {
  const s = await chrome.storage.local.get(FAILED_KEY);
  let list = Array.isArray(s[FAILED_KEY]) ? s[FAILED_KEY] : [];
  const now = Date.now();
  const existing = list.find((x) => x.domain === domain && (page ? x.page === page : !x.page));
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.ts = now;
    if (code) existing.code = code;
    list = [existing].concat(list.filter((x) => x !== existing));
  } else {
    list.unshift({ domain, page: page || '', code: code || '', count: 1, ts: now });
  }
  if (list.length > MAX_FAILED) list = list.slice(0, MAX_FAILED);
  await chrome.storage.local.set({ [FAILED_KEY]: list });
}

async function pageOfTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return domainOfUrl(tab.url) || '';
  } catch (_) {
    return '';
  }
}

function relevantDomain(details) {
  if (details.initiator && details.initiator.startsWith('chrome-extension://')) return null;
  if (details.url && details.url.startsWith('chrome-extension:')) return null;
  if (details.tabId < 0) return null;
  const domain = domainOfUrl(details.url);
  if (!domain) return null;
  if (domain === 'localhost') return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) return null;
  return domain;
}

chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    const domain = relevantDomain(details);
    if (!domain) return;
    if (await isIgnoredDomain(domain)) return;
    const page = await pageOfTab(details.tabId);
    await recordFailedDomain(domain, page, details.error || 'net::ERR').catch(() => {});
    await refreshActiveBadge();
  },
  { urls: ['http://*/*', 'https://*/*'] },
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (!details.statusCode || details.statusCode < 400) return;
    const domain = relevantDomain(details);
    if (!domain) return;
    if (await isIgnoredDomain(domain)) return;
    const page = await pageOfTab(details.tabId);
    await recordFailedDomain(domain, page, 'HTTP ' + details.statusCode).catch(() => {});
    await refreshActiveBadge();
  },
  { urls: ['http://*/*', 'https://*/*'] },
);

async function failedTotalForPage(page) {
  if (!page) return 0;
  const s = await chrome.storage.local.get(FAILED_KEY);
  const list = Array.isArray(s[FAILED_KEY]) ? s[FAILED_KEY] : [];
  let total = 0;
  for (const x of list) {
    if (x.page === page) total += x.count || 1;
  }
  return total;
}

async function refreshActiveBadge() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const page = domainOfUrl(tab && tab.url);
    const total = await failedTotalForPage(page);
    const text = total === 0 ? '' : total > 99 ? '99+' : String(total);
    await chrome.action.setBadgeBackgroundColor({ color: '#f2c94c' }).catch(() => {});
    // setBadgeTextColor доступен в Chrome и Firefox 138+; в более старых Firefox
    // цвет текста бейджа подставляется браузером автоматически.
    if (typeof chrome.action.setBadgeTextColor === 'function') {
      await chrome.action.setBadgeTextColor({ color: '#1f2328' }).catch(() => {});
    }
    await chrome.action.setBadgeText({ text }).catch(() => {});
  } catch (_) {}
}

async function clearFailedForPage(page) {
  if (!page) return;
  const s = await chrome.storage.local.get(FAILED_KEY);
  let list = Array.isArray(s[FAILED_KEY]) ? s[FAILED_KEY] : [];
  const filtered = list.filter((x) => x.page !== page);
  if (filtered.length !== list.length) {
    await chrome.storage.local.set({ [FAILED_KEY]: filtered });
  }
}

chrome.tabs.onActivated.addListener(() => refreshActiveBadge());
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const page = await pageOfTab(tabId);
    await clearFailedForPage(page);
  }
  await refreshActiveBadge();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[FAILED_KEY]) refreshActiveBadge();
});
refreshActiveBadge();