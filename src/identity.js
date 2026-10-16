/**
 * identity.js - 出站身份头构造
 *
 * 支持国际版 (workbuddy.ai) 和国内版 (copilot.tencent.com) 桌面端身份。
 * 按 5.8.4 抓包对齐：UA、会话头族、trace 头族。
 */
const crypto = require('crypto');
const fp = require('./fingerprint');

// 国际版桌面端 (5.8.4 抓包)
const DESKTOP_VERSION_INTL = '5.8.4';
const DESKTOP_UA_INTL = 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0';

// 国内版桌面端
const DESKTOP_VERSION_CN = '5.5.6';
const DESKTOP_UA_CN = 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1';

// 端点映射: [realm, product] => [baseUrl, xDomain]
const ENDPOINTS = {
  'intl:workbuddy': ['https://www.workbuddy.ai', 'www.workbuddy.ai'],
  'intl:vscode':    ['https://www.workbuddy.ai', 'www.workbuddy.ai'],
  'intl:cli':       ['https://www.workbuddy.ai', 'www.workbuddy.ai'],
  'cn:workbuddy':   ['https://copilot.tencent.com', 'copilot.tencent.com'],
  'cn:vscode':       ['https://www.workbuddy.cn', 'www.workbuddy.cn'],
  'cn:cli':          ['https://copilot.tencent.com', 'copilot.tencent.com'],
};

/**
 * 获取指定 realm 和 product 的端点信息
 * @param {string} realm - 'intl' | 'cn'
 * @param {string} product - 'workbuddy' | 'vscode' | 'cli'
 * @returns {{baseUrl: string, domain: string}}
 */
function endpointFor(realm, product = 'workbuddy') {
  const key = `${realm}:${product}`;
  const ep = ENDPOINTS[key] || ENDPOINTS['intl:workbuddy'];
  return { baseUrl: ep[0], domain: ep[1] };
}

/**
 * 构造 trace 头族 (5.8.4 对话请求带的链路头)
 */
function traceHeaders() {
  const trace = fp.newMessageId();
  const span = crypto.randomBytes(8).toString('hex');
  return {
    'X-Trace-ID': trace,
    'traceparent': `00-${trace}-${span}-01`,
    'b3': `${trace}-${span}-1`,
    'X-B3-TraceId': trace,
    'X-B3-SpanId': span,
    'X-B3-Sampled': '1',
  };
}

/**
 * 构造完整的桌面端身份头
 *
 * @param {Object} opts
 * @param {string} opts.realm - 'intl' | 'cn'
 * @param {string} opts.uid - 账号 UID
 * @param {string} opts.token - access token
 * @param {string} [opts.conversationId] - 可选，指定会话 ID
 * @param {string} [opts.enterpriseId] - 企业 ID（可选）
 * @param {string} [opts.department] - 部门信息（可选）
 * @returns {Object} headers 对象
 */
function buildIdentityHeaders(opts) {
  const { realm, uid, token, conversationId, enterpriseId, department } = opts;
  const isCN = realm === 'cn';

  const clientVer = isCN ? DESKTOP_VERSION_CN : DESKTOP_VERSION_INTL;
  const chatUA = isCN ? DESKTOP_UA_CN : DESKTOP_UA_INTL;
  const { domain } = endpointFor(realm, 'workbuddy');

  const conv = conversationId || fp.newConversationId();
  const msgId = fp.newMessageId();
  const convReqId = fp.newMessageId();

  const headers = {
    // 基础
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': `https://${domain}`,
    'Referer': `https://${domain}/`,
    'X-CodeBuddy-Request': '1',
    'Accept-Language': isCN ? 'zh-CN' : 'en-US',
    // 身份
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': clientVer,
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'X-Domain': domain,
    'User-Agent': chatUA,
    'X-User-Id': String(uid || 'anonymous'),
    'Authorization': `Bearer ${token || ''}`,
    // 会话头族
    'X-Conversation-ID': conv,
    'X-Conversation-Request-ID': convReqId,
    'X-Root-Request-ID': convReqId,
    'X-Conversation-Message-ID': msgId,
    'X-Request-ID': msgId,
  };

  // trace 头族
  Object.assign(headers, traceHeaders());

  // 企业/部门
  if (enterpriseId) {
    headers['X-Enterprise-Id'] = String(enterpriseId);
    headers['X-Tenant-Id'] = String(enterpriseId);
  }
  if (department) {
    headers['X-Department-Info'] = String(department);
  }

  return headers;
}

/**
 * 构造 billing/反馈上报用的轻量头（带 X-Machine-ID / X-Session-ID）
 */
function buildBillingHeaders(realm, uid, token) {
  const isCN = realm === 'cn';
  const { domain } = endpointFor(realm, 'workbuddy');
  const ua = isCN ? DESKTOP_UA_CN : DESKTOP_UA_INTL;

  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': ua,
    'Origin': `https://${domain}`,
    'Referer': `https://${domain}/`,
    'Authorization': `Bearer ${token}`,
    'X-User-Id': uid,
    'X-Domain': domain,
    'X-CodeBuddy-Request': '1',
    'Accept-Language': isCN ? 'zh-CN' : 'en-US',
    'X-Request-ID': fp.generateRequestId(),
    'X-Machine-ID': fp.deriveId(uid, 'machine'),
    'X-Session-ID': fp.sessionId(uid),
    'X-No-Enterprise-Id': '1',
  };
}

module.exports = {
  buildIdentityHeaders,
  buildBillingHeaders,
  endpointFor,
  DESKTOP_VERSION_INTL,
  DESKTOP_UA_INTL,
  DESKTOP_VERSION_CN,
  DESKTOP_UA_CN,
};
