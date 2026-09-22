// 通用工具：时间、编号、摘要与稳定序列化。
const crypto = require("node:crypto");

function now() {
  return new Date().toISOString(); // ISO 8601，带偏移量（UTC 以 Z 表示）
}

function randomHex(bytes = 12) {
  return crypto.randomBytes(bytes).toString("hex");
}

function newId(prefix) {
  return `${prefix}-${randomHex(8)}`;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sha256Json(value) {
  return sha256(stableStringify(value));
}

function randomToken() {
  return `brt_${randomHex(24)}`;
}

// 递归按键排序后序列化，保证哈希输入在任何机器上一致。
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = { now, newId, randomHex, sha256, sha256Json, randomToken, stableStringify, parseJsonArray, parseJsonObject };
