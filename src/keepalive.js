/**
 * keepalive.js - 保活模块
 *
 * 定时执行：
 * 1. Token 刷新（过期前自动刷新）
 * 2. 额度查询（更新账号余额/积分信息）
 * 3. 账号健康检查（验证 token 是否有效）
 */
const https = require('https');
const identity = require('./identity');
const logger = require('./logger');
const config = require('./config');

let keepaliveTimer = null;
let isRunning = false;

/**
 * 发起 HTTPS 请求
 */
function httpsRequest(url, headers, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 解析 JWT 获取过期时间
 */
function getTokenExpiry(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return (payload.exp || 0) * 1000;
  } catch (e) {
    return 0;
  }
}

/**
 * 刷新 token（使用 refreshToken）
 * 注意：WorkBuddy 使用 Keycloak，刷新端点为 /auth/realms/copilot/protocol/openid-connect/token
 */
async function refreshToken(account) {
  if (!account.refreshToken) {
    return { success: false, error: 'no refresh token' };
  }

  const { baseUrl } = identity.endpointFor(account.realm, 'workbuddy');
  const tokenUrl = `${baseUrl}/auth/realms/copilot/protocol/openid-connect/token`;

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      client_id: 'copilot',
    });

    const res = await httpsRequest(tokenUrl, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0',
    }, 'POST', body.toString());

    if (res.status === 200) {
      const data = JSON.parse(res.body);
      return {
        success: true,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || account.refreshToken,
      };
    }
    return { success: false, error: `HTTP ${res.status}: ${res.body.slice(0, 200)}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 查询账号额度/积分
 */
async function checkQuota(account) {
  try {
    const { baseUrl } = identity.endpointFor(account.realm, 'workbuddy');
    const headers = identity.buildBillingHeaders(account.realm, account.uid, account.accessToken);

    // 尝试查询积分/额度端点
    const endpoints = [
      `${baseUrl}/billing/meter/quota`,
      `${baseUrl}/v2/billing/quota`,
      `${baseUrl}/api/billing/quota`,
    ];

    for (const url of endpoints) {
      try {
        const res = await httpsRequest(url, headers);
        if (res.status === 200) {
          const data = JSON.parse(res.body);
          return { success: true, data: data.data || data };
        }
      } catch (e) { /* 尝试下一个端点 */ }
    }
    return { success: false, error: 'quota endpoint not available' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 验证账号 token 是否有效（通过请求模型列表）
 */
async function verifyAccount(account) {
  try {
    const { baseUrl } = identity.endpointFor(account.realm, 'workbuddy');
    const url = `${baseUrl}/v2/enterprises/personal/models`;
    const headers = identity.buildIdentityHeaders({
      realm: account.realm,
      uid: account.uid,
      token: account.accessToken,
    });
    const res = await httpsRequest(url, headers);
    return res.status === 200;
  } catch (e) {
    return false;
  }
}

/**
 * 执行一次保活检查
 */
async function runKeepalive(accountMgr) {
  if (isRunning) return;
  isRunning = true;

  try {
    const accounts = accountMgr.loadAccounts();
    const now = Date.now();

    for (const account of accounts) {
      if (!account.enabled) continue;

      // 1. 检查 token 是否即将过期
      const expiry = getTokenExpiry(account.accessToken);
      if (expiry > 0 && expiry - now < config.TOKEN_REFRESH_THRESHOLD) {
        logger.info(`[KEEPALIVE] Token 即将过期，正在刷新: ${account.nickname || account.uid}`);
        const result = await refreshToken(account);
        if (result.success) {
          account.accessToken = result.accessToken;
          account.refreshToken = result.refreshToken;
          account.lastRefresh = now;
          logger.info(`[KEEPALIVE] Token 刷新成功: ${account.nickname || account.uid}`);
        } else {
          logger.warn(`[KEEPALIVE] Token 刷新失败: ${account.nickname || account.uid} - ${result.error}`);
        }
      }

      // 2. 验证账号健康
      const valid = await verifyAccount(account);
      if (!valid) {
        logger.warn(`[KEEPALIVE] 账号验证失败，尝试刷新: ${account.nickname || account.uid}`);
        const result = await refreshToken(account);
        if (result.success) {
          account.accessToken = result.accessToken;
          account.refreshToken = result.refreshToken;
          account.lastRefresh = now;
        } else {
          account.healthStatus = 'unhealthy';
        }
      } else {
        account.healthStatus = 'healthy';
        account.lastHealthCheck = now;
      }

      // 3. 查询额度（静默，失败不影响）
      const quota = await checkQuota(account);
      if (quota.success) {
        account.quota = quota.data;
        account.lastQuotaCheck = now;
      }
    }

    // 保存更新
    accountMgr.saveAccounts(accounts);
    logger.info(`[KEEPALIVE] 保活检查完成，共 ${accounts.length} 个账号`);
  } catch (e) {
    logger.error(`[KEEPALIVE] 保活检查异常: ${e.message}`);
  } finally {
    isRunning = false;
  }
}

/**
 * 启动保活定时器
 */
function start(accountMgr) {
  if (keepaliveTimer) return;
  logger.info(`[KEEPALIVE] 保活模块已启动，间隔 ${config.KEEPALIVE_INTERVAL / 1000} 秒`);
  // 启动后 10 秒执行第一次
  setTimeout(() => runKeepalive(accountMgr), 10000);
  keepaliveTimer = setInterval(() => runKeepalive(accountMgr), config.KEEPALIVE_INTERVAL);
}

/**
 * 停止保活定时器
 */
function stop() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    logger.info('[KEEPALIVE] 保活模块已停止');
  }
}

module.exports = {
  start,
  stop,
  runKeepalive,
  refreshToken,
  checkQuota,
  verifyAccount,
  getTokenExpiry,
};
