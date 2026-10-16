/**
 * logger.js - 日志模块
 *
 * 同时输出到控制台和文件（按日期分割）。
 * 日志目录: ~/.config/workbuddyaip/logs/
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

let logStream = null;
let currentDate = '';

function getLogFile() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  if (dateStr !== currentDate || !logStream) {
    if (logStream) {
      try { logStream.end(); } catch (e) {}
    }
    currentDate = dateStr;
    const logFile = path.join(config.LOG_DIR, `proxy-${dateStr}.log`);
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  }
  return logStream;
}

function format(level, msg) {
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').slice(0, 23);
  return `[${ts}] [${level}] ${msg}`;
}

function write(level, msg) {
  const line = format(level, msg);
  // 控制台
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
  // 文件
  try {
    const stream = getLogFile();
    stream.write(line + '\n');
  } catch (e) {
    // 忽略文件写入错误
  }
}

module.exports = {
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('WARN', msg),
  error: (msg) => write('ERROR', msg),
  debug: (msg) => {
    if (process.env.DEBUG) write('DEBUG', msg);
  },
  // 请求日志（单独文件）
  request: (method, url, status, duration, accountId) => {
    try {
      const reqLog = path.join(config.LOG_DIR, 'requests.log');
      const now = new Date().toISOString();
      fs.appendFileSync(reqLog, `${now} ${method} ${url} ${status} ${duration}ms ${accountId || '-'}\n`);
    } catch (e) {}
  },
};
