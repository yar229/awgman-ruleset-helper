const $ = (id) => document.getElementById(id);

let statusTimer = null;

function showStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('err', kind === 'err');
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.hidden = true;
  }, kind === 'err' ? 8000 : 4000);
}

let addStatusTimer;
function showAddStatus(text, kind) {
  const el = $('addStatus');
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('err', kind === 'err');
  if (addStatusTimer) clearTimeout(addStatusTimer);
  addStatusTimer = setTimeout(() => {
    el.hidden = true;
  }, kind === 'err' ? 8000 : 4000);
}

async function loadSettings() {
  const s = await chrome.storage.local.get(['baseUrl', 'apiKey', 'ruleSetTag', 'flavor', 'matcher', 'stripWww', 'ignoreErrors']);
  $('baseUrl').value = s.baseUrl || 'http://192.168.1.1:2222/api';
  $('apiKey').value = s.apiKey || '';
  $('ruleSetTag').value = s.ruleSetTag || '';
  $('flavor').value = s.flavor || 'fakeip';
  $('matcher').value = s.matcher || 'domain_suffix';
  $('stripWww').checked = !!s.stripWww;
  const ignoreErrors =
    s.ignoreErrors === undefined ? DEFAULT_IGNORE_ERRORS : Array.isArray(s.ignoreErrors) ? s.ignoreErrors : [];
  $('ignoreErrorsInput').value = ignoreErrors.join('\n');
  if (s.ignoreErrors === undefined) await chrome.storage.local.set({ ignoreErrors });
  $('refreshListBtn').disabled = !$('baseUrl').value;
}

async function saveSettings() {
  const ignoreErrors = $('ignoreErrorsInput')
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  await chrome.storage.local.set({
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    ruleSetTag: $('ruleSetTag').value.trim(),
    flavor: $('flavor').value,
    matcher: $('matcher').value,
    stripWww: $('stripWww').checked,
    ignoreErrors,
  });
  const el = $('settingsStatus');
  el.textContent = 'Настройки сохранены';
  el.hidden = false;
  el.classList.add('ok');
  el.classList.remove('err');
  setTimeout(() => { el.hidden = true; }, 4000);
}

function currentCfg() {
  return {
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    ruleSetTag: $('ruleSetTag').value.trim(),
    flavor: $('flavor').value,
    matcher: $('matcher').value,
  };
}

async function loadRuleSetOptions({ showErrors } = {}) {
  const cfg = currentCfg();
  if (!cfg.baseUrl) {
    if (showErrors) showStatus('Укажи Base URL', 'err');
    return;
  }
  const stored = await chrome.storage.local.get('ruleSetTag');
  const saved = String(stored.ruleSetTag || '');
  $('refreshListBtn').disabled = true;
  try {
    const list = await listRuleSets(cfg);
    const inline = list.filter((rs) => rs.type === 'inline');
    const sel = $('ruleSetTag');
    sel.textContent = '';
    if (!inline.length) {
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '— inline-наборов нет —';
      sel.appendChild(emptyOpt);
    }
    for (const rs of inline) {
      const opt = document.createElement('option');
      opt.value = rs.tag;
      opt.textContent = rs.tag;
      sel.appendChild(opt);
    }
    if (saved && !inline.some((rs) => rs.tag === saved)) {
      const opt = document.createElement('option');
      opt.value = saved;
      opt.textContent = saved + ' (не в списке)';
      sel.appendChild(opt);
    }
    sel.value = saved || '';
    if (saved) showStatus('Inline-наборов найдено: ' + inline.length, 'ok');
    await renderIgnoreList(inline);
  } catch (e) {
    if (showErrors) showStatus(String((e && e.message) || e), 'err');
  } finally {
    $('refreshListBtn').disabled = !$('baseUrl').value;
  }
}

async function addDomain() {
  const cfg = currentCfg();
  if (!cfg.baseUrl || !cfg.ruleSetTag) {
    showAddStatus('Заполни Base URL и выбери rule-set', 'err');
    return;
  }
  $('addBtn').disabled = true;
  try {
    await saveSettings();
    const res = await addDomainToRuleSet(cfg, $('domainInput').value, cfg.matcher);
    if (res.alreadyPresent) {
      showAddStatus(res.domain + ' уже был в наборе ' + res.tag, 'ok');
    } else {
      showAddStatus(res.domain + ' добавлен в ' + res.tag + ' (' + cfg.matcher + ')', 'ok');
    }
    $('domainInput').value = '';
    await addHistory(res.domain);
  } catch (e) {
    showAddStatus(String((e && e.message) || e), 'err');
  } finally {
    $('addBtn').disabled = false;
  }
}

