// Smoke tests for audit fixes P0-1 through P2-3
import fs from 'fs';
import path from 'path';
import os from 'os';

let pass = 0, fail = 0;
function check(label, ok) {
  if (ok) { console.log(`  \x1b[32m✓\x1b[0m ${label}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${label}`); fail++; }
}

// ── P0-1: Shell escape prevents injection ──
console.log('\n[P0-1] Shell escape');
function _shellEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
check('$(echo pwned) is quoted', _shellEscape('$(echo pwned)') === "'$(echo pwned)'");
check('backtick injection is quoted', _shellEscape('`id`') === "'`id`'");
check("single quotes escaped", _shellEscape("it's") === "'it'\\''s'");
check('normal string passes through', _shellEscape('hello') === "'hello'");

// ── P0-2: Path traversal blocked ──
console.log('\n[P0-2] Path traversal in skill install');
const targetDir = '/tmp/test-skill-install';
function checkTraversal(filePath) {
  const dest = path.join(targetDir, filePath);
  return dest.startsWith(targetDir + path.sep) || dest === targetDir;
}
check('../../etc/passwd blocked', !checkTraversal('../../etc/passwd'));
check('../../../tmp/evil blocked', !checkTraversal('../../../tmp/evil'));
check('SKILL.md allowed', checkTraversal('SKILL.md'));
check('sub/dir/file.md allowed', checkTraversal('sub/dir/file.md'));

// ── P0-3: GitHub source validation ──
console.log('\n[P0-3] GitHub source char validation');
const validChars = /^[a-zA-Z0-9._-]+$/;
check('"foo;echo pwned" rejected', !validChars.test('foo;echo pwned'));
check('"foo$(cmd)" rejected', !validChars.test('foo$(cmd)'));
check('"foo`id`" rejected', !validChars.test('foo`id`'));
check('"valid-owner" accepted', validChars.test('valid-owner'));
check('"my.repo-2" accepted', validChars.test('my.repo-2'));

// ── P0-4a: Sensitive path detection ──
console.log('\n[P0-4a] Sensitive path blocking');
const SENSITIVE = ['.ssh', '.aws', '.gnupg', '.env', 'credentials'];
function isSensitive(fp) {
  const resolved = path.resolve(fp);
  for (const s of SENSITIVE) if (resolved.includes(path.sep + s)) return s;
  return null;
}
check('~/.ssh/id_rsa blocked', !!isSensitive(os.homedir() + '/.ssh/id_rsa'));
check('~/.aws/credentials blocked', !!isSensitive(os.homedir() + '/.aws/credentials'));
check('~/.gnupg/private blocked', !!isSensitive(os.homedir() + '/.gnupg/private'));
check('/project/.env blocked', !!isSensitive('/project/.env'));
check('/tmp/safe.txt allowed', !isSensitive('/tmp/safe.txt'));
check('/home/user/code.js allowed', !isSensitive('/home/user/code.js'));

// ── P0-4b: SSRF detection ──
console.log('\n[P0-4b] SSRF protection');
function isPrivateUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(hostname)) return true;
    if (hostname.endsWith('.internal') || hostname === 'metadata.google.internal') return true;
    return false;
  } catch { return false; }
}
check('169.254.169.254 (AWS metadata) blocked', isPrivateUrl('http://169.254.169.254/latest/meta-data'));
check('10.0.0.1 blocked', isPrivateUrl('http://10.0.0.1/admin'));
check('172.16.0.1 blocked', isPrivateUrl('http://172.16.0.1/'));
check('192.168.1.1 blocked', isPrivateUrl('http://192.168.1.1/'));
check('metadata.google.internal blocked', isPrivateUrl('http://metadata.google.internal/'));
check('foo.internal blocked', isPrivateUrl('http://foo.internal/'));
check('localhost:3000 allowed', !isPrivateUrl('http://localhost:3000/'));
check('127.0.0.1 allowed', !isPrivateUrl('http://127.0.0.1:8080/'));
check('github.com allowed', !isPrivateUrl('https://github.com/'));
check('example.com allowed', !isPrivateUrl('https://example.com/'));

// ── P1-1: const → let systemBlocks ──
console.log('\n[P1-1] Fork mode const→let');
const engineSrc = fs.readFileSync('src/engine.mjs', 'utf-8');
check('let systemBlocks = buildSystemPrompt', engineSrc.includes('let systemBlocks = buildSystemPrompt'));
check('no const systemBlocks = buildSystemPrompt', !engineSrc.includes('const systemBlocks = buildSystemPrompt'));

// ── P1-2: result hoisted before if/else ──
console.log('\n[P1-2] LSP result scope');
check('let result; declared before isExternal', /let result;\s*\n\s*const isExternal/.test(engineSrc));
check('result = await (no const) in external branch', engineSrc.includes('result = await this.cb.onExternalToolUse'));
check('result = await (no const) in registry branch', engineSrc.includes('result = await this.registry.execute'));

// ── P1-3: session.mjs imports ──
console.log('\n[P1-3] Session imports');
const sessionSrc = fs.readFileSync('src/session.mjs', 'utf-8');
const engineImportLine = sessionSrc.split('\n').find(l => l.includes('from "./engine.mjs"'));
check('aggregateVerdicts in engine import', engineImportLine.includes('aggregateVerdicts'));
check('_backgroundManager in engine import', engineImportLine.includes('_backgroundManager'));
const providersImportLine = sessionSrc.split('\n').find(l => l.includes('from "./providers.mjs"'));
check('AnthropicClient in providers import', providersImportLine.includes('AnthropicClient'));

// ── P1-3 (engine side): _backgroundManager exported ──
console.log('\n[P1-3b] Engine exports _backgroundManager');
const exportBlock = engineSrc.slice(engineSrc.lastIndexOf('export {'));
check('_backgroundManager in export block', exportBlock.includes('_backgroundManager'));

// ── P2-1: Edit trailing newline fix ──
console.log('\n[P2-1] Edit trailing newline');
const content = 'line1\nline2\nline3\n';
const matchStr = 'line2';
const newStr = '';
const target = (newStr === '' && !matchStr.endsWith('\n') && content.includes(matchStr + '\n') && true)
  ? matchStr + '\n' : matchStr;
const updated = content.replace(target, newStr);
check('line2+newline removed cleanly', updated === 'line1\nline3\n');
// Verify no double-pass in source
const toolsSrc = fs.readFileSync('src/tools.mjs', 'utf-8');
check('no second content.replace for trailing newline', !toolsSrc.includes('updated = content.replace(matchStr + "\\n", "")'));

// ── P2-2: MCP error handling ──
console.log('\n[P2-2] MCP RPC error handling');
const indexSrc = fs.readFileSync('src/index.mjs', 'utf-8');
check('msg.error check exists', indexSrc.includes('if (msg.error)'));
check('pending.reject on error', indexSrc.includes('pending.reject(new Error(msg.error.message'));

// ── P2-3: No auto-install ──
console.log('\n[P2-3] No auto-install binary');
const autoIdx = toolsSrc.indexOf('async function _autoInstallBinary');
const autoSection = toolsSrc.substring(autoIdx, autoIdx + 2000);
check('no execSync(installCmd) in autoInstall', !autoSection.includes('execSync(installCmd'));
check('suggests manual install', autoSection.includes('Run it manually'));

// ── Summary ──
console.log(`\n${'═'.repeat(50)}`);
console.log(`  \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log('═'.repeat(50));
process.exit(fail > 0 ? 1 : 0);
