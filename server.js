const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
            if (err) { res.writeHead(500); return res.end('Error loading'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocket.Server({ server });

const ownerPass = Math.random().toString(36).substring(2, 11);
console.log("\x1b[31m%s\x1b[0m", "Do not forget!");
console.log("\x1b[31m%s\x1b[0m", `Owner Password: ${ownerPass}`);

let db = { walls: { Main: { grid: {}, protectedTiles: [], protectedAreas: [], chat: [] } }, accounts: {}, muted: {} };
try {
    const data = fs.readFileSync('db.json', 'utf8');
    db = JSON.parse(data);
    if (!db.walls) db.walls = { Main: { grid: {}, protectedTiles: [], protectedAreas: [], chat: [] } };
    if (!db.walls.Main) db.walls.Main = { grid: {}, protectedTiles: [], protectedAreas: [], chat: [] };
    if (!db.walls.Main.chat) db.walls.Main.chat = [];
    if (!db.walls.Main.protectedAreas) db.walls.Main.protectedAreas = [];
    if (!db.accounts) db.accounts = {};
    if (!db.muted) db.muted = {};
} catch (e) {}

//db.accounts.yourOwnerName = { password: ownerPass, isOwner: true, isAdmin: false, isMember: false, p: '#ff8a3d', s: '#f4f1de' };

let dbDirty = false;
setInterval(() => { if (dbDirty) { dbDirty = false; fs.writeFile('db.json', JSON.stringify(db), () => {}); } }, 2000);

function normalizeWall(name) { const lower = name.toLowerCase().trim(); if (lower === '' || lower === 'main' || lower.includes('main wall')) return 'Main'; return name.trim(); }
function getTileKey(col, row) { return `${Math.floor((col+4000)/10)},${Math.floor((row+4000)/10)}`; }

const activeUsers = new Set();

function broadcast(msg) {
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg)); });
}

wss.on('connection', (ws) => {
    ws.wallId = 'Main';
    ws.username = null;

    ws.on('message', (message) => {
        const msg = JSON.parse(message.toString());
        
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
                    dbDirty = true;
                } else { db.accounts[msg.u] = { password: msg.p, isOwner: false, isAdmin: false, isMember: false, p: msg.pColor || '#ff8a3d', s: msg.sColor || '#f4f1de' }; dbDirty = true; }
            }
            if (ws.username) activeUsers.delete(ws.username);
            ws.username = msg.u; activeUsers.add(msg.u);
            const acc = db.accounts[msg.u];
            ws.send(JSON.stringify({ type: 'login-result', id: 'system', target: msg.id, success: true, isOwner: acc.isOwner, isAdmin: acc.isAdmin, isMember: acc.isMember, username: msg.u, p: acc.p, s: acc.s }));
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
            for (const [key, c] of Object.entries(wallData.grid)) { const ci = key.indexOf(','); cells.push([+key.slice(0,ci), +key.slice(ci+1), c.ch, c.color, c.t, c.b, c.i, c.u, c.s, c.o]); }
            ws.send(JSON.stringify({type:'sync', id:'system', target: msg.id, cells, protectedTiles: wallData.protectedTiles, protectedAreas: wallData.protectedAreas, t: Date.now()}));
            ws.send(JSON.stringify({type:'chat-history', id:'system', target: msg.id, scope: 'wall', messages: wallData.chat || []}));
            wss.clients.forEach((client) => { if (client !== ws && client.readyState === WebSocket.OPEN && client.wallId === ws.wallId) client.send(message.toString()); });
            return;
        }

        if (msg.type === 'nick') {
            if (activeUsers.has(msg.newId)) return ws.send(JSON.stringify({ type: 'system-msg', id: 'system', target: msg.oldId, text: 'Nickname already taken.' }));
            activeUsers.delete(msg.oldId); activeUsers.add(msg.newId);
            if (ws.username === msg.oldId) ws.username = msg.newId;
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

        if (msg.type === 'mute') {
            const userData = db.accounts[msg.id];
            if (userData && (userData.isOwner || userData.isAdmin)) {
                const expires = Date.now() + (msg.minutes * 60000); db.muted[msg.targetUser] = expires; dbDirty = true;
                broadcast({type: 'mute', id: msg.id, targetUser: msg.targetUser, expires});
            }
            return;
        }

        if (msg.type === 'announce') {
            const ownerData = db.accounts[msg.id];
            if (ownerData && ownerData.isOwner) { broadcast({type: 'announce', id: msg.id, text: msg.text}); }
            return;
        }

        if (db.muted[msg.id] && Date.now() < db.muted[msg.id]) {
            if (['chat-message', 'cell', 'clear', 'admin', 'areadmin', 'chat-typing'].includes(msg.type)) return;
        }

        if (msg.type === 'chat-message') {
            const userData = db.accounts[msg.id]; msg.isOwner = userData ? userData.isOwner : false; msg.isAdmin = userData ? userData.isAdmin : false; msg.isMember = userData ? userData.isMember : false;
            if (msg.scope === 'global') { broadcast(msg); }
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
                if (!ex || msg.t >= ex.t) { wallData.grid[k] = { ch: msg.ch, color: msg.color, t: msg.t, b: msg.fmt.b, i: msg.fmt.i, u: msg.fmt.u, s: msg.fmt.s, o: msg.fmt.o }; dbDirty = true; }
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
                    else if (msg.act === 'clear') { for(let r=0; r<10; r++) for(let c=0; c<10; c++) delete wallData.grid[`${msg.col*10+c-4000},${msg.row*10+r-4000}`]; dbDirty = true; }
                    else if (msg.act === 'wallclear' && isOwner) { wallData.grid = {}; wallData.protectedTiles = []; wallData.protectedAreas = []; wallData.chat = []; dbDirty = true; }
                }
            }
        }

        wss.clients.forEach((client) => { if (client !== ws && client.readyState === WebSocket.OPEN && client.wallId === ws.wallId) client.send(JSON.stringify(msg)); });
    });

    ws.on('close', () => { if (ws.username) activeUsers.delete(ws.username); });
});

setInterval(() => { const count = wss.clients.size; wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({type: 'online-count', id: 'system', count})); }); }, 5000);

// Server Console Commands
let stdin = process.openStdin();
stdin.addListener('data', function(d) {
    const text = d.toString().trim();
    if (!text) return;
    if (text.startsWith('/auth')) {
        console.log('Server console authorized as yourOwnerName (Owner). You can now type messages to announce.');
    } else if (text.startsWith('/member ')) {
        const u = text.substring(8).trim();
        if (db.accounts[u]) {
            db.accounts[u].isMember = true; dbDirty = true;
            broadcast({type: 'promote', targetUser: u, role: 'member'});
            console.log(`Promoted ${u} to Member.`);
        } else { console.log(`User ${u} not found.`); }
    } else if (text.startsWith('/admin ')) {
        const u = text.substring(7).trim();
        if (db.accounts[u]) {
            db.accounts[u].isAdmin = true; dbDirty = true;
            broadcast({type: 'promote', targetUser: u, role: 'admin'});
            console.log(`Promoted ${u} to Admin.`);
        } else { console.log(`User ${u} not found.`); }
    } else {
        const msg = {type: 'chat-message', id: 'SERVER', anon: 'Server', color: '#ff4757', text: text, t: Date.now(), scope: 'global', isOwner: true, isAdmin: false, isMember: false};
        broadcast(msg);
        broadcast({type: 'announce', id: 'SERVER', text: text});
        console.log(`Announced: ${text}`);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`Periawall server running on port ${PORT}`); });
