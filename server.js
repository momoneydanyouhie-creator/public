const express = require('express'), http = require('http');
const { WebSocketServer } = require('ws');
const MAX = 50;
const app = express();
app.use(express.static('public'));
app.get('/health', (_, r) => r.send('ok'));
app.get('/status', (_, r) => r.json({ count: clients.size, max: MAX, locked }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map(); // id -> client (Map keeps join order = oldest first)
let ownerId = null, locked = false, nextId = 1;

const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const all = m => clients.forEach(c => send(c.ws, m));
const roster = () => ({
  t: 'roster', owner: ownerId, locked,
  users: [...clients.values()].map(c => ({ id: c.id, name: c.name, mic: c.mic, cam: c.cam, micLocked: c.micLocked, camLocked: c.camLocked }))
});
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

function admin(m) {
  const target = clients.get(m.id);
  switch (m.t) {
    case 'kick': if (target && target.id !== ownerId) { send(target.ws, { t: 'kicked' }); setTimeout(() => target.ws.close(), 100); } break;
    case 'lock': if (target && target.id !== ownerId) { target[m.what + 'Locked'] = !!m.on; if (m.on) target[m.what] = false; } break;
    case 'lockall': clients.forEach(c => { if (c.id !== ownerId) { c[m.what + 'Locked'] = !!m.on; if (m.on) c[m.what] = false; } }); break;
    case 'rename': if (target) target.name = clean(m.name, 20) || target.name; break;
    case 'makeowner': if (target) { ownerId = target.id; all({ t: 'ann', text: `${target.name} is now the owner 👑` }); } break;
    case 'room': locked = !!m.on; break;
    case 'fx': all({ t: 'fx', n: clean(m.n, 12), a: clean(m.a, 8) }); return;
    case 'announce': all({ t: 'ann', text: clean(m.text, 140) }); return;
    case 'clear': all({ t: 'clear' }); return;
  }
  all(roster());
}

wss.on('connection', ws => {
  let c = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!c) {
      if (m.t !== 'join') return;
      if (clients.size === 0) { locked = false; ownerId = null; }
      if (clients.size >= MAX) return send(ws, { t: 'denied', why: 'The call is full (50/50).' });
      if (locked) return send(ws, { t: 'denied', why: 'The owner locked the call.' });
      c = { id: nextId++, ws, name: clean(m.name, 20) || 'Player', mic: true, cam: true, micLocked: false, camLocked: false };
      const peers = [...clients.keys()];
      if (ownerId === null) ownerId = c.id;
      clients.set(c.id, c);
      send(ws, { t: 'welcome', id: c.id, peers });
      all(roster());
      return;
    }
    switch (m.t) {
      case 'sig': { const to = clients.get(m.to); if (to) send(to.ws, { t: 'sig', from: c.id, d: m.d }); break; }
      case 'state':
        if (!c.micLocked) c.mic = !!m.mic;
        if (!c.camLocked) c.cam = !!m.cam;
        all(roster()); break;
      case 'chat': { const text = clean(m.text, 300); if (text) all({ t: 'chat', name: c.name, id: c.id, text, sys: !!m.sys && false }); break; }
      case 'react': all({ t: 'react', e: clean(m.e, 4) }); break;
      default: if (c.id === ownerId) admin(m);
    }
  });
  ws.on('close', () => {
    if (!c) return;
    clients.delete(c.id);
    if (c.id === ownerId) {
      ownerId = clients.size ? clients.keys().next().value : null;
      if (ownerId) all({ t: 'ann', text: `${clients.get(ownerId).name} is now the owner 👑` });
    }
    all(roster());
  });
});

setInterval(() => wss.clients.forEach(w => { if (!w.isAlive) return w.terminate(); w.isAlive = false; w.ping(); }), 30000);
server.listen(process.env.PORT || 3000, () => console.log('Big Call running'));