async function addHistory(domain) {
  const key = 'addedHistory';
  const s = await chrome.storage.local.get(key);
  const list = Array.isArray(s[key]) ? s[key] : [];
  list.unshift({ domain, ts: Date.now() });
  await chrome.storage.local.set({ [key]: list.slice(0, 50) });
  renderHistory(list.slice(0, 50));
}

function renderHistory(list) {
  const ul = $('history');
  ul.textContent = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Пока ничего не добавлено';
    ul.appendChild(li);
    return;
  }
  for (const item of list) {
    const li = document.createElement('li');
    const d = document.createElement('span');
    d.className = 'dom';
    d.textContent = item.domain;
    const t = document.createElement('time');
    t.className = 'ts';
    t.textContent = new Date(item.ts).toLocaleString();
    li.append(d, t);
    ul.appendChild(li);
  }
}

async function loadHistory() {
  const s = await chrome.storage.local.get('addedHistory');
  renderHistory(Array.isArray(s.addedHistory) ? s.addedHistory : []);
}

async function prefillFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;
    let host = '';
    try {
      host = new URL(tab.url).hostname;
    } catch (_) {
      return;
    }
    if (host) {
      const s = await chrome.storage.local.get('stripWww');
      if (s.stripWww && host.startsWith('www.') && host.split('.').length > 2) host = host.slice(4);
      $('domainInput').value = host;
    }
  } catch (_) {}
}

const FAILED_KEY = 'failedDomains';
const IGNORE_TAGS_KEY = 'ignoreRuleSets';
const IGNORE_DOMAINS_KEY = 'ignoreDomains';

function hostnameOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

async function recomputeIgnoreDomains() {
  const s = await chrome.storage.local.get(IGNORE_TAGS_KEY);
  const sel = Array.isArray(s[IGNORE_TAGS_KEY]) ? s[IGNORE_TAGS_KEY] : [];
  const doms = [];
  if (sel.length) {
    const cfg = currentCfg();
    try {
      const all = await listRuleSets(cfg);
      for (const tag of sel) {
        const rs = all.find((r) => r.tag === tag);
        if (!rs) continue;
        for (const r of Array.isArray(rs.rules) ? rs.rules : []) {
          for (const h of Array.isArray(r.domain) ? r.domain : []) {
            doms.push({ host: String(h).toLowerCase(), kind: 'domain' });
          }
          for (const h of Array.isArray(r.domain_suffix) ? r.domain_suffix : []) {
            doms.push({ host: String(h).toLowerCase(), kind: 'domain_suffix' });
          }
          for (const h of Array.isArray(r.domain_regex) ? r.domain_regex : []) {
            doms.push({ host: String(h), kind: 'domain_regex' });
          }
        }
      }
    } catch (_) {}
  }
  await chrome.storage.local.set({ [IGNORE_DOMAINS_KEY]: doms });
}

async function renderIgnoreList(list) {
  const box = $('ignoreList');
  box.textContent = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '— inline-наборов нет —';
    box.appendChild(empty);
    return;
  }
  const s = await chrome.storage.local.get(IGNORE_TAGS_KEY);
  const selected = Array.isArray(s[IGNORE_TAGS_KEY]) ? s[IGNORE_TAGS_KEY] : [];
  for (const rs of list) {
    const label = document.createElement('label');
    label.className = 'check-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = rs.tag;
    cb.checked = selected.includes(rs.tag);
    cb.addEventListener('change', async () => {
      const cur = await chrome.storage.local.get(IGNORE_TAGS_KEY);
      const curSel = Array.isArray(cur[IGNORE_TAGS_KEY]) ? cur[IGNORE_TAGS_KEY] : [];
      const sel = cb.checked
        ? [...new Set([...curSel, rs.tag])]
        : curSel.filter((t) => t !== rs.tag);
      await chrome.storage.local.set({ [IGNORE_TAGS_KEY]: sel });
      await recomputeIgnoreDomains();
    });
    const span = document.createElement('span');
    span.className = 'dom';
    span.textContent = rs.tag;
    label.append(cb, span);
    box.appendChild(label);
  }
}

async function loadFailedDomains() {
  const s = await chrome.storage.local.get(FAILED_KEY);
  let list = Array.isArray(s[FAILED_KEY]) ? s[FAILED_KEY] : [];
  let page = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) page = hostnameOf(tab.url);
  } catch (_) {}
  const hint = $('failedPageHint');
  if (!page) {
    hint.hidden = false;
    hint.textContent = 'Откройте сайт, чтобы увидеть его неудачные запросы';
  } else {
    hint.hidden = false;
    hint.textContent = 'Страница: ' + page;
    list = list.filter((x) => x.page === page);
  }
  renderFailedDomains(list);
}

