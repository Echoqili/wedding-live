/**
 * push-via-api.js —— 用 GitHub REST API（api.github.com）完成 git push
 *
 * 背景：github.com:443 直连被网络环境阻断，但 api.github.com 可达。
 * 本脚本通过 git objects API 手动复刻 push：
 *   blobs → trees（带 base_tree）→ commits（父=远程HEAD）→ update ref
 *
 * 用法：node push-via-api.js <owner> <repo> <branch> "<commit message>"
 * 环境要求：gh 已登录（token 在系统 keyring，本脚本通过 gh api 命令调用）
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [owner, repo, branch, message] = process.argv.slice(2);
if (!owner || !repo || !branch || !message) {
  console.error('用法: node push-via-api.js <owner> <repo> <branch> "<message>"');
  process.exit(1);
}

const FILES = [
  'README.md', 'ROADMAP.md', 'WEDDING-RUNBOOK.md', 'deploy.bat', 'deploy.sh',
  'css/screen.css', 'js/screen.js', 'js/store.js', 'js/ui.js', 'js/host.js',
  'screen.html', 'server.js',
  'tools/verify/smoke-m2.js', 'tools/verify/smoke-passcode.js',
  'tools/push-via-api.js'
];

function gh(args, opts) {
  return execSync('gh api ' + args, Object.assign({
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024
  }, opts || {}));
}
function ghJson(args, opts) {
  return JSON.parse(gh(args, opts));
}

// 1. 当前远程 HEAD 与其 tree
const headRef = ghJson(`repos/${owner}/${repo}/git/ref/heads/${branch}`).object.sha;
const headCommit = ghJson(`repos/${owner}/${repo}/git/commits/${headRef}`);
const baseTree = headCommit.tree.sha;
console.log(`[1/5] 远程 HEAD=${headRef.slice(0, 7)}  base_tree=${baseTree.slice(0, 7)}`);

// 2. 为每个文件创建 blob
const entries = FILES.map((f) => {
  const content = fs.readFileSync(f, 'utf8');
  const body = JSON.stringify({ content, encoding: 'utf-8' });
  const bodyFile = path.join(require('os').tmpdir(), 'wb_blob_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.json');
  fs.writeFileSync(bodyFile, body);
  let sha;
  try {
    sha = JSON.parse(gh(`-X POST repos/${owner}/${repo}/git/blobs --input "${bodyFile}"`)).sha;
  } finally {
    fs.unlinkSync(bodyFile);
  }
  console.log(`[2/5] blob ${f} -> ${sha.slice(0, 7)}`);
  return { path: f, mode: '100644', type: 'blob', sha };
});

// 3. 构建 tree（继承 base_tree）
const treeBody = JSON.stringify({ base_tree: baseTree, tree: entries });
const treeFile = path.join(require('os').tmpdir(), 'wb_tree_' + Date.now() + '.json');
fs.writeFileSync(treeFile, treeBody);
const newTree = JSON.parse(gh(`-X POST repos/${owner}/${repo}/git/trees --input "${treeFile}"`)).sha;
fs.unlinkSync(treeFile);
console.log(`[3/5] 新 tree=${newTree.slice(0, 7)}`);

// 4. 创建 commit
const commitBody = JSON.stringify({ message, tree: newTree, parents: [headRef] });
const commitFile = path.join(require('os').tmpdir(), 'wb_commit_' + Date.now() + '.json');
fs.writeFileSync(commitFile, commitBody);
const newCommit = JSON.parse(gh(`-X POST repos/${owner}/${repo}/git/commits --input "${commitFile}"`)).sha;
fs.unlinkSync(commitFile);
console.log(`[4/5] 新 commit=${newCommit.slice(0, 7)}`);

// 5. 更新分支引用（fast-forward，force 必须是 JSON 布尔，用 --input 传 body）
const refBody = JSON.stringify({ sha: newCommit, force: false });
const refFile = path.join(require('os').tmpdir(), 'wb_ref_' + Date.now() + '.json');
fs.writeFileSync(refFile, refBody);
gh(`-X PATCH repos/${owner}/${repo}/git/refs/heads/${branch} --input "${refFile}"`);
fs.unlinkSync(refFile);
console.log(`[5/5] ${branch} -> ${newCommit.slice(0, 7)} 推送完成`);
console.log(`提交信息: ${message.split('\n')[0]}`);
