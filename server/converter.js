const fs = require("fs");
const path = require("path");

async function applyRule(rule, clip, dataDir, httpUrl) {
  switch (rule.transform) {
    case "regex_replace":
      return applyRegexReplace(rule, clip);
    case "image_to_base64":
      return applyImageToBase64(rule, clip, dataDir);
    case "file_to_base64":
      return applyFileToBase64(rule, clip, dataDir);
    case "url_decode":
      return applyUrlDecode(rule, clip);
    default:
      throw new Error(`Unknown transform: ${rule.transform}`);
  }
}

function applyRegexReplace(rule, clip) {
  if (clip.type !== "text" || !clip.content) return null;
  if (!rule.pattern) return null;

  let regex;
  try {
    regex = new RegExp(rule.pattern, "gm");
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${e.message}`);
  }

  const replacement = rule.replacement || "";
  const newContent = clip.content.replace(regex, replacement);

  return {
    ...clip,
    id: clip.id + "-converted",
    content: newContent,
    target_type: rule.target_type,
    type: rule.target_type,
    _converted: true,
    _ruleName: rule.name,
  };
}

function applyImageToBase64(rule, clip, dataDir) {
  if (clip.type !== "image") return null;
  if (!clip.file_path) return null;

  const filePath = path.join(dataDir, clip.file_path.replace(/^\//, ""));
  if (!fs.existsSync(filePath)) return null;

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeType = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : "image/png";
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString("base64");
  const dataUri = `data:${mimeType};base64,${base64}`;

  return {
    ...clip,
    id: clip.id + "-converted",
    type: "text",
    target_type: "text",
    content: dataUri,
    file_path: null,
    _converted: true,
    _ruleName: rule.name,
  };
}

function applyFileToBase64(rule, clip, dataDir) {
  if (clip.type !== "file") return null;
  if (!clip.file_path) return null;

  const filePath = path.join(dataDir, clip.file_path.replace(/^\//, ""));
  if (!fs.existsSync(filePath)) return null;

  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString("base64");

  return {
    ...clip,
    id: clip.id + "-converted",
    type: "text",
    target_type: "text",
    content: base64,
    file_path: null,
    _converted: true,
    _ruleName: rule.name,
  };
}

function applyUrlDecode(rule, clip) {
  if (clip.type !== "text" || !clip.content) return null;

  try {
    const decoded = decodeURIComponent(clip.content);
    return {
      ...clip,
      id: clip.id + "-converted",
      content: decoded,
      type: rule.target_type,
      _converted: true,
      _ruleName: rule.name,
    };
  } catch {
    return null;
  }
}

async function applyAllMatchingRules(rules, clip, dataDir, httpUrl) {
  const matching = rules.filter(
    (r) => r.enabled && (r.source_type === clip.type || r.source_type === "any")
  );
  matching.sort((a, b) => a.priority - b.priority);

  const results = [];
  for (const rule of matching) {
    try {
      const converted = await applyRule(rule, clip, dataDir, httpUrl);
      if (converted) {
        results.push(converted);
      }
    } catch {
    }
  }
  return results;
}

module.exports = {
  applyRule,
  applyAllMatchingRules,
};
