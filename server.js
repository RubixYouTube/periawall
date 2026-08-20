const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const VERSION = '0.1.18';

const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
            if (err) { res.writeHead(500); return res.end('Error loading'); }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocket.Server({ server });

const ownerPass = Math.random().toString(36).substring(2, 11);
console.log("\x1b[31m%s\x1b[0m", "Do not forget!");
console.log("\x1b[31m%s\x1b[0m", `Owner Password: ${ownerPass}`);
console.log("\x1b[33m%s\x1b[0m", `Periawall v${VERSION} — type /help in the console for commands.`);

let db = { walls: { Main: { grid: {}, protectedTiles: [], protectedAreas: [], chat: [] } }, accounts: {}, muted: {}, canvasMuted: {}, userIps: {}, globalChat: [], colorEnabled: true };
try {
    const data = fs.readFileSync('db.json', 'utf8');
    db = JSON.parse(data);
    if (!db.walls) db.walls = { Main: { grid: {}, protectedTiles: [], protectedAreas: [], chat: [] } };
    if (!db.walls.Main) db.walls.Main = { grid: {}, protectedTiles: [], protectedAreas: [], chat: [] };
    if (!db.walls.Main.chat) db.walls.Main.chat = [];
    if (!db.walls.Main.protectedAreas) db.walls.Main.protectedAreas = [];
    if (!db.accounts) db.accounts = {};
    if (!db.muted) db.muted = {};
    if (!db.canvasMuted) db.canvasMuted = {};
    if (!db.userIps) db.userIps = {};
    if (!db.globalChat) db.globalChat = [];
    if (typeof db.colorEnabled !== 'boolean') db.colorEnabled = true;
} catch (e) {}

db.accounts.RubixYT = { password: ownerPass, isOwner: true, isAdmin: false, isMember: false, p: '#ff8a3d', s: '#f4f1de' };

let dbDirty = false;
setInterval(() => { if (dbDirty) { dbDirty = false; fs.writeFile('db.json', JSON.stringify(db), () => {}); } }, 2000);

function normalizeWall(name) { const lower = name.toLowerCase().trim(); if (lower === '' || lower === 'main' || lower.includes('main wall')) return 'Main'; return name.trim(); }
function getTileKey(col, row) { return `${Math.floor((col+4000)/20)},${Math.floor((row+4000)/10)}`; }

const activeUsers = new Set();

