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

// ---------- 数据库初始化 ----------
const adapter = new JSONFileSync('data.json');
const db = new LowSync(adapter);
db.read();
db.data ||= {
  totalVisits: 0,
  onlineUsers: {},
  users: [],
  messages: [],        // 聊天室消息，最多50条
  forumMessages: []    // 论坛留言，最多200条
};
db.write();

// 辅助函数：总访问量
function incrementTotalVisits() {
  db.data.totalVisits++;
  db.write();
}
function getTotalVisits() {
  return db.data.totalVisits;
}

// 管理员在线心跳
function heartbeat(sessionId, isAdmin = false) {
  if (!isAdmin) return;
  db.data.onlineUsers[sessionId] = Date.now();
  db.write();
}
function cleanInactiveUsers() {
  const now = Date.now();
  let changed = false;
  for (const [sid, last] of Object.entries(db.data.onlineUsers || {})) {
    if (now - last > 60 * 1000) {
      delete db.data.onlineUsers[sid];
      changed = true;
    }
  }
  if (changed) db.write();
}
function getOnlineCount() {
  cleanInactiveUsers();
  return Object.keys(db.data.onlineUsers || {}).length;
}

// 管理员账号
const ADMIN_USER = {
  username: 'ayan_admin',
  password: 'T0olB0x#2025$tr0ng'
};

// ---------- 原有路由 ----------
app.get('/', (req, res) => {
  incrementTotalVisits();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  res.json({
    loggedIn: !!req.session.loggedIn,
    role: req.session.role || 'guest',
    username: req.session.loggedIn ? ADMIN_USER.username : null
  });
});

app.get('/api/stats', (req, res) => {
  res.json({
    totalVisits: getTotalVisits(),
    onlineCount: getOnlineCount()
  });
});

app.post('/api/heartbeat', (req, res) => {
  if (req.session.loggedIn && req.session.role === 'admin') {
    heartbeat(req.session.id, true);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: '未登录或非管理员' });
  }
});

// ---------- 聊天室 API（带注册/登录/自定义头像，消息最多50条） ----------
db.data.users ||= [];
db.data.messages ||= [];
db.write();

// 注册（含头像颜色和图标）
app.post('/api/register', (req, res) => {
  const { username, password, avatarColor, avatarIcon } = req.body;
  if (!username || !password) {
    return res.json({ success: false, message: '用户名和密码不能为空' });
  }
  const existing = db.data.users.find(u => u.username === username);
  if (existing) {
    return res.json({ success: false, message: '用户名已存在' });
  }
  const colors = ['#e67e22', '#3498db', '#2ecc71', '#f1c40f', '#e74c3c', '#9b59b6'];
  const finalColor = avatarColor || colors[Math.floor(Math.random() * colors.length)];
  const finalIcon = avatarIcon || username.charAt(0).toUpperCase();
  db.data.users.push({
    username,
    password,
    avatarColor: finalColor,
    avatarIcon: finalIcon,
    createdAt: Date.now()
  });
  db.write();
  // 注册后自动登录聊天
  req.session.chatUser = username;
  res.json({ success: true, username, avatarColor: finalColor, avatarIcon: finalIcon });
});

// 聊天登录
app.post('/api/chat/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.data.users.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.chatUser = username;
    res.json({ success: true, username, avatarColor: user.avatarColor, avatarIcon: user.avatarIcon });
  } else {
    res.json({ success: false, message: '用户名或密码错误' });
  }
});

// 获取当前聊天用户信息
app.get('/api/chat/user', (req, res) => {
  const username = req.session.chatUser;
  if (!username) return res.json({ username: null });
  const user = db.data.users.find(u => u.username === username);
  res.json({
    username,
    avatarColor: user?.avatarColor || '#e67e22',
    avatarIcon: user?.avatarIcon || username?.charAt(0).toUpperCase() || '?'
  });
});

// 退出聊天
app.post('/api/chat/logout', (req, res) => {
  req.session.chatUser = null;
  res.json({ success: true });
});

// 发送聊天消息（限制最多保留50条）
app.post('/api/chat/send', (req, res) => {
  const username = req.session.chatUser;
  if (!username) return res.status(401).json({ error: '未登录' });
  const { text } = req.body;
  if (!text || text.trim() === '') return res.json({ success: false, message: '消息不能为空' });
  const user = db.data.users.find(u => u.username === username);
  const message = {
    id: Date.now(),
    username,
    text: text.trim(),
    time: new Date().toISOString(),
    avatarColor: user?.avatarColor || '#e67e22',
    avatarIcon: user?.avatarIcon || username.charAt(0).toUpperCase()
  };
  db.data.messages.push(message);
  // 限制最多 50 条消息（保留最新的 50 条）
  if (db.data.messages.length > 50) db.data.messages = db.data.messages.slice(-50);
  db.write();
  res.json({ success: true });
});

// 获取聊天消息（最近50条）
app.get('/api/chat/messages', (req, res) => {
  const limit = 50;
  const messages = db.data.messages.slice(-limit).reverse();
  res.json(messages);
});

// ---------- 论坛 API（无需登录，仅需昵称） ----------
db.data.forumMessages ||= [];
db.write();

// 获取论坛消息（最近 100 条）
app.get('/api/forum/messages', (req, res) => {
  const limit = 100;
  const messages = db.data.forumMessages.slice(-limit).reverse();
  res.json(messages);
});

// 发布论坛消息
app.post('/api/forum/messages', (req, res) => {
  const { nickname, text } = req.body;
  if (!nickname || !text || text.trim() === '') {
    return res.status(400).json({ error: '昵称和内容不能为空' });
  }
  // 简单防刷：限制每个昵称 10 秒内只能发一条（可选，非严格）
  const message = {
    id: Date.now(),
    nickname: nickname.trim().substring(0, 20),
    text: text.trim().substring(0, 200),
    time: new Date().toISOString()
  };
  db.data.forumMessages.push(message);
  // 保留最多 200 条，避免存储过大
  if (db.data.forumMessages.length > 200) db.data.forumMessages = db.data.forumMessages.slice(-200);
  db.write();
  res.json({ success: true });
});

// ---------- 启动服务器 ----------
app.listen(PORT, () => {
  console.log(`阿颜棒球的专属工具箱已启动 -> http://localhost:${PORT}`);
});