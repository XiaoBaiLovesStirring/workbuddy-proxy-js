/**
 * account.js - 账号管理
 *
 * 支持两种格式：
 * 1. 官方格式（从 WorkBuddy 客户端导出）: { account: {uid, nickname}, auth: {accessToken, refreshToken}, region }
 * 2. 代理格式: { uid, accessToken, refreshToken, realm, nickname }
 *
 * 账号文件存储在: ~/.config/workbuddyaip/API/accounts.json
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const ACCOUNTS_FILE = config.ACCOUNTS_FILE;

/**
 * 读取所有账号
 */
function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    logger.error(`读取账号文件失败: ${e.message}`);
  }
  return [];
}

/**
 * 保存账号列表
 */
function saveAccounts(accounts) {
  try {
    config.ensureDirs();
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  } catch (e) {
    logger.error(`保存账号文件失败: ${e.message}`);
  }
}

/**
 * 规范化账号格式（统一转换为代理内部格式）
 */
function normalizeAccount(input) {
  // 官方格式: { account: {uid, nickname}, auth: {accessToken, refreshToken}, region }
  if (input.account && input.auth) {
    const realm = input.region === 'china' || input.region === 'cn' ? 'cn' : 'intl';
    return {
      uid: input.account.uid,
      accessToken: input.auth.accessToken,
      refreshToken: input.auth.refreshToken || '',
      realm,
      nickname: input.account.nickname || input.account.username || input.account.uid.slice(0, 8),
    };
  }
  // 代理格式
  return {
    uid: input.uid,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken || '',
    realm: input.realm || 'intl',
    nickname: input.nickname || input.uid?.slice(0, 8) || 'unknown',
  };
}

/**
 * 添加账号
 */
function addAccount(input) {
  const normalized = normalizeAccount(input);
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.uid === normalized.uid && a.realm === normalized.realm);

  const record = {
    id: `${normalized.realm}:${normalized.uid}`,
    uid: normalized.uid,
    accessToken: normalized.accessToken,
    refreshToken: normalized.refreshToken,
    realm: normalized.realm,
    nickname: normalized.nickname,
    createdAt: Date.now(),
    lastUsed: 0,
    successCount: 0,
    failCount: 0,
    enabled: true,
    healthStatus: 'unknown',
  };

  if (idx >= 0) {
    // 保留统计数据，更新 token
    record.createdAt = accounts[idx].createdAt;
    record.lastUsed = accounts[idx].lastUsed;
    record.successCount = accounts[idx].successCount;
    record.failCount = accounts[idx].failCount;
    accounts[idx] = { ...accounts[idx], ...record };
  } else {
    accounts.push(record);
  }
  saveAccounts(accounts);
  logger.info(`账号已添加/更新: ${record.nickname} (${record.realm})`);
  return record;
}

/**
 * 从官方格式 JSON 文件批量导入账号
 * @param {string} filePath - 文件路径
 * @returns {number} 导入的账号数
 */
function importFromFile(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let count = 0;

  if (Array.isArray(data)) {
    for (const item of data) {
      addAccount(item);
      count++;
    }
  } else if (data.account && data.auth) {
    addAccount(data);
    count++;
  } else if (data.accounts && Array.isArray(data.accounts)) {
    // 某些格式有 accounts 子数组
    for (const item of data.accounts) {
      addAccount(item);
      count++;
    }
  }
  return count;
}

/**
 * 从 API 目录自动扫描并导入账号文件
 * 扫描 ~/.config/workbuddyaip/API/ 下的所有 .json 文件
 */
function autoImportFromApiDir() {
  try {
    const files = fs.readdirSync(config.API_DIR).filter(f =>
      f.endsWith('.json') && f !== 'accounts.json'
    );
    let total = 0;
    for (const file of files) {
      try {
        const count = importFromFile(path.join(config.API_DIR, file));
        if (count > 0) {
          logger.info(`从 ${file} 导入 ${count} 个账号`);
          total += count;
        }
      } catch (e) {
        logger.warn(`导入 ${file} 失败: ${e.message}`);
      }
    }
    return total;
  } catch (e) {
    logger.warn(`扫描 API 目录失败: ${e.message}`);
    return 0;
  }
}

/**
 * 删除账号
 */
function removeAccount(id) {
  const accounts = loadAccounts().filter(a => a.id !== id);
  saveAccounts(accounts);
}

/**
 * 获取一个可用账号（按 lastUsed 轮询）
 * @param {string} [realm] - 限定区域
 * @param {string[]} [excludeIds] - 排除的账号 id（用于失败重试时换账号）
 */
function getAvailableAccount(realm, excludeIds) {
  const exclude = new Set(Array.isArray(excludeIds) ? excludeIds : []);
  const all = loadAccounts().filter(a =>
    a.enabled && !exclude.has(a.id) && (!realm || a.realm === realm)
  );
  // 优先挑健康账号；没有健康账号时退回全部候选
  const healthy = all.filter(a => a.healthStatus !== 'unhealthy');
  const pool = healthy.length > 0 ? healthy : all;
  if (pool.length === 0) return null;
  pool.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  return pool[0];
}

/**
 * 按 ID 获取账号
 */
function getAccountById(id) {
  return loadAccounts().find(a => a.id === id) || null;
}

/**
 * 更新账号使用统计
 */
function updateAccountStats(id, success) {
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.id === id);
  if (idx >= 0) {
    accounts[idx].lastUsed = Date.now();
    if (success) {
      accounts[idx].successCount = (accounts[idx].successCount || 0) + 1;
    } else {
      accounts[idx].failCount = (accounts[idx].failCount || 0) + 1;
    }
    saveAccounts(accounts);
  }
}

module.exports = {
  loadAccounts,
  saveAccounts,
  addAccount,
  importFromFile,
  autoImportFromApiDir,
  removeAccount,
  getAvailableAccount,
  getAccountById,
  updateAccountStats,
  normalizeAccount,
  ACCOUNTS_FILE,
};