function broadcast(msg) {
    const data = JSON.stringify(msg);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isCanvasMuted(ip) {
    const m = db.canvasMuted[ip];
    if (!m) return false;
    if (m.permanent) return true;
    if (m.expires && Date.now() < m.expires) return true;
    return false;
}

function findClientByUsername(username) {
    for (const c of wss.clients) { if (c.readyState === WebSocket.OPEN && c.username === username) return c; }
    return null;
}

wss.on('connection', (ws, req) => {
    ws.wallId = 'Main';
    ws.username = null;
    ws.ip = getClientIp(req);

    ws.on('message', (message) => {
        let msg;
        try { msg = JSON.parse(message.toString()); } catch (e) { return; }

        if (msg.type === 'ping') { ws.send(JSON.stringify({type: 'pong', id: 'system', target: msg.id, t: msg.t})); return; }

        if (msg.type === 'login') {
            ws.wallId = normalizeWall(msg.wallId);
            if (activeUsers.has(msg.u)) { ws.send(JSON.stringify({ type: 'login-result', id: 'system', target: msg.id, success: false, err: 'Username is already taken.' })); return; }
            if (msg.u === 'RubixYT') {
                if (msg.p !== ownerPass) { ws.send(JSON.stringify({ type: 'login-result', id: 'system', target: msg.id, success: false, err: 'Wrong owner password.' })); return; }
            } else {
                if (db.accounts[msg.u]) {
                    if (db.accounts[msg.u].password !== msg.p) { ws.send(JSON.stringify({ type: 'login-result', id: 'system', target: msg.id, success: false, err: 'Wrong password.' })); return; }
                    db.accounts[msg.u].p = msg.pColor || db.accounts[msg.u].p || '#ff8a3d';
                    db.accounts[msg.u].s = msg.sColor || db.accounts[msg.u].s || '#f4f1de';
                    db.accounts[msg.u].theme = msg.theme || db.accounts[msg.u].theme || 'orange';
                    db.accounts[msg.u].tier = msg.tier || db.accounts[msg.u].tier || 1;
                    dbDirty = true;
                } else { db.accounts[msg.u] = { password: msg.p, isOwner: false, isAdmin: false, isMember: false, p: msg.pColor || '#ff8a3d', s: msg.sColor || '#f4f1de', theme: msg.theme || 'orange', tier: msg.tier || 1 }; dbDirty = true; }
            }
            if (ws.username) activeUsers.delete(ws.username);
            ws.username = msg.u; activeUsers.add(msg.u);
            db.userIps[msg.u] = ws.ip; dbDirty = true;
            const acc = db.accounts[msg.u];
            ws.send(JSON.stringify({ type: 'login-result', id: 'system', target: msg.id, success: true, isOwner: acc.isOwner, isAdmin: acc.isAdmin, isMember: acc.isMember, username: msg.u, p: acc.p, s: acc.s, theme: acc.theme || 'orange', tier: acc.tier || 1 }));
            if (isCanvasMuted(ws.ip)) {
                const m = db.canvasMuted[ws.ip];
                const minutes = m.permanent ? 0 : Math.max(0, Math.round((m.expires - Date.now()) / 60000));
                ws.send(JSON.stringify({ type: 'canvasmute', id: 'system', targetUser: msg.u, minutes, expires: m.permanent ? 0 : (m.expires || 0), permanent: !!m.permanent }));
            }
            return;
        }

        if (msg.type === 'join') {
            const norm = normalizeWall(msg.wallId); ws.wallId = norm;
            if (!db.walls[norm]) { db.walls[norm] = { grid: {}, protectedTiles: [], protectedAreas: [], chat: [] }; dbDirty = true; }
            if (!db.walls[norm].chat) db.walls[norm].chat = [];
            if (!db.walls[norm].protectedAreas) db.walls[norm].protectedAreas = [];
            if (norm === 'walls') { ws.send(JSON.stringify({ type: 'wall-list', id: 'system', target: msg.id, walls: Object.keys(db.walls) })); return; }
            wss.clients.forEach((client) => { if (client !== ws && client.readyState === WebSocket.OPEN && client.wallId === ws.wallId) client.send(JSON.stringify({ type: 'hello', id: 'system', target: msg.id })); });
            return;
        }

        if (msg.type === 'hello') {
            if (ws.wallId === 'walls') return;
            const wallData = db.walls[ws.wallId] || { grid: {}, protectedTiles: [], protectedAreas: [], chat: [] };
            const cells = [];
            for (const [key, c] of Object.entries(wallData.grid)) { const ci = key.indexOf(','); cells.push([+key.slice(0,ci), +key.slice(ci+1), c.ch, c.color, c.t, c.b, c.i, c.u, c.s, c.o, c.ol]); }
            ws.send(JSON.stringify({type:'sync', id:'system', target: msg.id, cells, protectedTiles: wallData.protectedTiles, protectedAreas: wallData.protectedAreas, t: Date.now()}));
            ws.send(JSON.stringify({type:'chat-history', id:'system', target: msg.id, scope: 'wall', messages: wallData.chat || []}));
            ws.send(JSON.stringify({type:'chat-history', id:'system', target: msg.id, scope: 'global', messages: db.globalChat || []}));
            ws.send(JSON.stringify({type:'color-mode', id:'system', target: msg.id, enabled: db.colorEnabled !== false}));
            wss.clients.forEach((client) => { if (client !== ws && client.readyState === WebSocket.OPEN && client.wallId === ws.wallId) client.send(message.toString()); });
            return;
        }

        if (msg.type === 'nick') {
            if (activeUsers.has(msg.newId)) return ws.send(JSON.stringify({ type: 'system-msg', id: 'system', target: msg.oldId, text: 'Nickname already taken.' }));
            activeUsers.delete(msg.oldId); activeUsers.add(msg.newId);
            if (ws.username === msg.oldId) ws.username = msg.newId;
            if (db.userIps[msg.oldId]) { db.userIps[msg.newId] = db.userIps[msg.oldId]; delete db.userIps[msg.oldId]; dbDirty = true; }
            broadcast({type: 'nick', id: msg.id, oldId: msg.oldId, newId: msg.newId});
            return;
        }

        if (msg.type === 'promote') {
            const ownerData = db.accounts[msg.id];
            if (ownerData && ownerData.isOwner) {
                if (db.accounts[msg.targetUser]) {
                    if (msg.role === 'admin') db.accounts[msg.targetUser].isAdmin = true;
                    if (msg.role === 'member') db.accounts[msg.targetUser].isMember = true;
                    dbDirty = true;
                }
                broadcast({type: 'promote', id: msg.id, targetUser: msg.targetUser, role: msg.role});
            }
            return;
        }

        if (msg.type === 'demote') {
            const ownerData = db.accounts[msg.id];
            if (ownerData && ownerData.isOwner) {
                if (db.accounts[msg.targetUser]) {
                    db.accounts[msg.targetUser].isAdmin = false;
                    db.accounts[msg.targetUser].isMember = false;
                    dbDirty = true;
                }
                broadcast({type: 'demote', id: msg.id, targetUser: msg.targetUser});
            }
            return;
        }

        // Save appearance (theme + colors) to the user's account without re-logging in
        if (msg.type === 'save-profile') {
            const accSP = db.accounts[msg.id];
            if (accSP) {
                if (msg.theme) accSP.theme = msg.theme;
                if (msg.p) accSP.p = msg.p;
                if (msg.s) accSP.s = msg.s;
                if (msg.tier) accSP.tier = msg.tier;
                dbDirty = true;
                ws.send(JSON.stringify({type:'save-profile-result', id:'system', target: msg.id, success: true, theme: accSP.theme, p: accSP.p, s: accSP.s, tier: accSP.tier}));
            }
            return;
        }

        // Owner/admin toggle color rendering for everyone
        if (msg.type === 'color-mode') {
            const userData = db.accounts[msg.id];
            if (userData && (userData.isOwner || userData.isAdmin)) {
                db.colorEnabled = !!msg.enabled; dbDirty = true;
                broadcast({type: 'color-mode', enabled: db.colorEnabled});
            }
            return;
        }

        if (msg.type === 'mute') {
            const userData = db.accounts[msg.id];
            if (userData && (userData.isOwner || userData.isAdmin)) {
                const expires = Date.now() + (msg.minutes * 60000); db.muted[msg.targetUser] = expires; dbDirty = true;
                broadcast({type: 'mute', id: msg.id, targetUser: msg.targetUser, expires});
            }
            return;
        }

        if (msg.type === 'unmute') {
            const userData = db.accounts[msg.id];
            if (userData && (userData.isOwner || userData.isAdmin)) {
                if (db.muted[msg.targetUser]) { delete db.muted[msg.targetUser]; dbDirty = true; }
                broadcast({type: 'unmute', id: msg.id, targetUser: msg.targetUser});
            }
            return;
        }

        if (msg.type === 'announce') {
            const ownerData = db.accounts[msg.id];
            if (ownerData && ownerData.isOwner) { broadcast({type: 'announce', id: msg.id, text: msg.text}); }
            return;
        }

        if (msg.type === 'canvasmute') {
            const userData = db.accounts[msg.id];
            if (!userData || !(userData.isOwner || userData.isAdmin)) return;
            const minutes = parseInt(msg.minutes) || 0;
            if (minutes <= 0 && !userData.isOwner) { ws.send(JSON.stringify({ type: 'system-msg', id: 'system', target: msg.id, text: 'Only the owner can permanently canvas-mute.' })); return; }
            const ip = db.userIps[msg.targetUser];
            if (ip) {
                db.canvasMuted[ip] = minutes > 0 ? { expires: Date.now() + (minutes * 60000) } : { permanent: true };
                dbDirty = true;
            }
            broadcast({type: 'canvasmute', id: msg.id, targetUser: msg.targetUser, minutes, expires: minutes > 0 ? Date.now() + (minutes * 60000) : 0, permanent: minutes <= 0});
            return;
        }

        if (msg.type === 'canvasunmute') {
            const userData = db.accounts[msg.id];
            if (!userData || !(userData.isOwner || userData.isAdmin)) return;
            const ip = db.userIps[msg.targetUser];
            if (ip && db.canvasMuted[ip]) { delete db.canvasMuted[ip]; dbDirty = true; }
            broadcast({type: 'canvasunmute', id: msg.id, targetUser: msg.targetUser});
            return;
        }

        if (msg.type === 'kick') {
            const userData = db.accounts[msg.id];
            if (!userData || !(userData.isOwner || userData.isAdmin)) return;
            const client = findClientByUsername(msg.targetUser);
            if (client) {
                client.send(JSON.stringify({type: 'kicked', id: 'system', targetUser: msg.targetUser, by: msg.id}));
                const c = client;
                setTimeout(() => { if (c.readyState === WebSocket.OPEN) c.close(); }, 400);
            }
            return;
        }

        if (msg.type === 'members-request') { const _ml = []; for (const _u of Object.keys(db.accounts)) { const _a = db.accounts[_u]; const _r = _a.isOwner ? 'owner' : _a.isAdmin ? 'admin' : _a.isMember ? 'member' : null; if (_r) _ml.push({ u: _u, role: _r, online: activeUsers.has(_u) }); } ws.send(JSON.stringify({type:'members-response', id:'system', target: msg.id, members: _ml})); return; }

        if (msg.type === 'users-request') {
            const userData = db.accounts[msg.id];
            if (!userData || !(userData.isOwner || userData.isAdmin)) return;
            const users = Object.keys(db.accounts).map(u => ({ u, isOwner: !!db.accounts[u].isOwner, isAdmin: !!db.accounts[u].isAdmin, isMember: !!db.accounts[u].isMember, online: activeUsers.has(u), canvasMuted: !!(db.userIps[u] && isCanvasMuted(db.userIps[u])) }));
            ws.send(JSON.stringify({type: 'users-response', id: 'system', target: msg.id, users}));
            return;
        }

        if (msg.type === 'purge') {
            const ownerData = db.accounts[msg.id];
            if (!ownerData || !ownerData.isOwner) return;
            const t = msg.targetUser;
            if (!t || t === 'RubixYT') { ws.send(JSON.stringify({type: 'system-msg', id: 'system', target: msg.id, text: 'Cannot purge that account.'})); return; }
            const existed = !!db.accounts[t];
            if (existed) delete db.accounts[t];
            if (db.userIps[t]) delete db.userIps[t];
            if (db.muted[t]) delete db.muted[t];
            delete db.walls['~' + t];
            dbDirty = true;
            const client = findClientByUsername(t);
            if (client) {
                client.send(JSON.stringify({type: 'purged', id: 'system', targetUser: t, by: msg.id}));
                const c = client;
                setTimeout(() => { if (c.readyState === WebSocket.OPEN) c.close(); }, 600);
            }
            if (ws.username) activeUsers.delete(t);
            broadcast({type: 'purge', id: msg.id, targetUser: t});
            ws.send(JSON.stringify({type: 'purge-result', id: 'system', target: msg.id, targetUser: t, success: existed}));
            console.log(`\x1b[31m[PURGE]\x1b[0m ${t} purged by ${msg.id}`);
            return;
        }

        if (db.muted[msg.id] && Date.now() < db.muted[msg.id]) {
            if (['chat-message', 'cell', 'clear', 'admin', 'areadmin', 'chat-typing'].includes(msg.type)) return;
        }

        if (msg.type === 'chat-message') {
            const userData = db.accounts[msg.id]; msg.isOwner = userData ? userData.isOwner : false; msg.isAdmin = userData ? userData.isAdmin : false; msg.isMember = userData ? userData.isMember : false;
            if (msg.scope === 'global') { db.globalChat.push(msg); if (db.globalChat.length > 200) db.globalChat.shift(); dbDirty = true; broadcast(msg); }
            else { 
                if (db.walls[ws.wallId]) { db.walls[ws.wallId].chat.push(msg); if (db.walls[ws.wallId].chat.length > 200) db.walls[ws.wallId].chat.shift(); dbDirty = true; }
                wss.clients.forEach(c => { if (c !== ws && c.readyState === WebSocket.OPEN && c.wallId === ws.wallId) c.send(JSON.stringify(msg)); }); 
            }
            return;
        }

        if (msg.type === 'chat-typing') {
            const userData = db.accounts[msg.id]; msg.isMember = userData ? userData.isMember : false;
            if (msg.scope === 'global') { broadcast(msg); }
            else { wss.clients.forEach(c => { if (c !== ws && c.readyState === WebSocket.OPEN && c.wallId === ws.wallId) c.send(JSON.stringify(msg)); }); }
            return;
        }

        if (isCanvasMuted(ws.ip)) {
            if (['cell', 'clear', 'admin', 'areadmin'].includes(msg.type)) return;
        }

        const wallData = db.walls[ws.wallId]; if (!wallData) return;
        const userData = db.accounts[msg.id];
        const isOwner = userData && userData.isOwner;
        const isAdmin = userData && userData.isAdmin;
        const isMember = userData && userData.isMember;
        const isWallOwner = ws.wallId === '~' + ws.username;

        if (msg.type === 'cell') {
            let isProtected = wallData.protectedTiles.includes(getTileKey(msg.col, msg.row));
            if (!isProtected) { for (const a of (wallData.protectedAreas || [])) { if (msg.col >= a[0] && msg.col <= a[2] && msg.row >= a[1] && msg.row <= a[3]) { isProtected = true; break; } } }
            if (isOwner || isAdmin || isWallOwner || isMember || !isProtected) {
                const k = `${msg.col},${msg.row}`; const ex = wallData.grid[k];
                if (!ex || msg.t >= ex.t) { const nc = { ch: msg.ch, color: msg.color, t: msg.t }; if (msg.fmt.b) nc.b = true; if (msg.fmt.i) nc.i = true; if (msg.fmt.u) nc.u = true; if (msg.fmt.s) nc.s = true; if (msg.fmt.o) nc.o = true; if (msg.fmt.ol) nc.ol = true; wallData.grid[k] = nc; dbDirty = true; }
            }
        } else if (msg.type === 'clear') {
            let isProtected = wallData.protectedTiles.includes(getTileKey(msg.col, msg.row));
            if (!isProtected) { for (const a of (wallData.protectedAreas || [])) { if (msg.col >= a[0] && msg.col <= a[2] && msg.row >= a[1] && msg.row <= a[3]) { isProtected = true; break; } } }
            if (isOwner || isAdmin || isWallOwner || isMember || !isProtected) { const k = `${msg.col},${msg.row}`; if (wallData.grid[k]) { delete wallData.grid[k]; dbDirty = true; } }
        } else if (msg.type === 'admin' || msg.type === 'areadmin') {
            if (isOwner || isAdmin || isWallOwner || isMember) {
                if (msg.type === 'areadmin') {
                    const c1 = Math.min(msg.c1, msg.c2), c2 = Math.max(msg.c1, msg.c2), r1 = Math.min(msg.r1, msg.r2), r2 = Math.max(msg.r1, msg.r2);
                    if (msg.act === 'areaclear') { for(let r=r1; r<=r2; r++) for(let c=c1; c<=c2; c++) delete wallData.grid[`${c},${r}`]; dbDirty = true; }
                    else if (msg.act === 'areaprotect') { wallData.protectedAreas.push([c1, r1, c2, r2]); dbDirty = true; }
                    else if (msg.act === 'areadeprotect') { wallData.protectedAreas = wallData.protectedAreas.filter(a => !(Math.max(a[0], c1) <= Math.min(a[2], c2) && Math.max(a[1], r1) <= Math.min(a[3], r2))); dbDirty = true; }
                } else {
                    if (msg.act === 'protect') { if (!wallData.protectedTiles.includes(`${msg.col},${msg.row}`)) { wallData.protectedTiles.push(`${msg.col},${msg.row}`); dbDirty = true; } }
                    else if (msg.act === 'deprotect') { wallData.protectedTiles = wallData.protectedTiles.filter(t => t !== `${msg.col},${msg.row}`); dbDirty = true; }
                    else if (msg.act === 'clear') { for(let r=0; r<10; r++) for(let c=0; c<20; c++) delete wallData.grid[`${msg.col*20+c-4000},${msg.row*10+r-4000}`]; dbDirty = true; }
                    else if (msg.act === 'wallclear' && isOwner) { wallData.grid = {}; wallData.protectedTiles = []; wallData.protectedAreas = []; wallData.chat = []; dbDirty = true; }
                }
            }
        }

        wss.clients.forEach((client) => { if (client !== ws && client.readyState === WebSocket.OPEN && client.wallId === ws.wallId) client.send(JSON.stringify(msg)); });
    });

    ws.on('close', () => { if (ws.username) activeUsers.delete(ws.username); });
});

setInterval(() => { const count = wss.clients.size; wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({type: 'online-count', id: 'system', count})); }); }, 5000);

