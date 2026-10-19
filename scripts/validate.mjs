#!/usr/bin/env node
/**
 * Validate every plugin in this collection against the bundle rules from
 * https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish
 * plus the display-resource checklist, and optionally regenerate the generated
 * files (root README table, plugins/README.md). Zero dependencies, so it runs on
 * any machine with Node and no install step.
 *
 *   node scripts/validate.mjs            # check
 *   node scripts/validate.mjs --write    # check, then rewrite generated files
 *   node scripts/validate.mjs --list     # print bundle directories, one per line
 *
 * Exit code 1 on any error, so CI can gate on it.
 */
import { existsSync } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = join(ROOT, 'plugins')
const CATALOG = join(ROOT, 'catalog.json')
const ICON_LIMIT = 256 * 1024
const ICON_TYPES = {
  '.svg': ['image/svg+xml', /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/iu],
  '.png': ['image/png', null],
  '.jpg': ['image/jpeg', null],
  '.jpeg': ['image/jpeg', null],
  '.webp': ['image/webp', null],
}

const args = new Set(process.argv.slice(2))
const WRITE = args.has('--write')
const LIST = args.has('--list')

/** @type {{level: 'error' | 'warn', file: string, message: string}[]} */
const findings = []
const error = (file, message) => findings.push({ level: 'error', file, message })
const warn = (file, message) => findings.push({ level: 'warn', file, message })

const rel = (absolute) => relative(ROOT, absolute).split(sep).join('/')

async function readJson(path) {
  const text = await readFile(path, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) error(rel(path), '文件以 UTF-8 BOM 开头；请保存为无 BOM 的 UTF-8')
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch (cause) {
    error(rel(path), `不是合法 JSON：${cause.message}`)
    return undefined
  }
}

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    let directory = entry.isDirectory()
    let file = entry.isFile()
    // Windows symlinks/junctions report neither, so decide with stat().
    if (!directory && !file) {
      const info = await stat(full).catch(() => undefined)
      directory = info?.isDirectory() ?? false
      file = !directory
    }
    if (directory) out.push(...await walk(full))
    else if (file) out.push(full)
  }
  return out
}

/** Expand one `files` entry (npm semantics) into repo-relative paths. */
async function expand(pluginDir, patterns) {
  const files = await walk(pluginDir)
  const matched = new Set()
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') {
      error(rel(join(pluginDir, 'package.json')), 'files[] 含非字符串或空条目')
      continue
    }
    if (!/[*?]/u.test(pattern)) {
      if (!existsSync(join(pluginDir, pattern))) {
        error(rel(join(pluginDir, 'package.json')), `files[] 中的 '${pattern}' 不存在`)
      } else {
        matched.add(pattern.replace(/\\/gu, '/'))
      }
      continue
    }
    // A pattern with no '/' matches any basename; one with '/' is anchored.
    const source = pattern.replace(/\\/gu, '/').replace(/[.+^${}()|[\]\\]/gu, '\\$&')
      .replace(/\*\*/gu, '\u0000').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]')
      .replace(/\u0000/gu, '.*')
    const anchored = pattern.includes('/')
    const re = new RegExp(anchored ? `^${source}$` : `(^|/)${source}$`, 'u')
    for (const file of files) {
      const path = relative(pluginDir, file).split(sep).join('/')
      if (re.test(path)) matched.add(path)
    }
  }
  return matched
}

