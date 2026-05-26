# Voice Trainer — 工作紀錄

## 2026-05-24　建立完成

### 背景與目的

**需求：** 建立一個能收集 ATung 個人對話方式的 AI 工具，讓 Relationship OS 的 AI agent 在與聯絡人對話時能夠模仿真實的說話風格，而不是制式 AI 語氣。

**核心問題：** Relationship OS 的 groqAgent 建議的訊息太像 AI 寫的，不像真人在傳訊息。需要先收集使用者的真實對話樣本，建立「語音指紋」，再注入到 AI 提示詞中。

---

### 架構決策

| 問題 | 決定 | 原因 |
|------|------|------|
| 在哪跑？ | ATung 本地（port 3005） | 互動式訓練工具，不需 24/7，本地資料更私密 |
| API keys？ | 全部新帳號，`VOICE_` prefix | 完全獨立，不與其他 4 個專案混用 |
| 如何同步到 Relationship OS？ | Syncthing 自動同步 | `~/CloudSync/voice-trainer/data/` 已在 Syncthing 同步路徑內 |
| 資料庫？ | JSON 檔案 | 樣本數量有限（預計 50-200），不需 DB overhead |

---

### 建立的檔案

#### Voice Trainer (`~/CloudSync/voice-trainer/`)

| 檔案 | 說明 |
|------|------|
| `server/index.js` | Express 後端：話題生成、多模型並行分析、profile 累積、模板生成 |
| `src/App.jsx` | React 前端：8 類別訓練介面、風格報告、歷史記錄、ROS 模板 |
| `src/index.css` | 深色主題樣式 |
| `src/main.jsx` | React entry point |
| `index.html` | HTML shell |
| `vite.config.js` | Vite 設定（dev proxy → 3005） |
| `package.json` | Node.js 專案設定 |
| `data/voice-profile.json` | 收集到的風格資料（Syncthing 同步） |
| `.env.example` | API key 範本（4 個服務說明） |
| `.env` | 實際 keys（.gitignore 中） |
| `.gitignore` | 排除 .env、conversations、node_modules |
| `dist/` | Vite 建置輸出（npm run build 產生） |

#### Relationship OS（`~/relationship-os/src/`）

| 檔案 | 說明 |
|------|------|
| `lib/voiceProfile.ts` | 讀取 voice-profile.json，提供 `getVoiceStylePrompt()` |
| `ai/agents/groqAgent.ts` | 新增：import voiceProfile，注入風格 hint 到 prompt |

---

### AI 模型配置

**5 個模型並行分析（全部獨立帳號）：**

| 名稱 | 供應商 | 模型 | Timeout | 用途 |
|------|--------|------|---------|------|
| Groq-Llama | Groq | llama-3.3-70b-versatile | 8s | 主要分析 + 話題生成 |
| Groq-Qwen3 | Groq | qwen/qwen3-32b | 10s | 中文特化分析 |
| Cerebras | Cerebras | gpt-oss-120b | 12s | 超快交叉驗證 |
| NVIDIA | NVIDIA NIM | meta/llama-3.3-70b-instruct | 30s | 深度分析（Gemini 無免費 API 故改用） |
| OpenRouter | OpenRouter | openai/gpt-oss-120b:free | 20s | 推理模型多樣性 |
| Ollama | 本地 | qwen2.5:7b（選用） | 30s | 離線私密推理 |

**Circuit breaker：** 429 → 60s cooldown，與其他專案完全分開的 `_cooldown` map。

---

### 資料流

```
使用者回應訊息
     ↓
buildAnalyzeMessages(topic, userMsg)
     ↓
5 個 AI 模型並行分析（callProvider × 5）
     ↓
mergeAnalyses() — 取各模型數值平均，union 陣列
     ↓
updateProfile() — 滾動平均更新 voice-profile.json
     ↓
data/voice-profile.json（Syncthing 自動同步）
     ↓
chusMBp：~/CloudSync/voice-trainer/data/voice-profile.json
     ↓
voiceProfile.ts：getVoiceStylePrompt(compact=true)
     ↓
groqAgent.ts：注入 compact hint 到提示詞
```

---

### Voice Profile 資料結構

```json
{
  "totalSamples": 47,
  "tone": {
    "formality": 0.25,
    "warmth": 0.82,
    "directness": 0.61,
    "humor": 0.43
  },
  "language": {
    "primaryScript": "traditional_chinese",
    "mixing": "inline_english",
    "ratioZh": 0.74
  },
  "patterns": {
    "avgLength": 38,
    "usesEmoji": true,
    "topEmojis": [{"text":"😊","count":12}, ...],
    "keyPhrases": [{"text":"沒問題","count":8}, ...],
    "sentenceEnders": [{"text":"喔","count":15}, ...],
    "openers": [{"text":"嗯","count":9}, ...]
  },
  "byCategory": {
    "greeting": { "samples": 10, "avgLength": 22, "examples": [...] }
  },
  "styleNotes": ["說話輕鬆口語，習慣中英混用", "..."],
  "updatedAt": "2026-05-24T..."
}
```

---

### API 端點

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/topic?category=greeting` | 取得下一個訓練話題 |
| POST | `/api/analyze` | 提交回應，觸發多模型分析 |
| GET | `/api/profile` | 取得目前 voice profile |
| GET | `/api/history?limit=20&category=...` | 歷史訓練記錄 |
| POST | `/api/generate-templates` | 生成 Relationship OS 模板 |
| GET | `/api/providers` | 各 AI provider 狀態 |

---

### 注意事項 / 已知限制

1. **API keys 佔位符：** 目前 `.env` 有佔位符值，需填入真實 key 才能使用 AI 分析功能。未填 key 時自動使用預建話題（不影響話題提供），但分析功能無法使用。

2. **Ollama 選用：** `ollama` 未安裝，server 會在每次分析時嘗試連線 `localhost:11434`，失敗時靜默跳過（`AbortSignal.timeout(1000)`）。安裝 Ollama 後自動啟用。

3. **hasKey 顯示：** 前端 provider 狀態顯示 `hasKey: true` 是因為 `.env` 有字串值（即使是佔位符）。填入真實 key 並重啟後功能正常。

4. **Syncthing 路徑：** `voice-profile.json` 在 `~/CloudSync/voice-trainer/data/`，Syncthing 已設定此目錄同步，chusMBp 上的路徑相同。

5. **最少樣本：** `generate-templates` 需要至少 5 個樣本；建議每類別 10 個（共 80 個）才能得到高品質模板。

---

### 後續可改進

- [ ] 填入真實 API keys（新帳號）
- [ ] 安裝 Ollama：`brew install ollama && ollama pull qwen2.5:7b`
- [ ] 收集 80 個樣本（8 類別 × 10 個）
- [ ] 執行「套用到 Relationship OS」生成模板
- [ ] 考慮：將 voiceProfile 也注入到 geminiAgent（策略分析）
- [ ] 考慮：語音輸入（Groq Whisper API，免費）

---

### Git

- **Voice Trainer repo：** `~/CloudSync/voice-trainer/`（本地 git，尚未推到 GitHub）
- **Relationship OS：** commit `84edc2c`，已推到 GitHub (`texergydynamics-svg/relationship-os`)