function renderFailedDomains(list) {
  const ul = $('failedList');
  ul.textContent = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Нет неудачных запросов для этой страницы';
    ul.appendChild(li);
    return;
  }
  for (const item of list) {
    const li = document.createElement('li');
    li.className = 'check-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.domain = item.domain;
    const info = document.createElement('span');
    info.className = 'check-info';
    const d = document.createElement('input');
    d.type = 'text';
    d.className = 'dom-input';
    d.value = item.domain;
    d.spellcheck = false;
    const c = document.createElement('span');
    c.className = 'code';
    c.textContent = (item.count > 1 ? '×' + item.count + ' ' : '') + (item.code || '');
    info.append(d, c);
    li.append(cb, info);
    ul.appendChild(li);
  }
}

async function addFailedSelected() {
  const boxes = [...$('failedList').querySelectorAll('input[type="checkbox"]:checked')];
  if (!boxes.length) {
    showStatus('Ничего не выбрано', 'err');
    return;
  }
  const cfg = currentCfg();
  if (!cfg.baseUrl || !cfg.ruleSetTag) {
    showStatus('Заполни Base URL и выбери rule-set', 'err');
    return;
  }
  $('addSelectedBtn').disabled = true;
  let added = 0;
  let skipped = 0;
  let failed = 0;
  const done = [];
  try {
    await saveSettings();
    for (const cb of boxes) {
      const li = cb.closest('li');
      const domInput = li ? li.querySelector('.dom-input') : null;
      const domain = domInput ? domInput.value.trim() : '';
      if (!domain) continue;
      try {
        const res = await addDomainToRuleSet(cfg, domain, cfg.matcher);
        res.alreadyPresent ? skipped++ : added++;
        if (!res.alreadyPresent) await addHistory(res.domain);
        done.push(cb.dataset.domain);
      } catch (e) {
        failed++;
        showStatus('Домен ' + domain + ': ' + String((e && e.message) || e), 'err');
      }
    }
    if (!failed) {
      let msg = 'Добавлено: ' + added;
      if (skipped) msg += ', уже были: ' + skipped;
      showStatus(msg, 'ok');
    }
    if (done.length) {
      const s = await chrome.storage.local.get(FAILED_KEY);
      let list = Array.isArray(s[FAILED_KEY]) ? s[FAILED_KEY] : [];
      list = list.filter((x) => !done.includes(x.domain));
      await chrome.storage.local.set({ [FAILED_KEY]: list });
      renderFailedDomains(list);
    }
  } finally {
    $('addSelectedBtn').disabled = false;
  }
}

$('saveBtn').addEventListener('click', async () => {
  await saveSettings();
  try {
    await chrome.notifications.create('awg-settings-saved', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'AWG Rule-Set',
      message: 'Настройки сохранены',
    });
  } catch (_) {}
});

$('checkBtn').addEventListener('click', async () => {
  const cfg = currentCfg();
  const res = $('checkResult');
  if (!cfg.baseUrl) {
    res.textContent = 'Укажи Base URL';
    res.hidden = false;
    res.classList.remove('ok');
    res.classList.add('err');
    return;
  }
  $('checkBtn').disabled = true;
  res.textContent = 'Проверяю…';
  res.hidden = false;
  res.classList.remove('ok', 'err');
  try {
    const list = await listRuleSets(cfg);
    res.textContent = 'OK: соединение установлено, наборов: ' + list.length;
    res.classList.add('ok');
  } catch (e) {
    res.textContent = 'Ошибка: ' + String((e && e.message) || e);
    res.classList.add('err');
  } finally {
    $('checkBtn').disabled = false;
  }
});

$('settingsToggle').addEventListener('click', async () => {
  const panel = $('settingsPanel');
  panel.classList.toggle('open');
  await chrome.storage.local.set({ settingsOpen: panel.classList.contains('open') });
});

$('refreshListBtn').addEventListener('click', () => loadRuleSetOptions({ showErrors: true }));

$('openEditorBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
});

$('addBtn').addEventListener('click', addDomain);

$('domainInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addDomain();
});

$('clearBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove('addedHistory');
  await loadHistory();
});

$('addSelectedBtn').addEventListener('click', addFailedSelected);

$('clearFailedBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ [FAILED_KEY]: [] });
  renderFailedDomains([]);
});

(async () => {
  await loadSettings();
  const so = await chrome.storage.local.get('settingsOpen');
  if (so.settingsOpen !== false) $('settingsPanel').classList.add('open');
  await loadHistory();
  await loadFailedDomains();
  await prefillFromActiveTab();
  await loadRuleSetOptions({ showErrors: false });
})();