/**
 * sanitizer.js - 提示词清洗模块
 *
 * 检测并移除其他 Agent（OpenCode、Cola Code、Claude Code、Codex CLI 等）
 * 注入的系统提示词，只保留最原始的用户意图。
 *
 * 策略：
 * 1. 检测 system/developer 消息中是否包含其他 Agent 的身份指纹
 * 2. 如果命中，替换为干净的默认 system prompt
 * 3. 同时清洗消息内容中的 Agent 标识残留
 */

const DEFAULT_CLEAN_SYSTEM = 'You are a helpful assistant.';

/**
 * 清洗模式
 *   loose  （默认，宽松）：只把「身份声明」替换成通用表述，
 *                          完整保留工具规范 / skill 说明 / 行为准则等其余内容。
 *                          —— 第三方 Agent 的系统提示里通常包含大量工具调用约定，
 *                             整条替换会让模型丢掉这些规范，进而乱吐工具标记。
 *   strict （严格）      ：命中指纹则整条 system prompt 替换为默认提示（旧行为）。
 *   off    （关闭）      ：完全不清洗。
 */
const SANITIZE_MODE = (process.env.SANITIZE_MODE || 'loose').toLowerCase();

/**
 * 身份声明替换规则（宽松模式使用）
 *
 * 只针对「我是谁」这类身份句，做定向替换；不影响工具使用规范。
 * 长句排在前面，避免被短句提前命中导致替换不完整。
 */
const IDENTITY_REWRITES = [
  // Claude Code
  { from: /You are Claude Code, Anthropic's official CLI for Claude\.?/gi, to: DEFAULT_CLEAN_SYSTEM },
  { from: /You are Claude Code, Anthropic's official CLI tool for Claude\.?/gi, to: DEFAULT_CLEAN_SYSTEM },
  { from: /You are Claude Code[^\n.]*\./gi, to: DEFAULT_CLEAN_SYSTEM },
  { from: /Claude Code, Anthropic's official CLI for Claude/gi, to: 'a helpful assistant' },
  // Codex CLI
  { from: /You are a coding agent running in the Codex CLI, a terminal-based coding assistant\./gi, to: DEFAULT_CLEAN_SYSTEM },
  { from: /You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant\./gi, to: DEFAULT_CLEAN_SYSTEM },
  // OpenCode
  { from: /You are OpenCode[,，][^\n.]*\./gi, to: DEFAULT_CLEAN_SYSTEM },
  { from: /You are OpenCode[^\n.]*\./gi, to: DEFAULT_CLEAN_SYSTEM },
  // Cline / Roo Code
  { from: /You are Cline[,，][^\n.]*\./gi, to: DEFAULT_CLEAN_SYSTEM },
  // Aider
  { from: /You are Aider[^\n.]*\./gi, to: DEFAULT_CLEAN_SYSTEM },
  // 通用「你是 AI 编程助手」身份句
  { from: /You are (?:an? )?(?:autonomous |AI )?coding agent[^\n.]*\./gi, to: DEFAULT_CLEAN_SYSTEM },
  { from: /You are an AI assistant designed to help with (?:software engineering|coding)[^\n.]*\./gi, to: DEFAULT_CLEAN_SYSTEM },
  // Cola Code
  { from: /You are Cola[^\n.]*\./gi, to: DEFAULT_CLEAN_SYSTEM },
];

/**
 * 品牌/来源标识清除规则（宽松模式使用）
 * 这些不是身份句，但是明显的第三方来源标记，直接抹掉。
 */
const BRAND_STRIP = [
  /https?:\/\/github\.com\/anthropics\/claude-code[^\s)]*/gi,
  /https?:\/\/github\.com\/sst\/opencode[^\s)]*/gi,
  /https?:\/\/github\.com\/openai\/codex[^\s)]*/gi,
  /https?:\/\/github\.com\/paul-gauthier\/aider[^\s)]*/gi,
  /To (?:give|provide) feedback, users should report the issue at[^\n]*/gi,
  /cc_entrypoint=[^\s]*/gi,
  /x-anthropic-billing-header[^\n]*/gi,
];

// 其他 Agent 的身份指纹（不区分大小写匹配）
// 命中任意一条即判定为第三方 Agent 注入的 system prompt
const AGENT_FINGERPRINTS = [
  // OpenCode
  /you are opencode/i,
  /opencode cli/i,
  /opencode's/i,
  /github\.com\/sst\/opencode/i,
  /github\.com\/opencode-ai/i,
  // Cola Code
  /cola code/i,
  /cola-code/i,
  /you are cola/i,
  // Claude Code
  /you are claude code/i,
  /claude code, anthropic/i,
  /anthropic's official cli/i,
  /github\.com\/anthropics\/claude-code/i,
  // Codex CLI
  /you are a coding agent running in the codex cli/i,
  /codex cli, a terminal-based coding assistant/i,
  /github\.com\/openai\/codex/i,
  // Aider
  /you are aider/i,
  /aider is ai pair programming/i,
  /github\.com\/paul-gauthier\/aider/i,
  // Continue
  /you are continue/i,
  /continue dev/i,
  // Cursor
  /you are cursor/i,
  /cursor's ai/i,
  // Cline / Roo Code
  /you are cline/i,
  /roo code/i,
  /cline is an ai assistant/i,
  // Windsurf
  /you are windsurf/i,
  /windsurf's ai/i,
  // Zed
  /you are zed/i,
  // 通用 Agent 身份（高置信度）
  /you are an ai coding agent/i,
  /you are a coding agent that/i,
  /you are an autonomous coding agent/i,
  /your job is to write code to accomplish the user's/i,
  /you are running inside a terminal/i,
  /you have access to a bash shell/i,
  /you are an ai pair programming assistant/i,
  // 工具链指纹
  /Main branch \(you will usually use this for PRs\)/i,
  /Default branch \(you will usually use this for PRs\)/i,
  /cc_entrypoint=/i,
  /x-anthropic-billing-header/i,
  /Sisyphus-Junior/i,
  /OhMyOpenCode/i,
];

