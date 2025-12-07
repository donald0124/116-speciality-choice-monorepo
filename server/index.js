require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// 允許跨域請求
app.use(cors());
app.use(express.json());

// 設定 Google Sheets 驗證
const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json', // 確保這個檔案在 server 資料夾內
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// ⭐️ 修正 1: 優先讀取環境變數，讀不到就用字串，不要在 function 裡面重複宣告
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1suJb_H1iyAyogMj3ucPJ4vyeoxfAi7MrqGzyMelsVSc';

// API 1: 讀取資料
app.get('/api/data', async (req, res) => {
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
        rank: row[0],
        name: row[1],
        password: row[2],
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
app.post('/api/save', async (req, res) => {
  const { name, preferences } = req.body;
  
  if (!name) {
    return res.status(400).json({ success: false, error: "缺少姓名" });
  }

  try {
    // 步驟 A: 先讀取所有使用者，找出該使用者的「列號 (Row Index)」
    const usersReq = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Roster!B:B', // 只讀取 B 欄 (姓名欄) 來比對
    });

    const rows = usersReq.data.values || [];
    // Google Sheets 列號從 1 開始，且我們讀的是整欄
    // findIndex 找到的是陣列索引 (從 0 開始)，所以要 +1 變成 Sheet 列號
    const rowIndex = rows.findIndex(row => row[0] === name) + 1;

    if (rowIndex === 0) {
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

    console.log(`已儲存 ${name} 的志願序到第 ${rowIndex} 列`);
    res.json({ success: true });

  } catch (error) {
    console.error('儲存失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});