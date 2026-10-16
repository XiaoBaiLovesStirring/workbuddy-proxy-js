/**
 * fingerprint.js - 设备指纹稳定派生
 *
 * 基于账号 UID + salt 用 MD5 派生带连字符的 UUIDv4 形状标识。
 * 同一账号恒定、不同账号隔离，避免随机机器码导致风控。
 */
const crypto = require('crypto');

/**
 * 由 uid + salt 稳定派生一个带连字符的 UUID 形状设备标识
 * @param {string} uid - 账号 UID
 * @param {string} salt - 用途盐值 (machine / session)
 * @returns {string} UUIDv4 形状字符串
 */
function deriveId(uid, salt) {
  const seed = `${salt}:${uid || 'anonymous'}`;
  let h = crypto.createHash('md5').update(seed, 'utf8').digest('hex');
  // 设置 UUIDv4 版本位和变体位
  h = h.slice(0, 12) + '4' + h.slice(13, 16) + 'a' + h.slice(17);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * 生成 session ID（按账号派生）
 */
function sessionId(uid) {
  return deriveId(uid, 'session');
}

/**
 * 生成 32 位无连字符 hex 请求 ID（每条随机）
 */
function generateRequestId() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * 生成 RFC 9562 UUIDv7（48位毫秒时间戳 + 随机位）
 */
function uuid7() {
  const ms = BigInt(Date.now()) & ((1n << 48n) - 1n);
  const randA = BigInt(crypto.randomInt(0, 1 << 12));
  const randB = BigInt(crypto.randomBytes(8).readBigUInt64BE()) & ((1n << 62n) - 1n);
  const intVal = (ms << 80n) | (0x7n << 76n) | (randA << 64n) | (0b10n << 62n) | randB;
  // 转换为 32 位 hex
  let hex = intVal.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 生成带连字符的 conversation ID
 */
function newConversationId() {
  return uuid7();
}

/**
 * 生成 32 位无连字符 hex 消息/请求 ID
 */
function newMessageId() {
  return uuid7().replace(/-/g, '');
}

module.exports = {
  deriveId,
  sessionId,
  generateRequestId,
  uuid7,
  newConversationId,
  newMessageId,
};
