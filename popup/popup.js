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

async function loadSettings() {
  const s = await chrome.storage.local.get(['baseUrl', 'apiKey', 'ruleSetTag', 'flavor', 'matcher']);
  $('baseUrl').value = s.baseUrl || 'http://192.168.1.1:2222/api';
  $('apiKey').value = s.apiKey || '';
  $('ruleSetTag').value = s.ruleSetTag || '';
  $('flavor').value = s.flavor || 'fakeip';
  $('matcher').value = s.matcher || 'domain_suffix';
  $('refreshListBtn').disabled = !$('baseUrl').value;
}

async function saveSettings() {
  await chrome.storage.local.set({
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    ruleSetTag: $('ruleSetTag').value.trim(),
    flavor: $('flavor').value,
    matcher: $('matcher').value,
  });
  showStatus('Настройки сохранены', 'ok');
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
  } catch (e) {
    if (showErrors) showStatus(String((e && e.message) || e), 'err');
  } finally {
    $('refreshListBtn').disabled = !$('baseUrl').value;
  }
}

async function addDomain() {
  const cfg = currentCfg();
  if (!cfg.baseUrl || !cfg.ruleSetTag) {
    showStatus('Заполни Base URL и выбери rule-set', 'err');
    return;
  }
  $('addBtn').disabled = true;
  try {
    await saveSettings();
    const res = await addDomainToRuleSet(cfg, $('domainInput').value, cfg.matcher);
    if (res.alreadyPresent) {
      showStatus(res.domain + ' уже был в наборе ' + res.tag, 'ok');
    } else {
      showStatus(res.domain + ' добавлен в ' + res.tag + ' (' + cfg.matcher + ')', 'ok');
    }
    $('domainInput').value = '';
    await addHistory(res.domain);
  } catch (e) {
    showStatus(String((e && e.message) || e), 'err');
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
    if (host) $('domainInput').value = host;
  } catch (_) {}
}

$('saveBtn').addEventListener('click', saveSettings);

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

$('settingsToggle').addEventListener('click', () => {
  $('settingsPanel').open = !$('settingsPanel').open;
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

(async () => {
  await loadSettings();
  await loadHistory();
  await prefillFromActiveTab();
  await loadRuleSetOptions({ showErrors: false });
})();