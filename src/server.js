/**
 * server.js - WorkBuddy 反代服务器主入口
 *
 * 功能：
 * - OpenAI 兼容接口 (/v1/chat/completions, /v1/models)
 * - Web 管理面板
 * - 账号管理（支持官方格式导入）
 * - 提示词清洗
 * - 保活机制（定时刷新 token、查询额度）
 * - 日志记录
 *
 * 配置目录: ~/.config/workbuddyaip/
 *   API/    - 账号文件
 *   logs/   - 日志
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const proxy = require('./proxy');
const accountMgr = require('./account');
const modelsMgr = require('./models');
const keepalive = require('./keepalive');
const sanitizer = require('./sanitizer');
const logger = require('./logger');

// 确保配置目录
config.ensureDirs();

const app = express();
app.use(express.json({ limit: '50mb' }));

// 请求日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/v1') && !req.path.startsWith('/health')) return;
    const duration = Date.now() - start;
    logger.debug(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// 静态文件（管理页面）
app.use(express.static(path.join(__dirname, '..', 'public')));

// ========== OpenAI 兼容 API ==========

app.get('/v1/models', async (req, res) => {
  await proxy.handleModels(req, res);
});

app.post('/v1/chat/completions', async (req, res) => {
  await proxy.handleChatCompletions(req, res);
});

app.get('/health', proxy.handleHealth);
app.get('/v1/health', proxy.handleHealth);

// ========== 管理 API ==========

// 获取所有账号
app.get('/api/accounts', (req, res) => {
  const accounts = accountMgr.loadAccounts().map(a => ({
    ...a,
    accessToken: a.accessToken ? a.accessToken.slice(0, 20) + '...' : '',
    refreshToken: a.refreshToken ? a.refreshToken.slice(0, 20) + '...' : '',
  }));
  res.json(accounts);
});

// 添加账号（手动粘贴）
app.post('/api/accounts', (req, res) => {
  const { uid, accessToken, refreshToken, realm, nickname } = req.body;
  if (!uid || !accessToken) {
    return res.status(400).json({ error: 'uid 和 accessToken 必填' });
  }
  const account = accountMgr.addAccount({ uid, accessToken, refreshToken, realm, nickname });
  res.json({ success: true, account });
});

// 从文件导入账号（官方格式）
app.post('/api/accounts/import', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename 必填' });
  const filePath = path.join(config.API_DIR, filename);
  if (!fs.existsSync(filePath)) {
    // 也检查项目 data 目录
    const altPath = path.join(__dirname, '..', 'data', filename);
    if (!fs.existsSync(altPath)) {
      return res.status(404).json({ error: '文件不存在，请放到 ~/.config/workbuddyaip/API/ 目录' });
    }
  }
  try {
    const count = accountMgr.importFromFile(filePath);
    res.json({ success: true, imported: count });
  } catch (e) {
    res.status(400).json({ error: `解析失败: ${e.message}` });
  }
});

// 重新扫描 API 目录导入
app.post('/api/accounts/rescan', (req, res) => {
  const count = accountMgr.autoImportFromApiDir();
  res.json({ success: true, imported: count, apiDir: config.API_DIR });
});

// 删除账号
app.delete('/api/accounts/:id', (req, res) => {
  accountMgr.removeAccount(req.params.id);
  res.json({ success: true });
});

// 切换账号启用状态
app.patch('/api/accounts/:id/toggle', (req, res) => {
  const accounts = accountMgr.loadAccounts();
  const idx = accounts.findIndex(a => a.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '账号不存在' });
  accounts[idx].enabled = !accounts[idx].enabled;
  accountMgr.saveAccounts(accounts);
  res.json({ success: true, account: accounts[idx] });
});

// 刷新模型缓存
app.post('/api/models/refresh', async (req, res) => {
  const account = accountMgr.getAvailableAccount();
  if (!account) return res.status(400).json({ error: '没有可用账号' });
  const models = await modelsMgr.getModels(account, true);
  res.json({ success: true, count: models.length, models });
});

// 获取模型列表（含元数据）
app.get('/api/models', async (req, res) => {
  const account = accountMgr.getAvailableAccount();
  if (!account) return res.json([]);
  const models = await modelsMgr.getModels(account);
  res.json(models);
});

// 测试账号连通性
app.post('/api/accounts/:id/test', async (req, res) => {
  const account = accountMgr.getAccountById(req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  try {
    const models = await modelsMgr.fetchModels(account);
    res.json({ success: true, modelCount: models.length, models: models.slice(0, 3) });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 手动触发保活
app.post('/api/keepalive/run', async (req, res) => {
  await keepalive.runKeepalive(accountMgr);
  res.json({ success: true });
});

// 获取保活状态
app.get('/api/keepalive/status', (req, res) => {
  res.json({
    enabled: true,
    interval: config.KEEPALIVE_INTERVAL,
    configDir: config.CONFIG_DIR,
    apiDir: config.API_DIR,
    logDir: config.LOG_DIR,
  });
});

// 提示词清洗测试
app.post('/api/sanitizer/test', (req, res) => {
  const { messages } = req.body;
  const result = sanitizer.sanitizeMessages(messages || []);
  res.json(result);
});

// 获取统计
app.get('/api/stats', (req, res) => {
  res.json(proxy.getStats());
});

// 获取配置信息
app.get('/api/config', (req, res) => {
  res.json({
    configDir: config.CONFIG_DIR,
    apiDir: config.API_DIR,
    logDir: config.LOG_DIR,
    port: config.PORT,
    host: config.HOST,
    keepaliveInterval: config.KEEPALIVE_INTERVAL,
    promptSanitize: config.PROMPT_SANITIZE_ENABLED,
  });
});

// 根路径
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const net = require('net');

/**
 * 检测端口是否被占用
 */
