/**
 * models.js - 模型自动发现与缓存
 *
 * 同时从上游两个端点获取模型列表并合并取并集：
 *   1. /v2/enterprises/personal/models - 企业级配置（18个模型）
 *   2. /v3/config - 完整配置（27个模型，含 DeepSeek/GPT-6/Grok 等）
 *
 * 缓存 1 小时，失败 5 分钟负缓存。
 */
const https = require('https');
const identity = require('./identity');
const logger = require('./logger');

const MODEL_CACHE_TTL = 60 * 60 * 1000; // 1 小时
const MODEL_FAIL_COOLDOWN = 5 * 60 * 1000; // 5 分钟

// 按 realm 缓存
const cache = {
  intl: { models: null, fetched: 0, lastFail: 0 },
  cn: { models: null, fetched: 0, lastFail: 0 },
};

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
 * 转换上游模型为内部统一格式
 */
function normalizeModel(m, source) {
  return {
    id: m.id,
    name: m.name || m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'workbuddy',
    description: m.descriptionZh || m.descriptionEn || '',
    maxInputTokens: m.maxInputTokens || m.maxAllowedSize || (m.contextWindow?.defaultLength) || 0,
    maxOutputTokens: m.maxOutputTokens || 0,
    credits: m.credits || '',
    supportsImages: !!m.supportsImages,
    supportsToolCall: !!m.supportsToolCall,
    supportsReasoning: !!m.supportsReasoning,
    isDefault: !!m.isDefault,
    vendor: m.vendor || '',
    source: source, // 标记来源端点
  };
}

/**
 * 从 /v2/enterprises/personal/models 获取模型
 */
async function fetchFromV2(account, baseUrl, headers) {
  const url = `${baseUrl}/v2/enterprises/personal/models`;
  const res = await httpsRequest(url, headers);
  if (res.status !== 200) {
    throw new Error(`/v2 端点 HTTP ${res.status}`);
  }
  const json = JSON.parse(res.body);
  if (json.code !== 0 || !json.data?.models) {
    throw new Error('/v2 端点格式异常');
  }
  return json.data.models.map(m => normalizeModel(m, 'v2'));
}

/**
 * 从 /v3/config 获取模型
 */
async function fetchFromV3(account, baseUrl, headers) {
  const url = `${baseUrl}/v3/config`;
  const res = await httpsRequest(url, headers);
  if (res.status !== 200) {
    throw new Error(`/v3 端点 HTTP ${res.status}`);
  }
  const json = JSON.parse(res.body);
  if (json.code !== 0 || !json.data?.models) {
    throw new Error('/v3 端点格式异常');
  }
  return json.data.models.map(m => normalizeModel(m, 'v3'));
}

/**
 * 从上游获取模型列表（双端点合并取并集）
 * @param {Object} account - 账号对象
 * @returns {Promise<Array>} 模型列表
 */
async function fetchModels(account) {
  const { baseUrl } = identity.endpointFor(account.realm, 'workbuddy');
  const headers = identity.buildIdentityHeaders({
    realm: account.realm,
    uid: account.uid,
    token: account.accessToken,
  });

  // 并行请求两个端点
  const [v2Result, v3Result] = await Promise.allSettled([
    fetchFromV2(account, baseUrl, headers),
    fetchFromV3(account, baseUrl, headers),
  ]);

  const v2Models = v2Result.status === 'fulfilled' ? v2Result.value : [];
  const v3Models = v3Result.status === 'fulfilled' ? v3Result.value : [];

  if (v2Models.length === 0 && v3Models.length === 0) {
    const v2Err = v2Result.status === 'rejected' ? v2Result.reason.message : 'unknown';
    const v3Err = v3Result.status === 'rejected' ? v3Result.reason.message : 'unknown';
    throw new Error(`两个端点均失败: v2=${v2Err}, v3=${v3Err}`);
  }

  // 合并取并集，v2 优先（企业级配置更权威），v3 补充
  const modelMap = new Map();

  // 先加 v3 的（作为基础）
  for (const m of v3Models) {
    modelMap.set(m.id, m);
  }

  // 再用 v2 的覆盖（v2 数据更权威）
  for (const m of v2Models) {
    modelMap.set(m.id, m);
  }

  const merged = Array.from(modelMap.values());

  // 确保 default-model 排在第一位
  merged.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return 0;
  });

  logger.info(`[MODELS] 模型发现完成: v2=${v2Models.length}个, v3=${v3Models.length}个, 合并后=${merged.length}个`);
  if (v2Result.status === 'rejected') {
    logger.warn(`[MODELS] v2 端点失败: ${v2Result.reason.message}`);
  }
  if (v3Result.status === 'rejected') {
    logger.warn(`[MODELS] v3 端点失败: ${v3Result.reason.message}`);
  }

  return merged;
}

/**
 * 获取模型列表（带缓存）
 * @param {Object} account - 账号对象
 * @param {boolean} [force=false] - 强制刷新
 * @returns {Promise<Array>}
 */
async function getModels(account, force = false) {
  const c = cache[account.realm] || cache.intl;

  if (!force && c.models && Date.now() - c.fetched < MODEL_CACHE_TTL) {
    return c.models;
  }

  // 失败负缓存
  if (!force && c.lastFail && Date.now() - c.lastFail < MODEL_FAIL_COOLDOWN) {
    return c.models || [];
  }

  try {
    const models = await fetchModels(account);
    c.models = models;
    c.fetched = Date.now();
    c.lastFail = 0;
    return models;
  } catch (e) {
    c.lastFail = Date.now();
    logger.error(`[MODELS] 获取失败: ${e.message}`);
    return c.models || []; // 返回旧缓存
  }
}

/**
 * 检查模型是否存在
 */
function modelExists(account, modelId) {
  const c = cache[account.realm] || cache.intl;
  if (!c.models) return true; // 缓存未就绪时放行
  return c.models.some(m => m.id === modelId);
}

/**
 * 获取默认模型 ID
 */
function getDefaultModel(account) {
  const c = cache[account.realm] || cache.intl;
  if (!c.models) return 'default-model';
  const def = c.models.find(m => m.isDefault);
  return def ? def.id : (c.models[0]?.id || 'default-model');
}

module.exports = {
  getModels,
  fetchModels,
  modelExists,
  getDefaultModel,
  httpsRequest,
};
