importScripts('lib/api.js');

const NOTIFY_ID = 'awg-ruleset-notify';

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