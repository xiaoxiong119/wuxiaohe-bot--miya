const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceRoot = path.resolve(__dirname, '..');
function load(name, overrides = {}, globals = {}) {
  const file = path.join(sourceRoot, name);
  const realRequire = require('node:module').createRequire(file);
  const mod = { exports: {} };
  const sandbox = { module: mod, exports: mod.exports, __dirname: path.dirname(file),
    process, console, Buffer, URL, AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name), ...globals };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return mod.exports;
}
module.exports = { load, sourceRoot };