// 内容清洗规则（替换为通用表述）
const CONTENT_REWRITES = [
  { from: /You are Claude Code, Anthropic's official CLI for Claude/gi, to: 'You are a helpful coding assistant' },
  { from: /You are Claude Code, Anthropic's official CLI tool for Claude/gi, to: 'You are a helpful coding assistant' },
  { from: /You are a coding agent running in the Codex CLI, a terminal-based coding assistant\./gi, to: 'You are a helpful coding assistant.' },
  { from: /You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant\./gi, to: 'You are a helpful coding assistant.' },
  { from: /Main branch \(you will usually use this for PRs\)/gi, to: 'Default branch' },
  { from: /Default branch \(you will usually use this for PRs\)/gi, to: 'Default branch' },
  { from: /To give feedback, users should report the issue at https:\/\/github\.com\/anthropics\/claude-code\/issues/gi, to: '' },
  { from: /To provide feedback, users should report the issue at https:\/\/github\.com\/anthropics\/claude-code\/issues/gi, to: '' },
];

/**
 * 检测文本是否包含第三方 Agent 指纹
 * @param {string} text
 * @returns {boolean}
 */
function hasAgentFingerprint(text) {
  if (!text || typeof text !== 'string') return false;
  return AGENT_FINGERPRINTS.some(pattern => pattern.test(text));
}

/**
 * 清洗单条消息的内容
 * @param {string} content
 * @returns {string}
 */
function sanitizeContent(content) {
  if (!content || typeof content !== 'string') return content;
  let result = content;
  for (const { from, to } of CONTENT_REWRITES) {
    result = result.replace(from, to);
  }
  return result;
}

/**
 * 清洗消息列表
 *
 * 策略：
 * 1. 遍历所有消息
 * 2. 如果第一条 system/developer 消息包含 Agent 指纹，替换为干净的默认 prompt
 * 3. 对所有消息内容执行内容清洗
 * 4. 统计清洗情况
 *
 * @param {Array} messages - OpenAI 格式消息列表
 * @param {Object} [opts]
 * @param {string} [opts.defaultSystem] - 替换用的默认 system prompt
 * @returns {{ messages: Array, sanitized: boolean, reason: string }}
 */
function sanitizeMessages(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, sanitized: false, reason: 'empty' };
  }

  const mode = String(opts.mode || SANITIZE_MODE).toLowerCase();
  if (mode === 'off') {
    return { messages, sanitized: false, reason: 'disabled' };
  }

  const defaultSystem = opts.defaultSystem || DEFAULT_CLEAN_SYSTEM;
  const result = [...messages];
  let sanitized = false;
  let reason = '';

  // ---- 首条 system / developer 消息 ----
  const firstMsg = result[0];
  if (firstMsg && (firstMsg.role === 'system' || firstMsg.role === 'developer')) {
    const raw = typeof firstMsg.content === 'string'
      ? firstMsg.content
      : JSON.stringify(firstMsg.content);

    if (mode === 'strict') {
      // 严格模式：命中指纹就整条替换为默认提示
      if (hasAgentFingerprint(raw)) {
        result[0] = { ...firstMsg, role: 'system', content: defaultSystem };
        sanitized = true;
        reason = 'system_prompt_replaced';
      }
    } else {
      // 宽松模式：只做定向改写，完整保留工具规范 / skill 说明 / 行为准则
      let cleaned = raw;
      for (const { from, to } of IDENTITY_REWRITES) cleaned = cleaned.replace(from, to);
      for (const re of BRAND_STRIP) cleaned = cleaned.replace(re, '');
      cleaned = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      if (cleaned !== raw) {
        result[0] = { ...firstMsg, role: 'system', content: cleaned };
        sanitized = true;
        reason = 'identity_rewritten';
      }
    }
  }

  // ---- 其余消息的内容清洗（两种模式都执行）----
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg && typeof msg.content === 'string') {
      const cleaned = sanitizeContent(msg.content);
      if (cleaned !== msg.content) {
        result[i] = { ...msg, content: cleaned };
        sanitized = true;
        if (!reason) reason = 'content_cleaned';
      }
    }
  }

  return { messages: result, sanitized, reason };
}

/**
 * 检查是否需要插入 system prompt（上游要求第一条必须是 system）
 * 如果没有 system 消息，在前面插入默认 prompt
 */
function ensureSystemPrompt(messages, defaultSystem = DEFAULT_CLEAN_SYSTEM) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [{ role: 'system', content: defaultSystem }];
  }
  if (messages[0].role !== 'system' && messages[0].role !== 'developer') {
    return [{ role: 'system', content: defaultSystem }, ...messages];
  }
  // developer 角色转为 system
  if (messages[0].role === 'developer') {
    return [{ ...messages[0], role: 'system' }, ...messages.slice(1)];
  }
  return messages;
}

module.exports = {
  sanitizeMessages,
  sanitizeContent,
  hasAgentFingerprint,
  ensureSystemPrompt,
  DEFAULT_CLEAN_SYSTEM,
  AGENT_FINGERPRINTS,
  IDENTITY_REWRITES,
  BRAND_STRIP,
  SANITIZE_MODE,
};
