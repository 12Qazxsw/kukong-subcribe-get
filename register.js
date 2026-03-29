const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { URLSearchParams } = require('url');
const cheerio = require('cheerio');
const https = require('https');
const clipboardy = require('clipboardy');

function makeAxios(allowInsecure = false) {
  return axios.create({
    httpsAgent: new https.Agent({
      rejectUnauthorized: !allowInsecure,
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1.3'
    }),
    timeout: 15000
  });
}

const BASE_URL = 'https://51wukong.org';
const REGISTER_PATH = '/auth/register';
const REGISTER_URL = BASE_URL + REGISTER_PATH;

const USED_FILE = path.join(__dirname, 'used.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

function ensureFile(filePath, initial = '[]') {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, initial, 'utf8');
}

ensureFile(USED_FILE);
ensureFile(ACCOUNTS_FILE);

function purgeOldAccounts() {
  const accounts = readJson(ACCOUNTS_FILE);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const filtered = accounts.filter(a => {
    if (!a.createdAt) return true;
    const t = Date.parse(a.createdAt);
    if (Number.isNaN(t)) return true;
    return (now - t) <= dayMs;
  });
  if (filtered.length !== accounts.length) writeJson(ACCOUNTS_FILE, filtered);
  return filtered;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return []; }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function randString(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function extractCookieString(setCookieArray) {
  if (!setCookieArray) return '';
  if (!Array.isArray(setCookieArray)) setCookieArray = [setCookieArray];
  return setCookieArray.map(s => s.split(';')[0]).join('; ');
}

async function registerOne() {
  const used = readJson(USED_FILE);

  let username, email, password;
  const domains = ['example.com', 'test.com', 'mail.com'];

  // generate unique credentials
  do {
    username = 'u' + randString(10);
    email = randString(8) + '@' + domains[Math.floor(Math.random() * domains.length)];
  } while (used.find(u => u.username === username || u.email === email));

  password = randString(12) + 'A1!';

  const params = new URLSearchParams({
    tos: 'true',
    code: '',
    name: username,
    email: email,
    passwd: password,
    repasswd: password
  });

    try {
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json, text/javascript, */*; q=0.01',
      'accept-language': 'zh-CN,zh;q=0.9',
      'cache-control': 'no-cache',
      origin: BASE_URL,
      pragma: 'no-cache',
      priority: 'u=1, i',
      referer: REGISTER_URL,
      'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'x-requested-with': 'XMLHttpRequest'
    };

    // Post registration (do not follow redirects so we can capture Set-Cookie)
    let res;
    const postOptions = {
      headers,
      maxRedirects: 0,
      validateStatus: status => status < 400 || status === 302
    };

    try {
      const client = makeAxios(false);
      res = await client.post(REGISTER_URL, params.toString(), postOptions);
    } catch (err) {
      // on TLS/connection errors, retry with relaxed TLS (insecure)
      const code = err && err.code ? err.code : (err && err.response && err.response.status ? err.response.status : null);
      if (code === 'EPROTO' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 525) {
        try {
          const client2 = makeAxios(true);
          res = await client2.post(REGISTER_URL, params.toString(), postOptions);
        } catch (err2) {
          throw err2;
        }
      } else {
        throw err;
      }
    }

    const data = res.data;

    // capture cookie
    const setCookie = res.headers['set-cookie'];
    const cookieString = extractCookieString(setCookie);

    // follow redirect (or just GET the register page with cookie) to retrieve account page/data
    const getHeaders = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
      Referer: REGISTER_URL,
      'user-agent': headers['user-agent']
    };
    if (cookieString) getHeaders.Cookie = cookieString;

    // GET page — reuse secure client first, fallback to insecure if needed
    let pageRes;
    try {
      const client = makeAxios(false);
      pageRes = await client.get(REGISTER_URL, { headers: getHeaders, withCredentials: true });
    } catch (err) {
      const code = err && err.code ? err.code : null;
      if (code === 'EPROTO' || code === 'ECONNRESET' || code === 'ECONNREFUSED') {
        const client2 = makeAxios(true);
        pageRes = await client2.get(REGISTER_URL, { headers: getHeaders, withCredentials: true });
      } else {
        throw err;
      }
    }
    const pageText = pageRes.data;

    // 尝试从页面中提取订阅链接（优先级：input#link -> data-url 列表 -> a/input/全文）
    function findSubscriptionLink(html) {
      const $ = cheerio.load(html);

      // 1) 直接读取 input#link 的 value
      const linkInput = $('#link');
      if (linkInput && linkInput.attr('value')) {
        try { return new URL(linkInput.attr('value'), REGISTER_URL).href; } catch (e) { return linkInput.attr('value'); }
      }

      // 2) 在订阅选择组件内查找 data-url（例如 li[data-url]）
      const subscribeSection = $('#subscribe-select');
      if (subscribeSection && subscribeSection.length) {
        // 优先查找带 selected/active 的项
        const sel = subscribeSection.find('[data-url].selected, [data-url].active, li.selected, li.active').first();
        if (sel && sel.attr && sel.attr('data-url')) {
          try { return new URL(sel.attr('data-url'), BASE_URL).href; } catch (e) { return sel.attr('data-url'); }
        }
        // 否则取第一个 data-url
        const any = subscribeSection.find('[data-url]').first();
        if (any && any.attr && any.attr('data-url')) {
          try { return new URL(any.attr('data-url'), BASE_URL).href; } catch (e) { return any.attr('data-url'); }
        }
      }

      // 3) 查找带有“订阅”关键字的链接
      const a = $('a').toArray().find(el => {
        const t = $(el).text() || '';
        const href = $(el).attr('href') || '';
        return /订阅|订阅地址|订阅链接|subscription|subscribe/i.test(t) || /subscribe|subscription|sub|\/sub\//i.test(href);
      });
      if (a) {
        let href = $(a).attr('href');
        try { href = new URL(href, REGISTER_URL).href; } catch (e) {}
        return href;
      }

      // 4) 查找 input/textarea 中可能包含的链接
      const inputs = $('input[value], textarea').map((i, el) => $(el).val()).get();
      for (const v of inputs) {
        if (!v) continue;
        const m = v.match(/(https?:\/\/[^\s'"<>{}]{8,}|vmess:\/\/[^\s'"<>{}]+|ss:\/\/[^\s'"<>{}]+|trojan:\/\/[^\s'"<>{}]+)/i);
        if (m) return m[0];
      }

      // 5) 全文正则搜索常见订阅/协议链接
      const all = html.match(/(https?:\/\/[^\s'"<>{}]{8,}|vmess:\/\/[^\s'"<>{}]+|ss:\/\/[^\s'"<>{}]+|trojan:\/\/[^\s'"<>{}]+)/i);
      if (all) return all[0];

      return null;
    }

    let subscriptionLink = findSubscriptionLink(pageText);

    // 若当前页面未包含订阅链接，或找到的链接不是 /sub/ 格式，尝试跳转到订阅中心页面再解析
    const isSubFormat = link => link && /\/sub\//.test(link);
    if (!subscriptionLink || !isSubFormat(subscriptionLink)) {
      const $ = cheerio.load(pageText);
      const subHref = $('a[href*="/user/subscribe"], a[href*="/user/subscribe/log"], a[href*="/user/subscribe"]').first().attr('href');
      if (subHref) {
        const subUrl = new URL(subHref, BASE_URL).href;
        // GET subscribe page with same cookie handling (secure first, then insecure)
        let subPageRes;
        try {
          const client = makeAxios(false);
          subPageRes = await client.get(subUrl, { headers: getHeaders, withCredentials: true });
        } catch (err) {
          const code = err && err.code ? err.code : null;
          if (code === 'EPROTO' || code === 'ECONNRESET' || code === 'ECONNREFUSED') {
            const client2 = makeAxios(true);
            subPageRes = await client2.get(subUrl, { headers: getHeaders, withCredentials: true });
          } else {
            subPageRes = null;
          }
        }
        if (subPageRes && subPageRes.data) {
          // 优先从订阅中心页面寻找 /sub/ 格式的地址
          const subHtml = subPageRes.data;
          const $s = cheerio.load(subHtml);
          // 1) input#link value
          const linkVal = $s('#link').attr('value') || $s('#link').val();
          if (linkVal && /\/sub\//.test(linkVal)) {
            try { subscriptionLink = new URL(linkVal, BASE_URL).href; } catch (e) { subscriptionLink = linkVal; }
          }

          // 2) data-url attributes in list items
          if (!subscriptionLink) {
            const dataItem = $s('[data-url*="/sub/"]').first();
            if (dataItem && dataItem.attr && dataItem.attr('data-url')) {
              try { subscriptionLink = new URL(dataItem.attr('data-url'), BASE_URL).href; } catch (e) { subscriptionLink = dataItem.attr('data-url'); }
            }
          }

          // 3) anchors with /sub/ in href
          if (!subscriptionLink) {
            const aSub = $s('a[href*="/sub/"]').first();
            if (aSub && aSub.attr && aSub.attr('href')) {
              try { subscriptionLink = new URL(aSub.attr('href'), BASE_URL).href; } catch (e) { subscriptionLink = aSub.attr('href'); }
            }
          }

          // 4) fallback to previous generic finder
          if (!subscriptionLink) subscriptionLink = findSubscriptionLink(subPageRes.data);
        }
      }
    }

    // 最后确保 subscriptionLink 是 /sub/ 格式；若不是则置为 null
    if (subscriptionLink && !/\/sub\//.test(subscriptionLink)) subscriptionLink = null;

    // save used and accounts
    used.push({ username, email });
    writeJson(USED_FILE, used);

    const accounts = readJson(ACCOUNTS_FILE);
    const accountObj = { username, email, password, createdAt: new Date().toISOString(), subscription: subscriptionLink || null };
    accounts.push(accountObj);
    writeJson(ACCOUNTS_FILE, accounts);

    return { success: true, apiResponse: data, pageText, subscriptionLink, account: accountObj };
  } catch (err) {
    return { success: false, error: err.toString(), response: err.response ? err.response.data : undefined };
  }
}

async function fetchSubscriptionByLogin(account) {
  // login with email or username + password, then GET subscribe page and parse /sub/
  const loginUrl = BASE_URL + '/auth/login';
  const params = new URLSearchParams({
    email: account.email || account.username,
    passwd: account.password,
    // some sites may accept name/password or email/password; include both fields
    name: account.username
  });

  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cache-control': 'no-cache',
    origin: BASE_URL,
    referer: BASE_URL + '/auth/login',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  };

  const postOptions = {
    headers,
    maxRedirects: 0,
    validateStatus: status => status < 400 || status === 302
  };

  let res;
  try {
    const client = makeAxios(false);
    res = await client.post(loginUrl, params.toString(), postOptions);
  } catch (err) {
    const code = err && err.code ? err.code : null;
    if (code === 'EPROTO' || code === 'ECONNRESET' || code === 'ECONNREFUSED') {
      const client2 = makeAxios(true);
      res = await client2.post(loginUrl, params.toString(), postOptions);
    } else throw err;
  }

  const setCookie = res.headers['set-cookie'];
  const cookieString = extractCookieString(setCookie);

  if (!cookieString) throw new Error('登录未返回 cookie');

  const getHeaders = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
    Referer: BASE_URL + '/auth/login',
    'user-agent': headers['user-agent'],
    Cookie: cookieString
  };

  const subscribeUrl = BASE_URL + '/user/subscribe/log';
  let pageRes;
  try {
    const client = makeAxios(false);
    pageRes = await client.get(subscribeUrl, { headers: getHeaders, withCredentials: true });
  } catch (err) {
    const code = err && err.code ? err.code : null;
    if (code === 'EPROTO' || code === 'ECONNRESET' || code === 'ECONNREFUSED') {
      const client2 = makeAxios(true);
      pageRes = await client2.get(subscribeUrl, { headers: getHeaders, withCredentials: true });
    } else throw err;
  }

  const html = pageRes.data;
  const $ = cheerio.load(html);
  // find input#link value or data-url with /sub/
  const linkVal = $('#link').attr('value') || $('#link').val();
  if (linkVal && /\/sub\//.test(linkVal)) return new URL(linkVal, BASE_URL).href;
  const dataItem = $('[data-url*="/sub/"]').first();
  if (dataItem && dataItem.attr && dataItem.attr('data-url')) return new URL(dataItem.attr('data-url'), BASE_URL).href;
  const aSub = $('a[href*="/sub/"]').first();
  if (aSub && aSub.attr && aSub.attr('href')) return new URL(aSub.attr('href'), BASE_URL).href;

  // fallback: regex search
  const all = html.match(/(https?:\/\/[^\s'"<>{}]*\/sub\/[a-z0-9]+(?:\/[a-z0-9_-]+)?)/i);
  if (all) return all[1];

  return null;
}

async function main() {
  const arg = process.argv[2];

  // 启动时清理 accounts.json 中超过 1 天的账号
  purgeOldAccounts();
  if (arg === 'fix' || arg === 'fix-all' || (arg === 'fix' && process.argv[3] === 'all')) {
    // fix 模式：默认一次只处理一个账号（第一个缺少 /sub/ 的账号）。传入第二个参数 'all' 则处理全部账号。
    const processAll = (process.argv[3] === 'all' || arg === 'fix-all');
    const accounts = readJson(ACCOUNTS_FILE);
    const updated = [];

    if (!processAll) {
      // 找到第一个需要更新的账号（没有 subscription 或 subscription 不是 /sub/ 格式）
      const target = accounts.find(a => !a.subscription || !/\/sub\//.test(a.subscription));
      if (!target) {
        console.log('没有需要更新的账号。');
        return;
      }
      try {
        const link = await fetchSubscriptionByLogin(target);
        if (link) target.subscription = link;
        updated.push({ username: target.username, subscription: target.subscription || null });
      } catch (e) {
        updated.push({ username: target.username, error: e.toString() });
      }
      writeJson(ACCOUNTS_FILE, accounts);
      // 打印更友好的输出
      let succ = 0, fail = 0;
      for (const u of updated) {
        if (u.subscription) { console.log(`✔ ${u.username} -> ${u.subscription}`); succ++; }
        else if (u.error) { console.log(`✖ ${u.username} : ${u.error}`); fail++; }
        else { console.log(`- ${u.username} : no subscription`); }
      }
      console.log(`已处理 ${updated.length} 个账号，成功 ${succ}，失败 ${fail}`);
      const first = updated.find(u => u.subscription && u.subscription.startsWith('http'));
      if (first && first.subscription) {
        try { clipboardy.writeSync(first.subscription); console.log(`已复制订阅链接到剪贴板： ${first.subscription}`); } catch (e) { console.error('复制剪贴板失败：', e.toString()); }
      }
      return;
    }

    // processAll = true
    for (const acc of accounts) {
      try {
        const link = await fetchSubscriptionByLogin(acc);
        if (link) acc.subscription = link;
        updated.push({ username: acc.username, subscription: acc.subscription || null });
      } catch (e) {
        updated.push({ username: acc.username, error: e.toString() });
      }
      // 小延迟
      await new Promise(res => setTimeout(res, 800));
    }
    writeJson(ACCOUNTS_FILE, accounts);
    console.log(JSON.stringify(updated, null, 2));
    // 复制第一个有效的订阅链接到剪贴板（如果存在）
    const first = updated.find(u => u.subscription && u.subscription.startsWith('http'));
    if (first && first.subscription) {
      try { clipboardy.writeSync(first.subscription); console.log('已复制订阅链接到剪贴板：', first.subscription); } catch (e) { console.error('复制剪贴板失败：', e.toString()); }
    }
    return;
  }

  const countArg = parseInt(arg) || 1;
  const results = [];
  for (let i = 0; i < countArg; i++) {
    const r = await registerOne();
    results.push(r);
    // small delay between requests
    await new Promise(res => setTimeout(res, 1000));
  }

  // 更清晰的逐项输出与汇总
  let created = 0, failed = 0;
  for (const r of results) {
    if (r.success) {
      const acc = r.account || {};
      const sub = r.subscriptionLink || acc.subscription || '无订阅';
      console.log(`✔ 创建成功: ${acc.username} | ${acc.email} | 订阅: ${sub}`);
      created++;
    } else {
      console.log(`✖ 创建失败: ${r.error}`);
      failed++;
    }
  }
  console.log(`完成：创建 ${created}，失败 ${failed}`);

  // 如果只创建了一个账号且拿到订阅，复制到剪贴板
  if (results.length === 1 && results[0].success) {
    const link = results[0].subscriptionLink || (results[0].account && results[0].account.subscription);
    if (link) {
      try { clipboardy.writeSync(link); console.log(`已复制订阅链接到剪贴板： ${link}`); } catch (e) { console.error('复制剪贴板失败：', e.toString()); }
    }
  }
}

main();
