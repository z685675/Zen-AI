// Explicit, offline UI fixture. Never included in the desktop bundle.
// node packages/image-canvas/e2e/preview.mjs; open http://127.0.0.1:4190
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../resources/image-canvas');
const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="768" height="512"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#dfece6"/><stop offset="1" stop-color="#90b2a8"/></linearGradient></defs><rect width="768" height="512" fill="url(#a)"/><path d="M0 390L190 180l130 140 120-200 328 310v82H0" fill="#497668"/><circle cx="620" cy="100" r="42" fill="#faebcb"/><text x="42" y="460" fill="white" font-size="26" font-family="sans-serif">ZEN-AI / OFFLINE TEST FIXTURE</text></svg>')).png().toBuffer();
const data = `data:image/png;base64,${image.toString('base64')}`;
const fixtureError = ['upstream_http_524', 'studio_upgrade_required'].includes(process.env.CANVAS_FIXTURE_ERROR) ? process.env.CANVAS_FIXTURE_ERROR : '';
const port = Number(process.env.CANVAS_FIXTURE_PORT) || 4190;
const fixture = `
const key='zen:canvas:offline-test-tasks';
const read=()=>JSON.parse(localStorage.getItem(key)||'[]');
window.imageCanvas={
 catalog:async()=>[{id:'offline-test',name:'离线测试服务商（无 API 费用）',models:[{id:'gpt-image-fixture',name:'Offline fixture',protocol:'openai'}]}],
 submit:async input=>{const records=read();const old=records.find(t=>t.id===input.id);if(old)return old;
 const task={id:input.id,providerId:input.providerId,modelId:input.modelId,prompt:input.prompt,status:${JSON.stringify(fixtureError === 'studio_upgrade_required' ? 'failed' : fixtureError ? 'uncertain' : 'completed')},error:${JSON.stringify(fixtureError)},assets:${fixtureError ? '[]' : '[input.id]'},createdAt:new Date().toISOString()};records.unshift(task);localStorage.setItem(key,JSON.stringify(records));return task;},
 task:async id=>read().find(t=>t.id===id),history:async()=>read(),asset:async()=>${JSON.stringify(data)},flush:()=>()=>{}
};`;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4190');
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fixture); return; }
  const path = resolve(root, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
  if (!path.startsWith(root + '/') && !path.startsWith(root + '\\')) { res.writeHead(403); res.end(); return; }
  try {
    let body = readFileSync(path);
    if (path.endsWith('index.html')) body = Buffer.from(body.toString().replace('</head>', '<script src="/fixture.js"></script></head>'));
    res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream'); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Offline fixture: http://127.0.0.1:${port} (no paid API requests)\n`));
