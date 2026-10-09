// Markdown parsing for scripts/check-doc-examples.mjs, split out so it can be
// unit-tested without compiling anything.
//
// An example is a fenced block whose info string is `ts doc-check` or
// `ts doc-check=<package>` (`typescript` is accepted as the language, and
// `~~~` fences work like backtick fences). Fences follow CommonMark: the
// opening run is 3+ identical characters, indented at most three spaces, and
// the block ends at a line of the same character that is at least as long and
// carries no info string. Anything inside another fenced block (for example a
// ```md block documenting the syntax) is content, never an example.
//
// A fence whose info string mentions `doc-check` but does not match the syntax
// exactly (`doc-check=Mcp_Server`, `ts doc-checks`, `js doc-check`) throws:
// silently skipping it would let that example drift from the code unnoticed.

import { relative, sep } from "node:path";

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INFO = /^(?:ts|typescript)\s+doc-check(?:=([a-z0-9-]+))?$/;

function isClosing(line, opener) {
  const trimmed = line.replace(/^ {0,3}/, "").trimEnd();
  const char = opener[0];
  if (trimmed.length < opener.length) return false;
  for (const c of trimmed) if (c !== char) return false;
  return true;
}

export function extractExamples(file, text, root) {
  const rel = relative(root, file);
  const lines = text.split(/\r?\n/);
  const examples = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i]);
    if (!open) continue;
    const [, fence, rawInfo] = open;
    const info = rawInfo.trim();
    if (fence[0] === "`" && info.includes("`")) continue; // inline code, not a fence
    let end = i + 1;
    while (end < lines.length && !isClosing(lines[end], fence)) end++;
    const terminated = end < lines.length;
    if (!info.includes("doc-check")) {
      i = terminated ? end : lines.length;
      continue;
    }
    const match = INFO.exec(info);
    if (!match) {
      throw new Error(`${rel}:${i + 1}: malformed doc-check fence "${info}" (expected \`\`\`ts doc-check or \`\`\`ts doc-check=<package>)`);
    }
    if (!terminated) throw new Error(`${rel}:${i + 1}: unterminated doc-check fence`);
    let pkg = match[1];
    if (!pkg) {
      const parts = rel.split(sep);
      if (parts[0] === "packages" && parts.length > 2) pkg = parts[1];
    }
    if (!pkg) {
      throw new Error(`${rel}:${i + 1}: doc-check outside packages/ must name a package (\`\`\`ts doc-check=<package>)`);
    }
    examples.push({ file, line: i + 1, pkg, code: lines.slice(i + 1, end).join("\n") + "\n" });
    i = end;
  }
  return examples;
}
