const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
http.createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (name === '/local-route.json') {
      const data = await fs.readFile(path.join(root,'local-data','recovered-route.json'));
      res.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
      res.end(data); return;
    }
    if (name.startsWith('/local-data/')) { res.writeHead(404); res.end(); return; }
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep) || name.split('/').some(p => p.startsWith('.')) || !types[path.extname(file)]) {
      res.writeHead(404); res.end(); return;
    }
    const data = await fs.readFile(file);
    res.writeHead(200, {'Content-Type':types[path.extname(file)], 'Cache-Control':'no-store'});
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
}).listen(4173, '127.0.0.1', () => console.log('TravelRoute: http://127.0.0.1:4173/?preview=admin'));
