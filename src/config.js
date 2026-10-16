/**
 * config.js - 配置与路径管理
 *
 * 配置目录: ~/.config/workbuddyaip/
 *   API/    - 账号文件（支持官方格式和代理格式）
 *   logs/   - 日志目录
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

// 配置根目录
const CONFIG_DIR = process.env.WB_CONFIG_DIR || path.join(os.homedir(), '.config', 'workbuddyaip');
const API_DIR = path.join(CONFIG_DIR, 'API');
const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const ACCOUNTS_FILE = path.join(API_DIR, 'accounts.json');
const PID_FILE = path.join(CONFIG_DIR, 'proxy.pid');

// 确保目录存在
function ensureDirs() {
  for (const dir of [CONFIG_DIR, API_DIR, LOG_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// 端口配置
const PORT = parseInt(process.env.PORT || '8788', 10);
const HOST = process.env.HOST || '127.0.0.1';

// 保活配置
const KEEPALIVE_INTERVAL = parseInt(process.env.KEEPALIVE_INTERVAL || '300000', 10); // 5 分钟
const TOKEN_REFRESH_THRESHOLD = 60 * 60 * 1000; // token 过期前 1 小时刷新

// 提示词清洗配置
const PROMPT_SANITIZE_ENABLED = process.env.PROMPT_SANITIZE !== 'false';

module.exports = {
  CONFIG_DIR,
  API_DIR,
  LOG_DIR,
  ACCOUNTS_FILE,
  PID_FILE,
  ensureDirs,
  PORT,
  HOST,
  KEEPALIVE_INTERVAL,
  TOKEN_REFRESH_THRESHOLD,
  PROMPT_SANITIZE_ENABLED,
};