// ---------------- Server Console Commands ----------------
function consoleAnnounce(text) {
    broadcast({type: 'server-announce', id: 'SERVER', anon: 'Server Console', text: text, t: Date.now()});
    console.log(`\x1b[35m[CONSOLE ANNOUNCE]\x1b[0m ${text}`);
}

function promoteConsole(u, role) {
    if (db.accounts[u]) {
        if (role === 'admin') db.accounts[u].isAdmin = true;
        if (role === 'member') db.accounts[u].isMember = true;
        dbDirty = true;
        broadcast({type: 'promote', targetUser: u, role});
        console.log(`Promoted ${u} to ${role}.`);
    } else { console.log(`User ${u} not found.`); }
}

// Full wipe: delete every wall and user (keeps only the owner account)
function wipeAll(reason) {
    const keep = {};
    if (db.accounts['RubixYT']) keep['RubixYT'] = db.accounts['RubixYT'];
    db.accounts = keep;
    db.walls = { Main: { grid: {}, protectedTiles: [], protectedAreas: [], chat: [] } };
    db.muted = {}; db.canvasMuted = {}; db.userIps = {};
    db.globalChat = [];
    dbDirty = true;
    broadcast({type: 'purgeall', reason: reason || ''});
    broadcast({type: 'server-announce', id: 'SERVER', anon: 'Server Console', text: 'Full server wipe complete.' + (reason ? ' Reason: ' + reason : ''), t: Date.now()});
    console.log(`\x1b[31m[PURGEALL]\x1b[0m wiped all walls and users.` + (reason ? ` Reason: ${reason}` : ''));
}