function isPortInUse(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    tester.once('listening', () => {
      tester.close();
      resolve(false);
    });
    tester.listen(port, host);
  });
}

/**
 * 检测 PID 文件中的进程是否还在运行
 */
function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 读取 PID 文件
 */
function readPidFile() {
  try {
    if (fs.existsSync(config.PID_FILE)) {
      const content = fs.readFileSync(config.PID_FILE, 'utf8').trim();
      const pid = parseInt(content, 10);
      if (!isNaN(pid)) return pid;
    }
  } catch (e) {}
  return null;
}

/**
 * 写入 PID 文件
 */
function writePidFile() {
  try {
    fs.writeFileSync(config.PID_FILE, String(process.pid), 'utf8');
  } catch (e) {
    logger.warn(`写入 PID 文件失败: ${e.message}`);
  }
}

/**
 * 清理 PID 文件
 */
function cleanupPidFile() {
  try {
    if (fs.existsSync(config.PID_FILE)) {
      const pid = readPidFile();
      if (pid === process.pid) {
        fs.unlinkSync(config.PID_FILE);
      }
    }
  } catch (e) {}
}

/**
 * 启动服务器（带端口检测和 PID 锁）
 */
async function startServer() {
  // 1. 检查 PID 文件
  const existingPid = readPidFile();
  if (existingPid && isPidRunning(existingPid)) {
    console.error('========================================');
    console.error('  错误: 代理已在运行中');
    console.error('========================================');
    console.error(`  PID: ${existingPid}`);
    console.error(`  管理页: http://${config.HOST}:${config.PORT}/`);
    console.error('');
    console.error('  如需停止旧进程，执行:');
    console.error(`    kill ${existingPid}`);
    console.error('    或: workbuddy-proxy-stop');
    console.error('========================================');
    process.exit(1);
  }

  // 清理 stale PID 文件
  if (existingPid && !isPidRunning(existingPid)) {
    logger.info(`清理 stale PID 文件 (PID ${existingPid} 已不存在)`);
    cleanupPidFile();
  }

  // 2. 检测端口占用
  const portInUse = await isPortInUse(config.PORT, config.HOST);
  if (portInUse) {
    console.error('========================================');
    console.error('  错误: 端口被占用');
    console.error('========================================');
    console.error(`  端口: ${config.HOST}:${config.PORT}`);
    console.error('');
    console.error('  可能原因:');
    console.error('    1. 旧的代理进程未关闭');
    console.error('    2. 其他程序占用了该端口');
    console.error('');
    console.error('  解决方案:');
    console.error('    1. 执行: workbuddy-proxy-stop  (停止旧进程)');
    console.error('    2. 或换端口启动: PORT=8789 npm start');
    console.error('========================================');
    process.exit(1);
  }

  // 3. 启动服务器
  const server = app.listen(config.PORT, config.HOST, () => {
    // 写入 PID 文件
    writePidFile();

    logger.info('========================================');
    logger.info('  WorkBuddy Proxy (Node.js) v2.0.0');
    logger.info('========================================');
    logger.info(`  管理页:   http://${config.HOST}:${config.PORT}/`);
    logger.info(`  API:      http://${config.HOST}:${config.PORT}/v1`);
    logger.info(`  配置目录: ${config.CONFIG_DIR}`);
    logger.info(`  账号目录: ${config.API_DIR}`);
    logger.info(`  日志目录: ${config.LOG_DIR}`);
    logger.info(`  PID:      ${process.pid}`);
    logger.info('  认证:     免 API Key（本地使用）');
    logger.info('========================================');

    // 自动从 API 目录导入账号
    const imported = accountMgr.autoImportFromApiDir();
    if (imported > 0) {
      logger.info(`从 API 目录自动导入 ${imported} 个账号`);
    }

    // 启动时刷新模型列表
    const accounts = accountMgr.loadAccounts();
    if (accounts.length > 0) {
      logger.info(`已加载 ${accounts.length} 个账号，正在刷新模型列表...`);
      modelsMgr.getModels(accounts[0], true).then(models => {
        logger.info(`模型列表已更新: ${models.length} 个模型`);
      }).catch(e => {
        logger.warn(`模型列表刷新失败: ${e.message}`);
      });
    } else {
      logger.info('暂无账号，请将账号文件放到 API 目录，或打开管理页添加');
    }

    // 启动保活
    keepalive.start(accountMgr);
  });

  // 长任务支持：放宽 Node 默认的各类超时限制
  //   requestTimeout   默认 300s —— 会掐断耗时较长的请求（长任务断联主因之一）
  //   headersTimeout   默认 60s
  //   keepAliveTimeout 默认 5s  —— 连接复用时的空闲阈值
  //   timeout          默认已禁用
  server.requestTimeout = 0;
  server.headersTimeout = 65 * 1000;
  server.keepAliveTimeout = 65 * 1000;
  server.timeout = 0;
  logger.info('已放宽 HTTP 超时（requestTimeout=0, headers/keepAlive=65s）以支持长任务');

  // 处理服务器错误（如启动后端口突然被占）
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`端口 ${config.PORT} 被占用，启动失败`);
    } else {
      logger.error(`服务器错误: ${err.message}`);
    }
    cleanupPidFile();
    process.exit(1);
  });

  return server;
}

// 优雅关闭
function gracefulShutdown(signal) {
  logger.info(`收到 ${signal}，正在关闭...`);
  keepalive.stop();
  cleanupPidFile();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 启动
startServer().catch((err) => {
  logger.error(`启动失败: ${err.message}`);
  process.exit(1);
});
