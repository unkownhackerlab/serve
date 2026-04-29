require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ============ DATA STORAGE SETUP ============
// On Render, mount a Persistent Disk to /opt/render/project/data
const DATA_DIR = process.env.RENDER ? '/opt/render/project/data' : path.join(__dirname, 'data');

// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// File paths
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CRASH_FILE = path.join(DATA_DIR, 'crash_predictions.json');
const HISTORY_FILE = path.join(DATA_DIR, 'rounds_history.json');

// Initialize files if they don't exist
function initFiles() {
  const defaultFiles = {
    [USERS_FILE]: {},
    [CRASH_FILE]: [],
    [HISTORY_FILE]: []
  };

  for (const [filePath, defaultValue] of Object.entries(defaultFiles)) {
    if (!fs.existsSync(filePath)) {
      // Check for old data in project directory and migrate
      const oldPath = path.join(__dirname, path.basename(filePath));
      if (fs.existsSync(oldPath)) {
        fs.copyFileSync(oldPath, filePath);
        console.log(`Migrated ${path.basename(filePath)} to persistent disk`);
      } else {
        fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
        console.log(`Created ${path.basename(filePath)} on persistent disk`);
      }
    }
  }
}

initFiles();

// ============ FILE HELPERS ============
function readJSON(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
    return null;
  }
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
    return false;
  }
}

// ============ ADMIN AUTH ============
const ADMIN_KEY = process.env.ADMIN_API_KEY || 'jetx-admin-secret-key-2026';

function adminAuth(req, res, next) {
  const key = req.headers['admin-key'] || req.body.admin_key;
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
  res.json({
    status: 'JETX API Running',
    storage: DATA_DIR,
    persistent: !!process.env.RENDER,
    timestamp: new Date().toISOString()
  });
});

// ============ AUTH ROUTES ============

app.post('/api/auth/register', (req, res) => {
  try {
    const { phone, username, password } = req.body;

    if (!phone || !username || !password) {
      return res.status(400).json({ success: false, error: 'All fields required' });
    }

    const users = readJSON(USERS_FILE);
    
    if (users[phone]) {
      return res.status(400).json({ success: false, error: 'Phone already registered' });
    }

    // Create user
    users[phone] = {
      phone,
      username,
      password,
      realBalance: 0,
      demoBalance: 10000,
      isRealMode: false,
      createdAt: new Date().toISOString()
    };

    writeJSON(USERS_FILE, users);

    const { password: _, ...safeUser } = users[phone];
    res.status(201).json({ success: true, user: safeUser });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { phone, password } = req.body;
    const users = readJSON(USERS_FILE);
    const user = users[phone];

    if (!user || user.password !== password) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const { password: _, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ USER ROUTES ============

app.get('/api/user/:phone', (req, res) => {
  try {
    const users = readJSON(USERS_FILE);
    const user = users[req.params.phone];

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const { password, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/user/update-balance', (req, res) => {
  try {
    const { phone, realBalance, demoBalance, isRealMode } = req.body;
    const users = readJSON(USERS_FILE);

    if (!users[phone]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (realBalance !== undefined) users[phone].realBalance = realBalance;
    if (demoBalance !== undefined) users[phone].demoBalance = demoBalance;
    if (isRealMode !== undefined) users[phone].isRealMode = isRealMode;

    writeJSON(USERS_FILE, users);

    const { password, ...safeUser } = users[phone];
    res.json({ success: true, user: safeUser });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ GAME ROUTES ============

app.get('/api/game/crash', (req, res) => {
  try {
    const predictions = readJSON(CRASH_FILE);
    const active = predictions.filter(p => p.isActive);
    const latest = active[active.length - 1] || null;

    res.json({
      success: true,
      crash_point: latest?.crashPoint || null,
      is_admin_set: !!latest
    });
  } catch (error) {
    res.json({ success: true, crash_point: null });
  }
});

app.get('/api/game/history', (req, res) => {
  try {
    const history = readJSON(HISTORY_FILE);
    const limit = parseInt(req.query.limit) || 20;
    res.json({ success: true, history: history.slice(0, limit) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/game/round-result', (req, res) => {
  try {
    const { crash_point } = req.body;
    const history = readJSON(HISTORY_FILE);

    history.unshift({
      id: Date.now().toString(),
      crashPoint: parseFloat(crash_point),
      createdAt: new Date().toISOString()
    });

    // Keep last 100 rounds
    const trimmed = history.slice(0, 100);
    writeJSON(HISTORY_FILE, trimmed);

    res.json({ success: true, round: trimmed[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ ADMIN ROUTES ============

// GET ALL USERS WITH BALANCES
app.get('/api/admin/users', adminAuth, (req, res) => {
  try {
    const users = readJSON(USERS_FILE);
    
    const userList = Object.values(users).map(u => ({
      phone: u.phone,
      username: u.username,
      realBalance: u.realBalance || 0,
      demoBalance: u.demoBalance || 10000,
      isRealMode: u.isRealMode || false,
      createdAt: u.createdAt
    }));

    const totalRealBalance = userList.reduce((sum, u) => sum + u.realBalance, 0);

    res.json({
      success: true,
      total_users: userList.length,
      total_real_balance: totalRealBalance,
      users: userList
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ADD FUNDS TO USER
app.post('/api/admin/add-funds', adminAuth, (req, res) => {
  try {
    const { phone, amount } = req.body;

    if (!phone || !amount || amount < 10) {
      return res.status(400).json({ success: false, error: 'Invalid phone or amount (min 10)' });
    }

    const users = readJSON(USERS_FILE);

    if (!users[phone]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const oldBalance = users[phone].realBalance || 0;
    users[phone].realBalance = oldBalance + parseFloat(amount);
    writeJSON(USERS_FILE, users);

    res.json({
      success: true,
      message: `Added ${amount} KSH to ${users[phone].username}`,
      previous_balance: oldBalance,
      new_balance: users[phone].realBalance,
      user: {
        phone: users[phone].phone,
        username: users[phone].username,
        realBalance: users[phone].realBalance
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// SET CRASH POINT
app.post('/api/admin/set-crash', adminAuth, (req, res) => {
  try {
    const { crash_point } = req.body;

    if (!crash_point || crash_point < 1.0) {
      return res.status(400).json({ success: false, error: 'Crash point must be ≥ 1.00' });
    }

    const predictions = readJSON(CRASH_FILE);

    // Deactivate all
    predictions.forEach(p => p.isActive = false);

    // Add new
    predictions.push({
      id: Date.now().toString(),
      crashPoint: parseFloat(crash_point),
      isActive: true,
      createdAt: new Date().toISOString()
    });

    writeJSON(CRASH_FILE, predictions);

    res.json({
      success: true,
      crash_point: parseFloat(crash_point),
      message: `Crash point set to ${crash_point}x for ALL players`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// CLEAR CRASH POINT
app.post('/api/admin/clear-crash', adminAuth, (req, res) => {
  try {
    const predictions = readJSON(CRASH_FILE);
    predictions.forEach(p => p.isActive = false);
    writeJSON(CRASH_FILE, predictions);

    res.json({ success: true, message: 'Crash point cleared - random mode activated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log(`🚀 JETX API running on port ${PORT}`);
  console.log(`📁 Data stored at: ${DATA_DIR}`);
  console.log(`💾 Persistent: ${!!process.env.RENDER}`);
});