#!/usr/bin/env node
/**
 * Run the zero-dependency checks of every plugin in catalog.json, then the
 * repository validator. Prints one line per plugin name and exits non-zero on
 * the first failure, so CI and `pnpm test` share one entry point.
 *
 *   node scripts/test.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalog = JSON.parse(readFileSync(join(ROOT, 'catalog.json'), 'utf8').replace(/^\uFEFF/u, ''))

let failed = 0
for (const entry of catalog.plugins) {
  const check = join(ROOT, 'plugins', entry.dir, 'test', 'check.mjs')
  if (!existsSync(check)) {
    console.log(`- ${entry.dir}: 没有 test/check.mjs，跳过`)
    continue
  }
  const result = spawnSync(process.execPath, [check], { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    failed += 1
    console.log(`✗ ${entry.dir}: 自检失败`)
  }
}

const validate = spawnSync(process.execPath, [join(ROOT, 'scripts', 'validate.mjs')], { cwd: ROOT, stdio: 'inherit' })
if (validate.status !== 0) failed += 1

process.exitCode = failed === 0 ? 0 : 1
