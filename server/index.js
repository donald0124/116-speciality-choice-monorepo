require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { randomBytes } = require('crypto');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const isZeabur = Boolean(process.env.ZEABUR);
const TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_MS || 8 * 60 * 60 * 1000);
const authTokens = new Map();

// 允許跨域請求
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  // 避免 API 被搜尋引擎建立索引
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

const createAuthToken = (user) => {
  const token = randomBytes(32).toString('hex');
  authTokens.set(token, {
    user,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
};

const getBearerToken = (req) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim();
};

const normalizeName = (value) => String(value || '').trim();
const normalizeRank = (value) => String(value || '').trim();

const requireAuth = (req, res, next) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: '未授權，請先登入' });
  }

  const tokenData = authTokens.get(token);
  if (!tokenData) {
    return res.status(401).json({ success: false, error: '登入已失效，請重新登入' });
  }

  if (tokenData.expiresAt < Date.now()) {
    authTokens.delete(token);
    return res.status(401).json({ success: false, error: '登入逾時，請重新登入' });
  }

  req.authUser = tokenData.user;
  req.authToken = token;
  next();
};

setInterval(() => {
  const now = Date.now();
  for (const [token, data] of authTokens.entries()) {
    if (data.expiresAt < now) {
      authTokens.delete(token);
    }
  }
}, 10 * 60 * 1000).unref();

// ✅ 新的寫法 (自動判斷環境)
let auth;

if (process.env.GOOGLE_CREDENTIALS) {
  // 情況 A：在 Zeabur 上 (讀取環境變數)
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    console.log("正在使用 Zeabur 環境變數驗證 Google API");
  } catch (err) {
    console.error("Zeabur 環境變數格式錯誤", err);
  }
} else {
  // 情況 B：在本地開發 (讀取 service-account.json 檔案)
  auth = new google.auth.GoogleAuth({
    keyFile: 'service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  console.log("正在使用本地檔案 service-account.json 驗證");
}

const sheets = google.sheets({ version: 'v4', auth });

// ⭐️ 修正 1: 優先讀取環境變數，讀不到就用字串，不要在 function 裡面重複宣告
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1suJb_H1iyAyogMj3ucPJ4vyeoxfAi7MrqGzyMelsVSc';

if (!SPREADSHEET_ID) {
  console.error('缺少 SPREADSHEET_ID，請在環境變數中設定');
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    runtime: isZeabur ? 'zeabur' : 'local',
    hasSpreadsheetId: Boolean(SPREADSHEET_ID),
    hasGoogleCredentialsEnv: Boolean(process.env.GOOGLE_CREDENTIALS),
  });
});

app.post('/api/login', async (req, res) => {
  const { name, pwd } = req.body;
  const normalizedName = normalizeName(name);

  if (!normalizedName || !pwd) {
    return res.status(400).json({ success: false, error: '缺少帳號或密碼' });
  }

  try {
    const usersReq = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Roster!A2:C', // Rank, Name, Pwd
    });

    const users = usersReq.data.values || [];
    const found = users.find((row) => normalizeName(row[1]) === normalizedName && String(row[2] || '') === String(pwd));

    if (!found) {
      return res.status(401).json({ success: false, error: '帳號或密碼錯誤' });
    }

    const authUser = {
      rank: normalizeRank(found[0]),
      name: normalizeName(found[1]),
    };

    const token = createAuthToken(authUser);
    res.json({ success: true, token, user: authUser });
  } catch (error) {
    console.error('登入失敗:', error);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
});

// API 1: 讀取資料
app.get('/api/data', requireAuth, async (req, res) => {
  try {
    // ❌ 刪除這裡原本重複宣告的 const SPREADSHEET_ID = ...

    // 1. 讀取 Config
    const configReq = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'config!A2:C',
    });

    // 2. 讀取 Users
    const usersReq = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Roster!A2:E', // Rank, Name, Pwd, Outcome, Selection
    });

    // 3. 資料整理
    const users = (usersReq.data.values || []).map(row => {
      let preferences = [];
      try {
        // 第 5 欄 (Index 4) 是 Selection
        preferences = row[4] ? JSON.parse(row[4]) : [];
      } catch (e) {
        console.error(`解析 ${row[1]} 的志願序失敗`, e);
      }

      return {
        rank: normalizeRank(row[0]),
        name: normalizeName(row[1]),
        preAssigned: row[3] || null, // Outcome/Bonded
        preferences: preferences
      };
    });

    const config = (configReq.data.values || []).map(row => ({
      label: row[0],
      regular: parseInt(row[1] || 0),
      bound: parseInt(row[2] || 0)
    }));

    res.json({ config, users });

  } catch (error) {
    console.error('讀取失敗:', error);
    res.status(500).send('Server Error');
  }
});

// API 2: 儲存志願序 (⭐️ 修正 2: 實作寫入邏輯)
app.post('/api/save', requireAuth, async (req, res) => {
  const { name, rank, preferences } = req.body;
  const actorName = normalizeName(req.authUser?.name);
  const actorRank = normalizeRank(req.authUser?.rank);
  const isAdmin = actorName === '謝士博';
  const targetName = normalizeName(name);
  const targetRank = isAdmin ? normalizeRank(rank) : actorRank;
  
  if (!targetRank && !targetName) {
    return res.status(400).json({ success: false, error: "缺少使用者資訊" });
  }

  if (!isAdmin && !actorRank) {
    return res.status(401).json({ success: false, error: '登入資訊不完整，請重新登入' });
  }

  try {
    // 步驟 A: 先讀取排名與姓名，找出該使用者的列號
    const usersReq = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Roster!A2:B', // Rank, Name
    });

    const rows = usersReq.data.values || [];
    const matchedIndex = rows.findIndex((row) => {
      const rowRank = normalizeRank(row[0]);
      const rowName = normalizeName(row[1]);

      if (targetRank) {
        return rowRank === targetRank;
      }

      return rowName === targetName;
    });

    // 因為範圍從 A2 開始，所以索引 0 對應試算表第 2 列
    const rowIndex = matchedIndex + 2;

    if (matchedIndex === -1) {
      return res.status(404).json({ success: false, error: "查無此人" });
    }

    // 步驟 B: 將志願序轉為 JSON 字串
    const selectionJson = JSON.stringify(preferences);

    // 步驟 C: 更新該列的 E 欄 (Selection)
    // 假設 user 在第 5 列，就要更新 Roster!E5
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Roster!E${rowIndex}`, // 指定寫入位置
      valueInputOption: 'RAW',
      resource: {
        values: [[selectionJson]] // 寫入的內容
      },
    });

    console.log(`已儲存 ${targetName || actorName} 的志願序到第 ${rowIndex} 列`);
    res.json({ success: true });

  } catch (error) {
    console.error('儲存失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});