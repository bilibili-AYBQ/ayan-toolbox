const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const { LowSync, JSONFileSync } = require('lowdb');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(session({
  secret: 'ayan_super_secret_key_change_me',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 30 * 60 * 1000 }
}));

// 使用 JSON 文件存储数据（无需编译）
const adapter = new JSONFileSync('data.json');
const db = new LowSync(adapter);
db.read();
db.data ||= { totalVisits: 0, onlineUsers: {} };
db.write();

// 辅助函数
function incrementTotalVisits() {
  db.data.totalVisits++;
  db.write();
}

function getTotalVisits() {
  return db.data.totalVisits;
}

// 在线用户管理（心跳，游客也支持？为了简单，只记录登录用户的心跳，游客不计入在线）
function heartbeat(sessionId, isAdmin = false) {
  if (!isAdmin) return; // 只有管理员才记录在线时长
  db.data.onlineUsers[sessionId] = Date.now();
  db.write();
}

function cleanInactiveUsers() {
  const now = Date.now();
  let changed = false;
  for (const [sid, last] of Object.entries(db.data.onlineUsers)) {
    if (now - last > 60 * 1000) {
      delete db.data.onlineUsers[sid];
      changed = true;
    }
  }
  if (changed) db.write();
}

function getOnlineCount() {
  cleanInactiveUsers();
  return Object.keys(db.data.onlineUsers).length;
}

// 管理员账号（你可以修改）
const ADMIN_USER = {
  username: 'ayan_admin',
  password: 'T0olB0x#2025$tr0ng'
};

// 路由：首页（所有访问者都看到同一页面，但根据 session 决定右侧按钮状态）
app.get('/', (req, res) => {
  incrementTotalVisits(); // 每次访问都增加总访问量
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 登录 API
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER.username && password === ADMIN_USER.password) {
    req.session.loggedIn = true;
    req.session.role = 'admin';
    res.json({ success: true, role: 'admin' });
  } else {
    res.json({ success: false, message: '账号或密码错误' });
  }
});

// 登出 API
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// 获取当前登录状态
app.get('/api/session', (req, res) => {
  res.json({
    loggedIn: !!req.session.loggedIn,
    role: req.session.role || 'guest',
    username: req.session.loggedIn ? ADMIN_USER.username : null
  });
});

// 获取统计数据（任何人都可以看，但在线人数只统计管理员）
app.get('/api/stats', (req, res) => {
  res.json({
    totalVisits: getTotalVisits(),
    onlineCount: getOnlineCount()
  });
});

// 管理员心跳（保持在线）
app.post('/api/heartbeat', (req, res) => {
  if (req.session.loggedIn && req.session.role === 'admin') {
    heartbeat(req.session.id, true);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: '未登录或非管理员' });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`阿颜棒球的专属工具箱已启动 -> http://localhost:${PORT}`);
});