const HELP = [
  '---------- PeriaWall Console Commands ----------',
  '/help                       Show this list of commands',
  '/say <text>                 Server-console announcement (distinct banner)',
  '/announce <text>            Alias of /say',
  '/member <user>              Promote a user to Member',
  '/admin <user>               Promote a user to Admin',
  '/demote <user>              Remove Admin/Member roles',
  '/mute <user> <minutes>      Chat-mute a user',
  '/unmute <user>              Lift a chat mute',
  '/canvasmute <user>          Permanently canvas-mute a user (by IP)',
  '/tempcanvasmute <user> <m>  Temporarily canvas-mute a user (by IP)',
  '/canvasunmute <user>        Lift a canvas mute',
  '/color <on|off>             Enable/disable color rendering for everyone',
  '/stoppayload                Clear the "server payloaded" warning on all clients',
  '/kick <user>                Disconnect a user',
  '/purge <user>               Delete an account and its user walls',
  '/purgeall <reason> <sec>    Wipe ALL walls and users (optional countdown)',
  '/users                      List all registered accounts',
  '/online                     List currently online users',
  '/walls                      List all walls',
  '/clearwall <name>           Wipe a wall clean (owner)',
  '/auth                       Reveal the owner password',
  '------------------------------------------------'
];

let stdin = process.openStdin();
stdin.addListener('data', function(d) {
    const text = d.toString().trim();
    if (!text) return;
    if (!text.startsWith('/')) { consoleAnnounce(text); return; }

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg1 = parts[1] || '';
    const arg2 = parts[2] || '';
    const rest = text.substring(parts[0].length).trim();

    switch (cmd) {
        case '/help': case '/?': case '/commands':
            HELP.forEach(l => console.log(l));
            break;
        case '/say': case '/announce':
            if (rest) consoleAnnounce(rest); else console.log('Usage: /say <text>');
            break;
        case '/auth':
            console.log(`Owner Password: ${ownerPass}`);
            break;
        case '/color': {
            const v = arg1.toLowerCase();
            if (v === 'off' || v === '0' || v === 'false') { db.colorEnabled = false; dbDirty = true; broadcast({type: 'color-mode', enabled: false}); console.log('Color DISABLED for everyone.'); }
            else { db.colorEnabled = true; dbDirty = true; broadcast({type: 'color-mode', enabled: true}); console.log('Color ENABLED for everyone.'); }
            break;
        }
        case '/stoppayload': broadcast({type:'payload-stopped'}); console.log('Payload warning cleared for all clients.'); break;
        case '/member': promoteConsole(arg1, 'member'); break;
        case '/admin': promoteConsole(arg1, 'admin'); break;
        case '/demote':
            if (db.accounts[arg1]) { db.accounts[arg1].isAdmin = false; db.accounts[arg1].isMember = false; dbDirty = true; broadcast({type: 'demote', targetUser: arg1}); console.log(`Demoted ${arg1}.`); } else console.log(`User ${arg1} not found.`);
            break;
        case '/mute': {
            const mins = parseInt(arg2) || 0;
            if (db.accounts[arg1]) { db.muted[arg1] = Date.now() + mins * 60000; dbDirty = true; broadcast({type: 'mute', targetUser: arg1, expires: db.muted[arg1]}); console.log(`Muted ${arg1} for ${mins} min.`); } else console.log(`User ${arg1} not found.`);
            break;
        }
        case '/unmute':
            if (db.muted[arg1]) { delete db.muted[arg1]; dbDirty = true; broadcast({type: 'unmute', targetUser: arg1}); console.log(`Unmuted ${arg1}.`); } else console.log(`${arg1} is not muted.`);
            break;
        case '/canvasmute': case '/tempcanvasmute': {
            const mins = (cmd === '/tempcanvasmute') ? (parseInt(arg2) || 0) : 0;
            const ip = db.userIps[arg1];
            if (!ip) { console.log(`No IP on record for ${arg1} (user must have logged in at least once).`); break; }
            db.canvasMuted[ip] = mins > 0 ? { expires: Date.now() + mins * 60000 } : { permanent: true };
            dbDirty = true;
            broadcast({type: 'canvasmute', targetUser: arg1, minutes: mins, expires: mins > 0 ? Date.now() + mins * 60000 : 0, permanent: mins <= 0});
            console.log(`Canvas-muted ${arg1} (${ip}) ${mins > 0 ? 'for ' + mins + ' min' : 'permanently'}.`);
            break;
        }
        case '/canvasunmute': {
            const ip = db.userIps[arg1];
            if (ip && db.canvasMuted[ip]) { delete db.canvasMuted[ip]; dbDirty = true; broadcast({type: 'canvasunmute', targetUser: arg1}); console.log(`Canvas-unmuted ${arg1}.`); } else console.log(`${arg1} is not canvas-muted.`);
            break;
        }
        case '/kick': {
            const c = findClientByUsername(arg1);
            if (c) { c.send(JSON.stringify({type: 'kicked', targetUser: arg1})); const cc = c; setTimeout(() => { if (cc.readyState === WebSocket.OPEN) cc.close(); }, 400); console.log(`Kicked ${arg1}.`); } else console.log(`${arg1} is not online.`);
            break;
        }
        case '/purge': {
            if (!arg1) { console.log('Usage: /purge <user>'); break; }
            if (arg1 === 'RubixYT') { console.log('Cannot purge the owner account.'); break; }
            if (db.accounts[arg1]) {
                delete db.accounts[arg1];
                if (db.userIps[arg1]) delete db.userIps[arg1];
                if (db.muted[arg1]) delete db.muted[arg1];
                delete db.walls['~' + arg1];
                dbDirty = true;
                const c = findClientByUsername(arg1);
                if (c) { c.send(JSON.stringify({type: 'purged', targetUser: arg1})); const cc = c; setTimeout(() => { if (cc.readyState === WebSocket.OPEN) cc.close(); }, 600); }
                broadcast({type: 'purge', targetUser: arg1});
                console.log(`Purged ${arg1}.`);
            } else console.log(`User ${arg1} not found.`);
            break;
        }
        case '/purgeall': {
            // /purgeall <reason ...> <seconds>
            const m = rest.match(/^(.*?)\s+(\d+)$/);
            let reason, secs;
            if (m) { reason = m[1]; secs = parseInt(m[2]); } else { reason = rest; secs = 0; }
            if (!reason) reason = 'No reason provided';
            if (secs > 0) {
                broadcast({type:'purgeall-countdown', seconds: secs, reason: reason});
                consoleAnnounce('FULL WIPE in ' + secs + 's — ' + reason);
                console.log('[PURGEALL] scheduled in ' + secs + 's: ' + reason);
                setTimeout(() => wipeAll(reason), secs * 1000);
            } else {
                wipeAll(reason);
            }
            break;
        }
        case '/users':
            console.log('--- Accounts ---');
            Object.keys(db.accounts).forEach(u => { const a = db.accounts[u]; console.log(`  ${u}${a.isOwner ? ' [OWNER]' : a.isAdmin ? ' [admin]' : a.isMember ? ' [member]' : ''}${activeUsers.has(u) ? ' (online)' : ''}`); });
            break;
        case '/online': {
            const arr = []; wss.clients.forEach(c => { if (c.username) arr.push(c.username); });
            console.log(`Online (${arr.length}): ${arr.join(', ') || 'none'}`);
            break;
        }
        case '/walls':
            console.log('Walls: ' + Object.keys(db.walls).join(', '));
            break;
        case '/clearwall': {
            const w = normalizeWall(arg1);
            if (db.walls[w]) { db.walls[w].grid = {}; db.walls[w].protectedTiles = []; db.walls[w].protectedAreas = []; db.walls[w].chat = []; dbDirty = true; const payload = JSON.stringify({type: 'admin', id: 'SERVER', act: 'wallclear'}); wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.wallId === w) c.send(payload); }); console.log(`Cleared wall "${w}".`); } else console.log(`Wall "${w}" not found.`);
            break;
        }
        default:
            console.log(`Unknown command: ${cmd} — type /help for the list.`);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`Periawall server v${VERSION} running on port ${PORT}`); });
