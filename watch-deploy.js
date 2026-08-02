const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname);
const CLI_PATH = '/Applications/HBuilderX.app/Contents/MacOS/cli';
const PROVIDER = 'alipay';
const SPACE_ID = 'env-00jxub78ulva';
const ONLINE_URL = 'https://nhm.net.cn/';
const DEPLOYIGNORE_FILE = path.join(PROJECT_DIR, '.deployignore');

let isDeploying = false;
/** build/inject 会改写工作区文件，短暂抑制 watch 避免部署死循环 */
let suppressWatchUntil = 0;
let deployTimer = null;
const DEBOUNCE_DELAY = 1500; // 1.5秒防抖

/**
 * 读取 .deployignore，返回规范化后的模式列表
 */
function loadDeployIgnorePatterns() {
  const defaults = ['.deployignore', '.deploy-staging', '.git', '.DS_Store'];
  if (!fs.existsSync(DEPLOYIGNORE_FILE)) {
    return defaults;
  }

  const lines = fs.readFileSync(DEPLOYIGNORE_FILE, 'utf8').split(/\r?\n/);
  const patterns = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/\/+$/, '')); // 去掉末尾 /

  return [...new Set([...defaults, ...patterns])];
}

/**
 * 判断相对路径是否命中排除规则（支持简单 * 通配）
 */
function isIgnoredPath(relPath, patterns) {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');

  return patterns.some((pattern) => {
    const p = pattern.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!p) return false;

    // 整段名匹配（如 hbuilder、.agents）
    if (!p.includes('*') && segments.includes(p)) return true;

    // 前缀目录匹配（如 hbuilder/xxx）
    if (!p.includes('*') && (normalized === p || normalized.startsWith(p + '/'))) {
      return true;
    }

    // 简单通配：*.log、.env.*
    if (p.includes('*')) {
      const re = new RegExp(
        '^' + p.split('*').map(escapeRegex).join('.*') + '$'
      );
      const base = path.posix.basename(normalized);
      return re.test(normalized) || re.test(base);
    }

    return false;
  });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 将可部署文件复制到临时目录，返回该目录路径
 */
function buildStagingDir(patterns) {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mypage-deploy-'));

  function walk(absDir, relDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const rel = relDir ? path.posix.join(relDir, entry.name) : entry.name;
      if (isIgnoredPath(rel, patterns)) continue;

      const src = path.join(absDir, entry.name);
      const dest = path.join(stagingRoot, rel);

      if (entry.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        walk(src, rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
  }

  walk(PROJECT_DIR, '');
  return stagingRoot;
}

/** 递归删除临时目录 */
function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function triggerDeploy(changedFile) {
  if (isDeploying) {
    console.log(`[提示] 正在部署中，变动文件: ${changedFile} 将在下一次部署时处理...`);
    return;
  }

  clearTimeout(deployTimer);
  deployTimer = setTimeout(() => {
    runDeploy(changedFile);
  }, DEBOUNCE_DELAY);
}

function runBuildSync() {
  // 部署前注入 partials、构建 CSS 与量化 bundle
  const { spawnSync } = require('child_process');
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    shell: true,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    throw new Error(`npm run build 失败，退出码 ${r.status}`);
  }
}

function runDeploy(changedFile) {
  isDeploying = true;
  suppressWatchUntil = Date.now() + 15_000;
  const timestamp = new Date().toLocaleTimeString();
  const patterns = loadDeployIgnorePatterns();

  console.log(`\n==================================================`);
  console.log(`[${timestamp}] 检测到文件变更: ${changedFile || '手动触发'}`);
  console.log(`正在按 .deployignore 过滤后上传至 uniCloud 支付宝云 (${SPACE_ID})...`);

  let stagingDir;
  try {
    console.log('先执行 npm run build（inject + css + quant bundle）...');
    runBuildSync();
    suppressWatchUntil = Date.now() + 8_000;
    stagingDir = buildStagingDir(patterns);
  } catch (err) {
    isDeploying = false;
    suppressWatchUntil = Date.now() + 2_000;
    console.error(`[错误] 构建部署临时目录失败:`, err);
    console.log(`==================================================\n`);
    return;
  }

  const deployProcess = spawn(CLI_PATH, [
    'hosting',
    'deploy',
    '--provider', PROVIDER,
    '--space', SPACE_ID,
    '--source', stagingDir
  ]);

  deployProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(msg);
  });

  deployProcess.stderr.on('data', (data) => {
    console.error(`[错误] ${data.toString().trim()}`);
  });

  deployProcess.on('close', (code) => {
    // 无论成败都清理临时目录
    try {
      removeDir(stagingDir);
    } catch (_) {}

    isDeploying = false;
    if (code === 0) {
      console.log(`✅ 自动部署成功！（已排除 .deployignore 中的路径）`);
      console.log(`🌐 实时在线预览地址: ${ONLINE_URL}`);
    } else {
      console.log(`❌ 部署失败，退出码: ${code}`);
    }
    console.log(`==================================================\n`);
  });
}

// 支持从命令行直接执行一次单次部署 (`node watch-deploy.js --once`)
if (process.argv.includes('--once')) {
  runDeploy('手动执行单次部署');
} else {
  const patterns = loadDeployIgnorePatterns();

  console.log(`🚀 uniCloud 静态托管自动监听服务已启动！`);
  console.log(`监听目录: ${PROJECT_DIR}`);
  console.log(`排除规则: .deployignore（${patterns.length} 条）`);
  console.log(`在线效果预览地址: ${ONLINE_URL}`);
  console.log(`编辑并保存 HTML/CSS/JS 等网页文件后将自动过滤并部署上线...\n`);

  try {
    fs.watch(PROJECT_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (Date.now() < suppressWatchUntil) return;

      const rel = filename.replace(/\\/g, '/');
      // 排除项变更不触发部署（避免改脚本/文档时误上传）
      if (isIgnoredPath(rel, patterns)) return;

      triggerDeploy(filename);
    });
  } catch (err) {
    console.error('目录监听失败:', err);
  }
}
