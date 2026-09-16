'use strict';
// Review harness only: fixture-local I/O; no sockets or command execution.
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const within = value => {
  if (typeof value === 'number') return value >= 0 && value <= 2;
  const name = value instanceof URL ? require('node:url').fileURLToPath(value) : String(value);
  const resolved = path.resolve(name);
  return resolved === root || resolved.startsWith(root + path.sep);
};
const absent = () => Object.assign(new Error('IQA guard: external fixture absent'), { code: 'ENOENT' });
for (const name of ['readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'accessSync', 'realpathSync']) {
  const original = fs[name];
  fs[name] = function (file, ...args) { if (!within(file)) throw absent(); return original.call(this, file, ...args); };
}
const exists = fs.existsSync;
fs.existsSync = file => within(file) && exists(file);
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'truncateSync', 'chmodSync', 'chownSync', 'utimesSync', 'openSync', 'createWriteStream']) {
  const original = fs[name];
  fs[name] = function (file, ...args) { if (!within(file)) throw new Error(`IQA guard: forbidden ${name}`); return original.call(this, file, ...args); };
}
for (const name of ['renameSync', 'copyFileSync', 'linkSync', 'symlinkSync']) {
  const original = fs[name];
  fs[name] = function (a, b, ...args) { if (!within(a) || !within(b)) throw new Error(`IQA guard: forbidden ${name}`); return original.call(this, a, b, ...args); };
}
for (const name of ['readFile', 'stat', 'lstat', 'readdir', 'access', 'realpath']) {
  const original = fs[name];
  fs[name] = function (file, ...args) { if (!within(file)) return process.nextTick(() => args.at(-1)(absent())); return original.call(this, file, ...args); };
  const promiseOriginal = fs.promises[name];
  fs.promises[name] = async function (file, ...args) { if (!within(file)) throw absent(); return promiseOriginal.call(this, file, ...args); };
}
const denied = () => { throw new Error('IQA guard: network/process/mutation disabled'); };
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate', 'chmod', 'chown', 'utimes', 'open', 'rename', 'copyFile', 'link', 'symlink']) {
  fs[name] = denied;
  if (fs.promises[name]) fs.promises[name] = denied;
}
for (const [module, names] of [
  ['node:http', ['request', 'get', 'createServer']],
  ['node:https', ['request', 'get', 'createServer']],
  ['node:net', ['connect', 'createConnection', 'createServer']],
  ['node:tls', ['connect', 'createServer']],
  ['node:dgram', ['createSocket']],
  ['node:child_process', ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']],
]) for (const name of names) require(module)[name] = denied;
require('node:net').Socket.prototype.connect = denied;
globalThis.fetch = denied;
