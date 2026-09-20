// AWG Manager API helper. Классический скрипт (без import/export):
// в попап/редактор подключается тегом <script>, в фон — через importScripts
// (Chrome, classic service worker) или background.scripts (Firefox).
//
// Сетевые запросы выполняются в фоновом скрипте (runtime.sendMessage):
// только там MV3-расширения гарантированно обходят CORS для хостов
// из host_permissions. В попапе Firefox fetch может зависнуть на
// CORS-preflight.

function isBackground() {
  return !!globalThis.__AWG_BACKGROUND__;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

async function awgRequestFetch({ baseUrl, apiKey, path, method = 'GET', body = null, timeout = 15000 }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('Не указан Base URL');
  const headers = {};
  if (apiKey && apiKey.trim()) headers['Authorization'] = 'Bearer ' + apiKey.trim();
  if (body !== null) headers['Content-Type'] = 'application/json';
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: controller ? controller.signal : undefined,
    });
  } catch (e) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[awg] fetch failed', {
        url: base + path,
        name: e && e.name,
        message: e && e.message,
        code: e && (e.code || e.result),
        aborted: controller ? controller.signal.aborted : false,
      });
    }
    if (controller && controller.signal.aborted) {
      throw new Error('Тайм-аут запроса (' + timeout + ' мс): ' + base + path);
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  let text = '';
  try {
    text = await res.text();
  } catch (_) {}
  if (!res.ok) {
    let detail = text.trim();
    try {
      const j = JSON.parse(detail);
      detail = j.error || j.message || detail;
    } catch (_) {}
    throw new Error('HTTP ' + res.status + (detail ? ': ' + detail : ''));
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

async function awgRequest(opts) {
  if (isBackground()) return awgRequestFetch(opts);
  const resp = await new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'awg:request', opts }, (r) => {
        if (chrome.runtime.lastError) {
          reject(new Error('Ошибка фонового скрипта: ' + chrome.runtime.lastError.message));
        } else {
          resolve(r);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
  if (resp && resp.ok) return resp.value;
  throw new Error((resp && resp.error) || 'Не удалось выполнить запрос');
}

function getEndpoints(flavor) {
  const base = flavor === 'router' ? '/singbox/router/rulesets' : '/singbox/fakeip/config/rulesets';
  return { list: base + '/list', update: base + '/update' };
}

async function listRuleSets(cfg) {
  const eps = getEndpoints(cfg.flavor);
  const res = await awgRequest({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, path: eps.list });
  const list = Array.isArray(res.data) ? res.data : Array.isArray(res) ? res : [];
  return list;
}

async function findRuleSet(cfg, tag) {
  const list = await listRuleSets(cfg);
  const rs = list.find((r) => r.tag === tag);
  if (!rs) {
    const tags = list.map((r) => r.tag).join(', ') || 'нет доступных наборов';
    throw new Error('Набор «' + tag + '» не найден. Доступны: ' + tags);
  }
  return rs;
}

function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  if (!d) throw new Error('Пустой домен');
  if (!/^[\w.-]+$/.test(d)) {
    try {
      const u = new URL(d.includes('://') ? d : 'http://' + d);
      d = u.hostname;
    } catch (_) {}
  }
  d = d.replace(/^\.+/, '');
  if (!/^[a-z0-9.-]+$/.test(d) || d.indexOf('.') === -1) {
    throw new Error('Некорректный домен: ' + input);
  }
  return d;
}

async function addDomainToRuleSet(cfg, domain, matcher) {
  const matcherKey = matcher === 'domain' ? 'domain' : 'domain_suffix';
  const rs = await findRuleSet(cfg, cfg.ruleSetTag);
  const dom = normalizeDomain(domain);
  const prevRules = Array.isArray(rs.rules) ? rs.rules : [];
  const already = prevRules.some(
    (r) => Array.isArray(r[matcherKey]) && r[matcherKey].includes(dom),
  );
  if (already) {
    return { alreadyPresent: true, tag: rs.tag, domain: dom };
  }
  // Вливаем домен в первую существующую rule-запись с этим matcher'ом
  // (как делает редактор правил AWG Manager), вместо создания новой записи.
  const existing = prevRules.find(
    (r) => Array.isArray(r[matcherKey]) && r[matcherKey].length,
  );
  let nextRules;
  if (existing) {
    nextRules = prevRules.map((r) =>
      r === existing ? Object.assign({}, r, { [matcherKey]: r[matcherKey].concat([dom]) }) : r,
    );
  } else {
    nextRules = prevRules.concat([{ [matcherKey]: [dom] }]);
  }
  const ruleSet = Object.assign({}, rs, { rules: nextRules });
  const eps = getEndpoints(cfg.flavor);
  await awgRequest({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    path: eps.update,
    method: 'POST',
    body: { tag: rs.tag, ruleSet },
  });
  return { alreadyPresent: false, tag: rs.tag, domain: dom };
}

async function checkConnection(cfg) {
  return listRuleSets(cfg);
}