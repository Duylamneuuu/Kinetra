import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { extractExamples } from "./doc-examples.mjs";

const root = join("/repo");
const pkgReadme = join(root, "packages", "animation", "README.md");
const topLevel = join(root, "docs", "guide.md");

test("extracts a ts doc-check block with the package inferred from packages/<pkg>/", () => {
  const text = ["# Title", "", "```ts doc-check", "const a = 1;", "console.log(a);", "```", "", "after"].join("\n");
  const [example, ...rest] = extractExamples(pkgReadme, text, root);
  assert.equal(rest.length, 0);
  assert.equal(example.pkg, "animation");
  assert.equal(example.line, 3);
  assert.equal(example.code, "const a = 1;\nconsole.log(a);\n");
  assert.equal(example.file, pkgReadme);
});

test("an explicit package wins over the inferred one and is required outside packages/", () => {
  const explicit = ["```typescript doc-check=mcp-server", "export {};", "```"].join("\n");
  assert.equal(extractExamples(pkgReadme, explicit, root)[0].pkg, "mcp-server");
  assert.equal(extractExamples(topLevel, explicit, root)[0].pkg, "mcp-server");
  assert.throws(() => extractExamples(topLevel, "```ts doc-check\nexport {};\n```", root), /docs[\\/]guide\.md:1: doc-check outside packages\/ must name a package/);
  // a README directly under packages/ (no package segment) has no package to infer either
  assert.throws(() => extractExamples(join(root, "packages", "README.md"), "```ts doc-check\nx\n```", root), /must name a package/);
});

test("tilde fences, CRLF line endings and several examples per file", () => {
  const text = ["~~~ts doc-check", "one();", "~~~", "text", "```ts doc-check=input", "two();", "```"].join("\r\n");
  const examples = extractExamples(pkgReadme, text, root);
  assert.deepEqual(
    examples.map((e) => [e.pkg, e.line, e.code]),
    [
      ["animation", 1, "one();\n"],
      ["input", 5, "two();\n"],
    ],
  );
});

test("plain ts blocks and other languages are not examples", () => {
  const text = ["```ts", "not checked", "```", "```bash", "pnpm test", "```", "```json", "{}", "```"].join("\n");
  assert.deepEqual(extractExamples(pkgReadme, text, root), []);
});

test("a fence nested in a longer or different fence is content, not an example", () => {
  const text = [
    "````md",
    "```ts doc-check",
    "documented syntax only",
    "```",
    "````",
    "~~~text",
    "```ts doc-check",
    "~~~",
    "```ts doc-check",
    "real();",
    "```",
  ].join("\n");
  const examples = extractExamples(pkgReadme, text, root);
  assert.equal(examples.length, 1);
  assert.equal(examples[0].line, 9);
  assert.equal(examples[0].code, "real();\n");
});

test("a shorter or tagged line does not close a fence; a longer one does", () => {
  const text = ["````ts doc-check", "const s = `", "```ts", "`;", "```", "````"].join("\n");
  const [example] = extractExamples(pkgReadme, text, root);
  assert.equal(example.code, "const s = `\n```ts\n`;\n```\n");
});

test("fences indented up to three spaces count; four spaces is an indented code block", () => {
  const indented = ["   ```ts doc-check", "   inside();", "   ```"].join("\n");
  assert.equal(extractExamples(pkgReadme, indented, root).length, 1);
  const codeBlock = ["    ```ts doc-check", "    inside();", "    ```"].join("\n");
  assert.equal(extractExamples(pkgReadme, codeBlock, root).length, 0);
});

test("malformed doc-check tags throw instead of being skipped silently", () => {
  for (const info of ["ts doc-check=Mcp-Server", "ts doc-check=mcp_server", "ts doc-checks", "ts doc-check=", "js doc-check", "doc-check", "ts doc-check extra"]) {
    assert.throws(
      () => extractExamples(pkgReadme, `\`\`\`${info}\nx\n\`\`\``, root),
      /packages[\\/]animation[\\/]README\.md:1: malformed doc-check fence/,
      info,
    );
  }
});

test("an unterminated doc-check fence throws with its starting line", () => {
  assert.throws(() => extractExamples(pkgReadme, "intro\n\n```ts doc-check\nnever closed", root), /README\.md:3: unterminated doc-check fence/);
});

test("an unterminated ordinary fence swallows the rest of the file without error", () => {
  const text = ["```ts", "x", "```ts doc-check", "y"].join("\n");
  assert.deepEqual(extractExamples(pkgReadme, text, root), []);
});

test("inline code that mentions doc-check is ignored", () => {
  const text = "Use ```ts doc-check``` on the opening line.\n\nSee `ts doc-check` too.";
  assert.deepEqual(extractExamples(pkgReadme, text, root), []);
});

test("empty and fence-free documents yield nothing", () => {
  assert.deepEqual(extractExamples(pkgReadme, "", root), []);
  assert.deepEqual(extractExamples(pkgReadme, "just prose\nwith lines", root), []);
});
