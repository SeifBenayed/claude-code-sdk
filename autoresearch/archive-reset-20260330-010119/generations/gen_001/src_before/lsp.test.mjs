import test from "node:test";
import assert from "node:assert/strict";

import { formatDiagnostics } from "./lsp.mjs";

const fixturePath = "/tmp/example.ts";

const duplicateDiagnostic = {
  severity: 1,
  message: "Cannot find name 'foo'.",
  source: "tsserver",
  code: 2304,
  range: {
    start: { line: 2, character: 4 },
    end: { line: 2, character: 7 },
  },
};

test("formatDiagnostics deduplicates identical diagnostics from the same file", () => {
  const output = formatDiagnostics([
    duplicateDiagnostic,
    { ...duplicateDiagnostic },
  ], fixturePath);

  assert.equal((output.match(/Cannot find name 'foo'\./g) || []).length, 1);
  assert.match(output, /errors="1" warnings="0"/);
});

test("formatDiagnostics keeps distinct diagnostics", () => {
  const output = formatDiagnostics([
    duplicateDiagnostic,
    {
      ...duplicateDiagnostic,
      message: "'bar' is declared but its value is never read.",
      severity: 2,
      code: 6133,
      range: {
        start: { line: 5, character: 1 },
        end: { line: 5, character: 4 },
      },
    },
  ], fixturePath);

  assert.match(output, /Cannot find name 'foo'\./);
  assert.match(output, /'bar' is declared but its value is never read\./);
  assert.match(output, /errors="1" warnings="1"/);
});