/** Check a source file references only thing the package actually declares. */
function parseImports(source) {
  // Strip comments and string literals that are not import targets, so prose in
  // JSDoc or a description string can never look like a dependency.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
  const specifiers = new Set()
  const patterns = [
    /\bfrom\s*'([^'\n]+)'/gu,
    /\bfrom\s*"([^"\n]+)"/gu,
    /\bimport\s*\(\s*'([^'\n]+)'\s*\)/gu,
    /\bimport\s*\(\s*"([^"\n]+)"\s*\)/gu,
    /\brequire\s*\(\s*'([^'\n]+)'\s*\)/gu,
    /\brequire\s*\(\s*"([^"\n]+)"\s*\)/gu,
    /^\s*import\s+'([^'\n]+)'/gmu,
    /^\s*import\s+"([^"\n]+)"/gmu,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1].trim()
      if (specifier !== '' && !/[\s,;`]/u.test(specifier)) specifiers.add(specifier)
    }
  }
  return specifiers
}

/** @returns {Promise<Array<{dir: string, absoluteDir: string, manifest: any}>>} */
async function discover() {
  const catalogJson = await readJson(CATALOG)
  const declared = new Map()
  if (catalogJson !== undefined) {
    if (catalogJson.schemaVersion !== 1) error('catalog.json', `schemaVersion 必须是 1，实际是 ${catalogJson.schemaVersion}`)
    const seen = new Set()
    for (const [index, entry] of (catalogJson.plugins ?? []).entries()) {
      const dir = entry?.dir
      if (typeof dir !== 'string' || dir === '') {
        error('catalog.json', `plugins[${index}] 缺少 dir`)
        continue
      }
      if (dir !== dir.trim() || dir.includes('/') || dir.includes('\\') || dir === '.' || dir === '..') {
        error('catalog.json', `plugins[${index}].dir 必须是不含路径分隔符的目录名：${JSON.stringify(dir)}`)
      }
      if (seen.has(dir)) error('catalog.json', `plugins 中重复登记：${dir}`)
      seen.add(dir)
      declared.set(dir, entry)
    }
  }

  const onDisk = (await readdir(PLUGINS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)

  for (const dir of onDisk) {
    if (!declared.has(dir)) error('catalog.json', `plugins/${dir} 存在但未登记；在 catalog.json 的 plugins 中加入 {"dir": "${dir}"}`)
    if (!existsSync(join(PLUGINS_DIR, dir, 'package.json'))) {
      error(`plugins/${dir}`, '缺少 package.json，不是插件目录')
    }
  }
  for (const dir of declared.keys()) {
    if (!onDisk.includes(dir)) error('catalog.json', `登记的 plugins/${dir} 不存在`)
  }

  const ordered = [...declared.keys()].filter((dir) => onDisk.includes(dir))
  const bundles = []
  for (const dir of ordered) {
    const absoluteDir = join(PLUGINS_DIR, dir)
    const manifest = await readJson(join(absoluteDir, 'package.json'))
    if (manifest === undefined) continue
    const entry = declared.get(dir)
    if (entry?.status !== undefined && entry.status !== 'active' && entry.status !== 'retired') {
      error('catalog.json', `plugins/${dir}.status 只能是 active 或 retired，实际是 ${JSON.stringify(entry.status)}`)
    }
    bundles.push({ dir, absoluteDir, manifest, catalog: entry, retired: entry?.status === 'retired' })
  }
  /** @type {{dsh?: string} | undefined} */
  bundles.defaults = catalogJson?.defaults
  return { bundles, defaults: catalogJson?.defaults }
}

async function checkPlugin({ dir, absoluteDir, manifest }) {
  const pkg = rel(join(absoluteDir, 'package.json'))
  const called = (message) => error(pkg, message)

  // --- identity -------------------------------------------------------------
  if (typeof manifest.name !== 'string' || manifest.name === '') called('必须声明 name')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    called('必须声明 SemVer 格式的 version')
  }
  if (manifest.type !== 'module') called('type 必须是 "module"：入口按 ESM 加载')
  if (typeof manifest.description !== 'string' || manifest.description.trim() === '') called('应写一句英文 description')

  // --- bundle manifest ------------------------------------------------------
  if (manifest.dsh?.bundle === undefined) {
    called('缺少 dsh.bundle：dsh 只会把它当普通依赖安装，永远不会启用')
    return
  }
  const patchSpec = manifest.dsh.bundle.patch
  const patchFiles = Array.isArray(patchSpec) ? patchSpec : [patchSpec]
  if (patchFiles.length === 0 || patchFiles.some((entry) => typeof entry !== 'string' || !entry.startsWith('./'))) {
    called('dsh.bundle.patch 必须是 "./<file>" 或按顺序应用的 "./<file>" 数组')
  }
  const exported = manifest.exports ?? {}
  for (const [subpath, target] of Object.entries(exported)) {
    // A subpath maps either to a path string or to a conditions object, as
    // dsh-pet and other published client plugins do: { default: './client.js' }.
    const resolved = typeof target === 'string'
      ? target
      : (target !== null && typeof target === 'object' ? target.default : undefined)
    if (typeof resolved !== 'string') {
      called(`exports["${subpath}"] 必须是路径字符串或带 default 的条件对象`)
      continue
    }
    if (!subpath.includes('*') && !existsSync(join(absoluteDir, resolved))) {
      called(`exports["${subpath}"] 指向不存在的文件：${resolved}`)
    }
  }
  for (const patchFile of patchFiles) {
    const absolute = join(absoluteDir, patchFile)
    if (!existsSync(absolute)) {
      called(`dsh.bundle.patch 指向不存在的文件：${patchFile}`)
      continue
    }
    if (exported[`./${patchFile.replace(/^\.\//u, '')}`] !== patchFile) {
      called(`patch 文件应通过 exports 暴露："./${patchFile.replace(/^\.\//u, '')}": "${patchFile}"`)
    }
    await checkPatch(rel(absolute), absolute, manifest.name)
  }

  // --- engine compatibility -------------------------------------------------
  const engines = { ...(bundlesDefaultEngines ?? {}), ...(manifest.engines ?? {}) }
  if (typeof engines.dsh !== 'string' || !/^[<>=~^*\s\d.xX|-]+$/u.test(engines.dsh)) {
    called('应在 engines.dsh 声明支持的 dsh SemVer 范围，例如 ">=0.2.0 <0.3.0"')
  }

  // --- peer/dev dependency pairing ------------------------------------------
  const peers = manifest.peerDependencies ?? {}
  const dev = manifest.devDependencies ?? {}
  for (const name of Object.keys(peers)) {
    if (dev[name] === undefined) called(`peerDependencies 中的 ${name} 也应写进 devDependencies（供本地类型检查与独立测试）`)
  }

  // --- entry module ---------------------------------------------------------
  const entry = manifest.module ?? manifest.main ?? './index.js'
  const entryPath = join(absoluteDir, entry)
  const exportedEntry = exported['.']?.replace(/^\.\//u, '')
  if (exportedEntry !== undefined && exportedEntry !== entry.replace(/^\.\//u, '')) {
    called(`exports["."] 与 main 不一致：${exported['.']} ≠ ${entry}`)
  }
  if (!exported['.']) called('缺少 exports["."]：dsh 按入口子路径解析插件模块')
  if (!existsSync(entryPath)) {
    called(`入口 ${entry} 不存在`)
  } else {
    await checkEntry(rel(entryPath), entryPath, manifest)
    await checkConfig(rel(entryPath))
  }

  // --- display resources ----------------------------------------------------
  let locales = []
  for (const file of await walk(absoluteDir)) {
    const path = relative(absoluteDir, file).split(sep).join('/')
    if (/^locale\/[^/]+\.json$/u.test(path)) locales.push(path)
  }
  locales = locales.sort()
  if (!locales.includes('locale/en.json')) {
    called('缺少 locale/en.json：插件管理器通过 <包名>/locale/*.json 读取 meta.title 与 meta.description')
  }
  for (const locale of locales) {
    if (exported['./locale/*.json'] !== './locale/*.json') called('应导出 "./locale/*.json": "./locale/*.json"')
    const json = await readJson(join(absoluteDir, locale))
    if (json === undefined) continue
    // dsh reads exactly `meta.title` and `meta.description` (textOf(meta?.title)).
    // Any other key is ignored silently, so a wrong key shows the package name.
    for (const key of ['title', 'description']) {
      const value = json.meta?.[key]
      if (typeof value !== 'string' || value.trim() === '') {
        error(`plugins/${dir}/${locale}`, `meta.${key} 必须是非空字符串；插件管理器只读取 meta.title 与 meta.description`)
      }
    }
    for (const key of Object.keys(json.meta ?? {})) {
      if (key !== 'title' && key !== 'description') {
        warn(`plugins/${dir}/${locale}`, `meta.${key} 不会显示：插件管理器只读取 meta.title 与 meta.description`)
      }
    }
    for (const key of Object.keys(json)) {
      if (key !== 'meta') warn(`plugins/${dir}/${locale}`, `未知的顶层键 "${key}"（只允许 meta）`)
    }
  }

  const iconFromManifest = typeof manifest.icon === 'string' ? manifest.icon : undefined
  const iconSubpath = exported['./icon']
  if (iconFromManifest !== undefined) {
    const iconPath = join(absoluteDir, iconFromManifest)
    if (!iconPath.startsWith(absoluteDir)) called(`icon 必须在包内：${iconFromManifest}`)
    await checkIcon(rel(iconPath), iconPath)
  } else if (typeof iconSubpath === 'string') {
    const iconPath = join(absoluteDir, iconSubpath)
    if (!iconPath.startsWith(absoluteDir)) called('./icon 必须在包内')
    await checkIcon(rel(iconPath), iconPath)
  } else {
    called('缺少图标：声明 package.json 的 icon 或导出 "./icon"')
  }

  // --- files[] --------------------------------------------------------------
  const packed = await expand(absoluteDir, manifest.files ?? [])
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    called('缺少 files[]：打包（pnpm pack / 发布）时入口、patch、locale、图标都会丢失')
  }
  const required = [
    entry.replace(/^\.\//u, ''),
    ...patchFiles.map((file) => file.replace(/^\.\//u, '')),
    'locale/en.json',
    ...(iconFromManifest !== undefined
      ? [iconFromManifest.replace(/^\.\//u, '')]
      : typeof iconSubpath === 'string'
        ? [iconSubpath.replace(/^\.\//u, '')]
        : []),
  ]
  for (const file of required) {
    if (existsSync(join(absoluteDir, file)) && !packed.has(file)) called(`files[] 没有包含 ${file}`)
  }
  // Local modules the entry imports must ship too: a split implementation (such
  // as a cue module beside index.js) would otherwise disappear from `pnpm pack`.
  if (existsSync(join(absoluteDir, entry))) {
    const source = await readFile(join(absoluteDir, entry), 'utf8')
    for (const specifier of parseImports(source)) {
      if (!specifier.startsWith('./')) continue
      const target = relative(absoluteDir, resolve(absoluteDir, specifier)).split(sep).join('/')
      if (existsSync(join(absoluteDir, target)) && !packed.has(target)) {
        called(`入口 import 了 ${specifier}，但 files[] 没有包含 ${target}`)
      }
    }
  }
  for (const file of packed) {
    if (!existsSync(join(absoluteDir, file))) called(`files[] 匹配到不存在的 ${file}`)
  }
}

/** Patches are checked against the bundle's own package name. */
let bundlesDefaultEngines
async function checkPatch(patchRel, patchAbsolute, packageName) {
  const text = await readFile(patchAbsolute, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) error(patchRel, '文件以 UTF-8 BOM 开头')
  if (/\r\n/u.test(text)) warn(patchRel, '使用 CRLF 换行；建议 .gitattributes 固定为 LF')
  const body = text.replace(/^\uFEFF/u, '').replace(/^#.*$/gmu, '')
  if (!/^\s*-\s*(insert|id)\s*:/mu.test(body)) {
    error(patchRel, '必须是 patch 条目数组：顶层 "- insert: [...]" 或 "- id: <行 id>"')
  }
  const rowNames = [...body.matchAll(/^\s*(?:-\s*)?name:\s*['"]?([^'"\s#]+)['"]?\s*$/gmu)].map((match) => match[1])
  if (rowNames.length === 0) error(patchRel, '没有找到插件行 name')
  for (const name of rowNames) {
    const isLocalFile = name.startsWith('file:') || name.startsWith('.') || /^[A-Za-z]:[\\/]/u.test(name)
    if (isLocalFile) {
      error(patchRel, `行 name 不能是路径（${name}）：组合包必须按包名引用，否则移动仓库后失效`)
    } else if (name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/') === packageName) {
      continue
    } else {
      error(patchRel, `行 name "${name}" 不是本包的包名 ${packageName}；跨包引用请另建组合包`)
    }
  }
  if (!/^\s*-\s*insert:/mu.test(body)) {
    warn(patchRel, '没有 insert 条目：请确认这是有意的覆盖层')
  }
}

/**
 * A row `Config` must be a Standard Schema validator. A bare JSON Schema makes
 * dsh look up a validator package that a directory-linked bundle cannot
 * resolve, so the entry fails to activate with "Cannot read properties of
 * undefined (reading 'validate')".
 */
async function checkConfig(entryRel) {
  const module = await import(pathToFileURL(join(ROOT, entryRel)).href).catch(() => undefined)
  if (module === undefined) return
  const config = module.Config
  if (config === undefined) return
  const standard = config['~standard']
  if (standard === undefined) {
    error(entryRel, 'Config 必须是 Standard Schema 校验器（带 "~standard"）；纯 JSON Schema 会让条目激活失败')
    return
  }
  if (standard.version !== 1 || typeof standard.validate !== 'function') {
    error(entryRel, 'Config["~standard"] 需要 version: 1 与 validate(value) 函数')
    return
  }
  const empty = standard.validate({})
  if (empty?.issues !== undefined) {
    error(entryRel, `Config 对空配置校验失败：${JSON.stringify(empty.issues)}`)
  }
  const unknown = standard.validate({ __unknownKey__: true })
  if (unknown?.issues === undefined) {
    error(entryRel, 'Config 应拒绝未知键（否则用户写错键名不会报错）')
  }
}

async function checkIcon(iconRel, iconAbsolute) {
  if (!existsSync(iconAbsolute)) return error(iconRel, '图标文件不存在')
  const info = await stat(iconAbsolute)
  if (info.size > ICON_LIMIT) error(iconRel, `图标 ${info.size} 字节，超过 256 KiB 上限`)
  const extension = iconAbsolute.slice(iconAbsolute.lastIndexOf('.')).toLowerCase()
  const known = ICON_TYPES[extension]
  if (known === undefined) return error(iconRel, `不支持的图标格式 ${extension}；只允许 SVG、PNG、JPEG、WebP`)
  const bytes = await readFile(iconAbsolute)
  const magic = {
    '.png': [0x89, 0x50, 0x4e, 0x47],
    '.jpg': [0xff, 0xd8, 0xff],
    '.jpeg': [0xff, 0xd8, 0xff],
    '.webp': null,
  }[extension]
  if (magic !== null && magic !== undefined && magic.some((byte, index) => bytes[index] !== byte)) {
    error(iconRel, `字节不是有效的 ${known[0]}`)
  }
  if (extension === '.webp' && !(bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP')) {
    error(iconRel, '字节不是有效的 image/webp')
  }
  if (extension === '.svg' && !known[1].test(bytes.toString('utf8'))) {
    error(iconRel, '字节不是有效的 SVG 文档')
  }
}

async function checkEntry(entryRel, entryAbsolute, manifest) {
  const source = await readFile(entryAbsolute, 'utf8')
  if (source.charCodeAt(0) === 0xfeff) error(entryRel, '文件以 UTF-8 BOM 开头')
  if (!/\bexport\s+function\s+apply\s*\(|\bexport\s*\{[^}]*\bapply\b|\bexport\s+default\s+class\b/u.test(source)) {
    error(entryRel, '未导出 apply(ctx, config)，也不是默认导出的服务类')
  }
  if (/\bexport\s+default\b/u.test(source) && /\bexport\s+function\s+apply\b/u.test(source)) {
    error(entryRel, '同时导出了默认类与 apply；只允许一种导出形式')
  }
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])

  for (const specifier of parseImports(source)) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const target = resolve(dirname(entryAbsolute), specifier)
      if (!existsSync(target)) error(entryRel, `相对导入不存在：${specifier}`)
      continue
    }
    if (specifier.startsWith('/') || /^[A-Za-z]:/u.test(specifier) || specifier.startsWith('file:')) {
      error(entryRel, `入口不能使用绝对路径导入：${specifier}`)
      continue
    }
    if (specifier.startsWith('node:')) continue
    if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/.*)?$/iu.test(specifier)) {
      error(entryRel, `无法识别的导入说明符：${JSON.stringify(specifier)}`)
      continue
    }
    const scoped = specifier.startsWith('@')
    const packageName = specifier.split('/').slice(0, scoped ? 2 : 1).join('/')
    if (!declared.has(packageName)) {
      error(entryRel, `导入了未声明的包 ${packageName}：workspace 插件不能解析 dsh 自带包，请改走 ctx 服务`)
    }
  }
  try {
    await import(pathToFileURL(entryAbsolute).href)
  } catch (cause) {
    error(entryRel, `无法作为 ESM 加载：${cause.message}`)
  }
}

function renderRows(bundles) {
  // Retired plugins stay in the tree for reference but are not offered.
  return Promise.all(bundles.filter((bundle) => bundle.retired !== true).map(async ({ dir, manifest, catalog }) => {
    const locale = await readJson(join(PLUGINS_DIR, dir, 'locale', 'zh.json')).catch(() => undefined)
    const title = locale?.meta?.title ?? dir
    const tools = await toolsOf(dir, manifest)
    const tags = Array.isArray(catalog?.tags) ? catalog.tags.map((tag) => String(tag).toLowerCase()) : []
    const platforms = tags.includes('windows') ? 'Windows' : '任意'
    return `| [${title}](./plugins/${dir}) | \`${manifest.name}\` | ${manifest.version} | ${tools} | ${platforms} |`
  }))
}

async function toolsOf(dir, manifest) {
  const entry = join(PLUGINS_DIR, dir, (manifest.module ?? manifest.main ?? './index.js').replace(/^\.\//u, ''))
  const source = await readFile(entry, 'utf8')
  const tools = [...source.matchAll(/(?:^|[\s,{])name:\s*'([a-z][a-z0-9_]*)'\s*,\s*\n\s*description:/gmu)]
    .map((match) => match[1])
    .concat([...source.matchAll(/define\(\s*\n?\s*'([a-z][a-z0-9_]*)'/gu)].map((match) => match[1]))
  const commands = [...source.matchAll(/ctx\.commands\.register\(\{\s*\n\s*name:\s*'([^']+)'/gu)].map((match) => match[1])
  const unique = [...new Set([...tools, ...commands])]
  const rendered = unique.map((name) => {
    if (commands.includes(name)) return `\`/${name}\` 命令`
    return `\`${name}\``
  })
  return rendered.length === 0 ? '—' : rendered.join('、')
}

/**
 * Documentation hygiene: every relative Markdown link under docs/ must resolve,
 * and the experiences index must list every chapter beside it. Broken links and
 * unlisted chapters are silent in a browser, so they are checked here.
 */
async function checkDocs() {
  const docsDir = join(ROOT, 'docs')
  if (!existsSync(docsDir)) return
  for (const dir of await readdir(docsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const chapterDir = join(docsDir, dir.name)
    const files = (await readdir(chapterDir)).filter((name) => name.endsWith('.md')).sort()
    const indexPath = join(chapterDir, 'README.md')
    if (!existsSync(indexPath)) {
      error(`docs/${dir.name}`, '缺少 README.md 索引')
      continue
    }
    const index = await readFile(indexPath, 'utf8')
    for (const name of files) {
      if (name === 'README.md') continue
      if (!index.includes(`./${name}`)) {
        error(`docs/${dir.name}/README.md`, `没有链接到章节 ${name}`)
      }
    }
    for (const name of files) {
      const text = await readFile(join(chapterDir, name), 'utf8')
      for (const match of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/gu)) {
        const target = resolve(chapterDir, match[1])
        if (!existsSync(target)) {
          error(`docs/${dir.name}/${name}`, `相对链接不存在：${match[1]}`)
        }
      }
    }
  }
}

async function main() {
  if (!existsSync(CATALOG)) {
    console.error('catalog.json 不存在')
    process.exit(1)
  }
  const { bundles, defaults } = await discover()
  bundlesDefaultEngines = defaults?.engines
  if (LIST) {
    // The install list mirrors the README table: retired plugins are excluded.
    for (const bundle of bundles.filter((entry) => entry.retired !== true)) console.log(bundle.dir)
    return 0
  }
  for (const bundle of bundles) await checkPlugin(bundle)
  await checkDocs()

  // --- generated documentation ---------------------------------------------
  const rows = await renderRows(bundles)
  const table = [
    '<!-- 本表格由 scripts/validate.mjs --write 生成，请勿手改。 -->',
    '| 插件 | 包名 | 版本 | 提供的工具 / 命令 | 平台 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
  const rootReadme = join(ROOT, 'README.md')
  const pluginsReadme = join(PLUGINS_DIR, 'README.md')
  const generated = [
    [rootReadme, '<!-- BEGIN PLUGINS -->', '<!-- END PLUGINS -->', `\n${table}\n`],
    [pluginsReadme, '<!-- BEGIN PLUGINS -->', '<!-- END PLUGINS -->', `\n${table}\n`],
  ]
  for (const [path, begin, end, block] of generated) {
    if (!existsSync(path)) {
      error(rel(path), '文件不存在')
      continue
    }
    const text = await readFile(path, 'utf8')
    const start = text.indexOf(begin)
    const stop = text.indexOf(end)
    if (start === -1 || stop === -1 || stop < start) {
      error(rel(path), `缺少生成区标记 ${begin} … ${end}`)
      continue
    }
    const desired = `${text.slice(0, start + begin.length)}${block}${text.slice(stop)}`
    if (desired !== text) {
      if (WRITE) await writeFile(path, desired, 'utf8')
      else error(rel(path), '插件表格已过期；运行 node scripts/validate.mjs --write 重新生成')
    }
  }

  const errors = findings.filter((finding) => finding.level === 'error')
  const warnings = findings.filter((finding) => finding.level === 'warn')
  for (const finding of [...errors, ...warnings]) {
    console.log(`${finding.level === 'error' ? '✗' : '!'} ${finding.file}: ${finding.message}`)
  }
  const toolNames = []
  for (const bundle of bundles) {
    const names = await toolsOf(bundle.dir, bundle.manifest)
    toolNames.push(`${bundle.dir}(${names})`)
  }
  console.log(`\n检查 ${bundles.length} 个插件：${errors.length} 个错误，${warnings.length} 个警告`)
  if (errors.length === 0) console.log(`  ${toolNames.join('  ')}`)
  return errors.length === 0 ? 0 : 1
}

process.exitCode = await main().catch((cause) => {
  console.error(cause)
  return 1
})
