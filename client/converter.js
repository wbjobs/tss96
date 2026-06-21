const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function applyRuleLocal(rule, clip) {
  switch (rule.transform) {
    case "regex_replace":
      return applyRegexReplace(rule, clip);
    case "image_to_base64":
      return applyImageToBase64(rule, clip);
    case "file_to_base64":
      return applyFileToBase64(rule, clip);
    case "url_decode":
      return applyUrlDecode(rule, clip);
    default:
      return null;
  }
}

function applyRegexReplace(rule, clip) {
  if (clip.type !== "text" || !clip.content) return null;
  if (!rule.pattern) return null;
  let regex;
  try {
    regex = new RegExp(rule.pattern, "gm");
  } catch {
    return null;
  }
  const newContent = clip.content.replace(regex, rule.replacement || "");
  return {
    ...clip,
    content: newContent,
    type: rule.target_type,
    _converted: true,
    _ruleName: rule.name,
  };
}

function applyImageToBase64(rule, clip) {
  if (clip.type !== "image") return null;
  let buffer = null;
  let mimeType = "image/png";

  if (clip.localPath && fs.existsSync(clip.localPath)) {
    buffer = fs.readFileSync(clip.localPath);
    const ext = path.extname(clip.localPath).slice(1).toLowerCase();
    mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : "image/png";
  } else if (clip._buffer) {
    buffer = clip._buffer;
  }

  if (!buffer) return null;
  const dataUri = `data:${mimeType};base64,${buffer.toString("base64")}`;

  return {
    ...clip,
    type: "text",
    content: dataUri,
    file_path: null,
    localPath: null,
    _converted: true,
    _ruleName: rule.name,
  };
}

function applyFileToBase64(rule, clip) {
  if (clip.type !== "file") return null;
  if (!clip.localPath || !fs.existsSync(clip.localPath)) return null;
  const buffer = fs.readFileSync(clip.localPath);
  return {
    ...clip,
    type: "text",
    content: buffer.toString("base64"),
    file_path: null,
    localPath: null,
    _converted: true,
    _ruleName: rule.name,
  };
}

function applyUrlDecode(rule, clip) {
  if (clip.type !== "text" || !clip.content) return null;
  try {
    return {
      ...clip,
      content: decodeURIComponent(clip.content),
      _converted: true,
      _ruleName: rule.name,
    };
  } catch {
    return null;
  }
}

function applyAllMatchingRulesLocal(rules, clip) {
  const matching = rules.filter(
    (r) => r.enabled && (r.source_type === clip.type || r.source_type === "any")
  );
  matching.sort((a, b) => a.priority - b.priority);
  const results = [];
  for (const rule of matching) {
    try {
      const converted = applyRuleLocal(rule, clip);
      if (converted) results.push(converted);
    } catch {}
  }
  return results;
}

module.exports = {
  applyRuleLocal,
  applyAllMatchingRulesLocal,
};
