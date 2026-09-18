const $ = (id) => document.getElementById(id);

let statusTimer = null;
let loadedContentTag = null;

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

async function getCfg() {
  const s = await chrome.storage.local.get(['baseUrl', 'apiKey', 'ruleSetTag', 'flavor']);
  return {
    baseUrl: String(s.baseUrl || ''),
    apiKey: String(s.apiKey || ''),
    ruleSetTag: String(s.ruleSetTag || ''),
    flavor: String(s.flavor || 'fakeip'),
  };
}

async function refreshConnHint() {
  const cfg = await getCfg();
  $('connHint').textContent = cfg.baseUrl
    ? 'Base URL: ' + cfg.baseUrl
    : 'Base URL не задан — укажи его в настройках попапа';
}

function setButtonsState() {
  const hasTag = !!$('tagSelect').value;
  $('loadBtn').disabled = !hasTag;
  $('saveBtn').disabled = !hasTag;
}

function populateEmptyOption(text) {
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = text;
  $('tagSelect').appendChild(opt);
}

async function loadOptions({ showErrors } = {}) {
  const cfg = await getCfg();
  $('connHint').textContent = cfg.baseUrl ? 'Base URL: ' + cfg.baseUrl : 'Base URL не задан';
  if (!cfg.baseUrl) {
    if (showErrors) showStatus('Base URL не задан — открой попап и заполни настройки', 'err');
    return;
  }
  $('refreshBtn').disabled = true;
  try {
    const list = await listRuleSets(cfg);
    const inline = list.filter((rs) => rs.type === 'inline');
    const sel = $('tagSelect');
    sel.textContent = '';
    if (!inline.length) {
      populateEmptyOption('— inline-наборов нет —');
    }
    for (const rs of inline) {
      const opt = document.createElement('option');
      opt.value = rs.tag;
      opt.textContent = rs.tag;
      sel.appendChild(opt);
    }
    if (cfg.ruleSetTag && !inline.some((rs) => rs.tag === cfg.ruleSetTag)) {
      const opt = document.createElement('option');
      opt.value = cfg.ruleSetTag;
      opt.textContent = cfg.ruleSetTag + ' (не в списке)';
      sel.appendChild(opt);
    }
    sel.value = cfg.ruleSetTag || '';
    loadedContentTag = null;
    $('content').value = '';
    showStatus('Inline-наборов найдено: ' + inline.length, 'ok');
    setButtonsState();
  } catch (e) {
    populateEmptyOption('— список не загрузился —');
    if (showErrors) showStatus(String((e && e.message) || e), 'err');
    setButtonsState();
  } finally {
    $('refreshBtn').disabled = false;
  }
}

async function fetchContent(cfg, tag) {
  const rs = await findRuleSet(cfg, tag);
  const rules = Array.isArray(rs.rules) ? rs.rules : [];
  $('content').value = JSON.stringify(rules, null, 2);
  $('content').setAttribute('data-tag', tag);
  loadedContentTag = tag;
  return rules.length;
}

async function saveContent(cfg, tag, rules) {
  const rs = await findRuleSet(cfg, tag);
  const eps = getEndpoints(cfg.flavor);
  const ruleSet = Object.assign({}, rs, { rules });
  await awgRequest({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    path: eps.update,
    method: 'POST',
    body: { tag, ruleSet },
  });
  return rules.length;
}

$('closeBtn').addEventListener('click', () => {
  chrome.tabs.getCurrent((tab) => {
    if (tab && tab.id != null) chrome.tabs.remove(tab.id);
  });
});

$('tagSelect').addEventListener('change', () => {
  loadedContentTag = null;
  $('content').value = '';
  $('content').removeAttribute('data-tag');
  setButtonsState();
});

$('refreshBtn').addEventListener('click', () => loadOptions({ showErrors: true }));

$('loadBtn').addEventListener('click', async () => {
  const cfg = await getCfg();
  const tag = $('tagSelect').value;
  if (!tag) {
    showStatus('Сначала выбери rule-set', 'err');
    return;
  }
  $('loadBtn').disabled = true;
  try {
    const count = await fetchContent(cfg, tag);
    showStatus('Загружено правил: ' + count, 'ok');
  } catch (e) {
    showStatus(String((e && e.message) || e), 'err');
  } finally {
    $('loadBtn').disabled = false;
  }
});

$('saveBtn').addEventListener('click', async () => {
  const cfg = await getCfg();
  const tag = $('tagSelect').value;
  if (!tag) {
    showStatus('Сначала выбери rule-set', 'err');
    return;
  }
  let rules;
  try {
    rules = JSON.parse($('content').value || '[]');
  } catch (e) {
    showStatus('Некорректный JSON: ' + (e && e.message), 'err');
    return;
  }
  if (!Array.isArray(rules)) {
    showStatus('Ожидается JSON-массив правил', 'err');
    return;
  }
  $('saveBtn').disabled = true;
  try {
    const count = await saveContent(cfg, tag, rules);
    await fetchContent(cfg, tag);
    loadedContentTag = tag;
    showStatus('Сохранено правил: ' + count, 'ok');
  } catch (e) {
    showStatus(String((e && e.message) || e), 'err');
  } finally {
    $('saveBtn').disabled = false;
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    $('saveBtn').click();
  }
});

(async () => {
  await refreshConnHint();
  await loadOptions({ showErrors: false });
})();