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
  messages: [],
  forumMessages: [],
  bannedUsers: []   // 存储禁言/踢出记录 { nickname, action, reason, admin, time }
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

// ---------- 聊天室 API（保持不变） ----------
db.data.users ||= [];
db.data.messages ||= [];
db.write();

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
  req.session.chatUser = username;
  res.json({ success: true, username, avatarColor: finalColor, avatarIcon: finalIcon });
});

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

app.post('/api/chat/logout', (req, res) => {
  req.session.chatUser = null;
  res.json({ success: true });
});

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
  if (db.data.messages.length > 50) db.data.messages = db.data.messages.slice(-50);
  db.write();
  res.json({ success: true });
});

app.get('/api/chat/messages', (req, res) => {
  const limit = 50;
  const messages = db.data.messages.slice(-limit).reverse();
  res.json(messages);
});

// ---------- 论坛 API（含禁言/踢出管理） ----------
db.data.forumMessages ||= [];
db.data.bannedUsers ||= [];
db.write();

// 获取论坛消息（最近 100 条），同时附带禁言/踢出列表（管理员可见）
app.get('/api/forum/messages', (req, res) => {
  const limit = 100;
  const messages = db.data.forumMessages.slice(-limit).reverse();
  // 如果用户是管理员，则额外返回 bannedUsers 列表
  const isAdmin = req.session.loggedIn && req.session.role === 'admin';
  res.json({
    messages,
    bannedUsers: isAdmin ? db.data.bannedUsers : []
  });
});

// 发布论坛消息（检查是否被禁言）
app.post('/api/forum/messages', (req, res) => {
  const { nickname, text } = req.body;
  if (!nickname || !text || text.trim() === '') {
    return res.status(400).json({ error: '昵称和内容不能为空' });
  }
  // 检查该昵称是否被禁言
  const banned = db.data.bannedUsers.find(b => b.nickname === nickname && b.action === 'ban');
  if (banned) {
    return res.status(403).json({ error: `你已被禁言，原因：${banned.reason || '未提供'}` });
  }
  const message = {
    id: Date.now(),
    nickname: nickname.trim().substring(0, 20),
    text: text.trim().substring(0, 200),
    time: new Date().toISOString()
  };
  db.data.forumMessages.push(message);
  if (db.data.forumMessages.length > 200) db.data.forumMessages = db.data.forumMessages.slice(-200);
  db.write();
  res.json({ success: true });
});

// 🆕 清空论坛消息（仅管理员）
app.delete('/api/forum/messages', (req, res) => {
  if (!req.session.loggedIn || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  db.data.forumMessages = [];
  db.write();
  res.json({ success: true, message: '所有论坛消息已清空' });
});

// 🆕 禁言或踢出用户（仅管理员）
app.post('/api/forum/ban', (req, res) => {
  if (!req.session.loggedIn || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  const { nickname, action, reason } = req.body; // action: 'ban' 或 'kick'
  if (!nickname || !action) {
    return res.status(400).json({ error: '昵称和操作类型不能为空' });
  }
  if (action !== 'ban' && action !== 'kick') {
    return res.status(400).json({ error: '操作类型无效，只能是 ban 或 kick' });
  }
  // 检查该用户是否已被处理
  const existing = db.data.bannedUsers.find(b => b.nickname === nickname);
  if (existing) {
    return res.status(400).json({ error: `该用户已被${existing.action === 'ban' ? '禁言' : '踢出'}` });
  }
  const record = {
    nickname,
    action,
    reason: reason || (action === 'ban' ? '违反社区规则' : '管理员操作'),
    admin: ADMIN_USER.username,
    time: new Date().toISOString()
  };
  db.data.bannedUsers.push(record);
  db.write();
  res.json({ success: true, record });
});

// 🆕 解除禁言/踢出（仅管理员）
app.delete('/api/forum/ban/:nickname', (req, res) => {
  if (!req.session.loggedIn || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  const nickname = req.params.nickname;
  const index = db.data.bannedUsers.findIndex(b => b.nickname === nickname);
  if (index === -1) {
    return res.status(404).json({ error: '未找到该用户的处罚记录' });
  }
  db.data.bannedUsers.splice(index, 1);
  db.write();
  res.json({ success: true, message: '已解除处罚' });
});

// ---------- 启动服务器 ----------
app.listen(PORT, () => {
  console.log(`阿颜棒球的专属工具箱已启动 -> http://localhost:${PORT}`);
});