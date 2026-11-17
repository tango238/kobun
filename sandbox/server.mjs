// サンドボックス内デーモン: Worker (ハーネス) からの /exec /read /write 等を受けるだけの薄い実装。
// Pi Durable の SandboxExecutionEnv からも使われる。
// クレデンシャルはこの中には置かない。外部通信は環境変数の HTTPS_PROXY (egress) 経由のみ。
import http from 'node:http';
import { exec } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const WORKSPACE = '/workspace';

async function listRecursive(dir, base) {
  const entries = [];
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    const rel = path.relative(base, full);
    entries.push({ path: rel, isDirectory: item.isDirectory() });
    if (item.isDirectory()) {
      entries.push(...(await listRecursive(full, base)));
    }
  }
  return entries;
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    try {
      const data = body ? JSON.parse(body) : {};
      if (req.url === '/exec') {
        exec(
          data.cmd,
          { cwd: WORKSPACE, timeout: 60_000, maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => {
            send(200, {
              stdout,
              stderr: stderr || '',
              code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            });
          },
        );
      } else if (req.url === '/read') {
        const content = await readFile(path.join(WORKSPACE, data.path), 'utf8');
        send(200, { content });
      } else if (req.url === '/read-base64') {
        const buf = await readFile(path.join(WORKSPACE, data.path));
        send(200, { base64: buf.toString('base64') });
      } else if (req.url === '/write') {
        const p = path.join(WORKSPACE, data.path);
        await mkdir(path.dirname(p), { recursive: true });
        await writeFile(p, data.content, 'utf8');
        send(200, { ok: true });
      } else if (req.url === '/list') {
        const target = path.join(WORKSPACE, data.path ?? '.');
        if (data.recursive) {
          send(200, { entries: await listRecursive(target, WORKSPACE) });
        } else {
          const items = await readdir(target, { withFileTypes: true });
          send(200, {
            entries: items.map((i) => ({
              path: i.name,
              isDirectory: i.isDirectory(),
            })),
          });
        }
      } else if (req.url === '/health') {
        send(200, { ok: true });
      } else {
        send(404, { error: 'not found' });
      }
    } catch (e) {
      send(500, { error: String(e) });
    }
  });
});

server.listen(7000, () => console.log('sandbox daemon on :7000'));
