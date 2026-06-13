# Voice Trainer — 優化借鑑筆記

> 記錄本次極致審視中**套用的修正**與**排除的修正**，供未來同類專案參考。
> 產生時間：2026-06-13

---

## ✅ 已套用的修正（9 項）

### 1. Cerebras 120B `content=null` bug（streaming + 非 streaming）
**問題：** Cerebras gpt-oss-120b 在 max_tokens < 400 時回傳 `content: null`，token 放在 `reasoning` 欄位。
```js
// 舊
return res.choices[0]?.message?.content?.trim() || null
// 新
return (res.choices[0]?.message?.content ?? res.choices[0]?.message?.reasoning)?.trim() || null
// streaming 同樣加 ?? delta.reasoning
```
**教訓：** 凡使用 Cerebras gpt-oss-120b，content 與 reasoning 都要加 nullish 合併，streaming 的 delta 也一樣。

---

### 2. Ollama probe 快取（每次分析都 probe 變成每 5 分鐘一次）
**問題：** `callProvider` 在 Ollama 分支每次都做 1s HTTP probe，即使 Ollama 從未啟動，每個 `Promise.all` 都在等它。
```js
// 舊：每次 fetch
// 新：_ollamaOk cache + 300_000ms TTL
async function checkOllama(baseURL) {
  if (Date.now() - _ollamaCheckedAt < 300_000) return _ollamaOk
  ...
}
```
**教訓：** 外部服務可用性探測要快取，避免在 hot path 反覆做連線嘗試。

---

### 3. Qwen3 錯誤排除出 `callProviderFallback`
**問題：** Topic 生成、Coach tip、Session memory 都跳過 Qwen3，fallback 池只剩 2 個 provider。
Qwen3 加了 `reasoning_effort: 'none'` 後速度接近 Groq-Llama，排除無意義。
```js
// 舊：&& p.name !== 'Groq-Qwen3'  ← 刪除
```
**教訓：** reasoning model 加 `reasoning_effort: 'none'` 就和一般 model 行為一致，不需排除出 fallback 池。

---

### 4. Templates 漏網未做 in-memory cache
**問題：** `readTemplates()` 每次都讀磁碟；其他 profile/convs/memories 都有快取，templates 遺漏。
```js
let _templatesCache = undefined  // undefined = not loaded, null = file 不存在
function readTemplates() {
  if (_templatesCache !== undefined) return _templatesCache
  ...
  _templatesCache = normalized
  return _templatesCache
}
function saveTemplates(tmpl) {
  _templatesCache = tmpl  // 寫入時同步更新
  writeJSON(...)
}
```
**教訓：** 加新 data store 時，要對照其他 store 的快取模式確認沒有遺漏。`undefined = not loaded` vs `null = empty` 這個 sentinel pattern 適合此場景。

---

### 5. Template 生成只取最新 10 個樣本
**問題：** `cleanSamples.slice(0, 10)` — convs 是 newest-first，只取 10 個可能都集中在最近練習的類別，生成的模板不均衡。
```js
// 新：每個 category 最多 2 個範例
const exByCategory = {}
for (const s of cleanSamples) {
  if (!exByCategory[s.category]) exByCategory[s.category] = []
  if (exByCategory[s.category].length < 2) exByCategory[s.category].push(s)
}
const examples = Object.values(exByCategory).flat().map(...)
```
**教訓：** 生成模板/摘要時要主動控制類別均衡，不要依賴資料的自然順序。

---

### 6. 寫入端點無任何認證
**問題：** `/api/analyze`、`/api/session/end`、`/api/generate-templates` 等全部公開，任何人可污染 voice profile 或消耗 API key。
```js
const ADMIN_TOKEN = process.env.VOICE_ADMIN_TOKEN || ''
function requireAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next()  // 未設定 = 本機開發模式
  const token = req.headers['x-voice-token'] || req.query.token
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' })
  next()
}
```
前端：localStorage 存 token，`X-Voice-Token` header 帶入所有 mutation 請求。  
**教訓：** 個人工具部署到公開網路一定要加至少一層 token 保護，即使是 `ADMIN_TOKEN = ''` 的 opt-in 設計也好過完全沒有。

---

### 7. Session memory 在關閉視窗時丟失
**問題：** `saveSessionMemory` 只在 tab 切換時觸發，直接關瀏覽器視窗整個 session 記憶遺失。
```js
// 使用 sendBeacon (不受 page teardown 影響)
const onUnload = () => {
  const payload = JSON.stringify({ messages, sessionSamples })
  const endpoint = token ? `${API}/session/end?token=...` : `${API}/session/end`
  navigator.sendBeacon?.(endpoint, new Blob([payload], { type: 'application/json' }))
}
window.addEventListener('beforeunload', onUnload)
```
**教訓：** 需要在頁面關閉時確保發出的請求要用 `sendBeacon`。sendBeacon 不支援自訂 header，token 改用 query param 傳遞。

---

### 8. 分析完成後 1.5 秒才換題
**問題：** `setTimeout(() => loadTopic(category), 1500)` — 沒有意義的延遲，改為立即觸發。
**教訓：** 如果下一步動作不依賴任何 DOM 動畫完成，不要加人工 delay。用 loading state 呈現等待狀態就夠了。

---

### 9. `/api/history` limit 參數上限誤導
**問題：** server 允許 limit=500，但 `writeConvs` 最多存 200 筆，永遠不會回傳超過 200。
改為 `Math.min(..., 200)` 讓行為和文件一致。
**教訓：** API 參數上限要和實際儲存上限對齊，不要讓 caller 以為能拿到更多。

---

## ❌ 排除的修正（5 項，附理由）

### X1. 風格練習 Tab 無 Session Memory
**為何排除：** 風格練習的目的是「感受」不同說話風格，不是在收集使用者的自然風格樣本。若對這類對話也做記憶，需要：
1. 新增 server endpoint（`/api/session/style-end`）
2. 設計不同的 AI prompt 來分析「使用者在模仿某風格時表現如何」
3. 前端區分兩種記憶類型
屬於功能擴充，不是 bug fix。**未來若要加，獨立為一個 feature。**

---

### X2. History Tab 無分頁/虛擬化
**為何排除：** 200 筆 card 在 desktop 上可接受，加 react-virtual 或手動分頁需引入新依賴或大幅重構 UI。目前規模不值得。
**未來閾值：** 超過 500 筆或手機上出現明顯卡頓時再做。

---

### X3. JSON 檔案並發寫入 Race Condition
**為何排除：** 經過仔細分析，**這不是真正的 bug**。
- Node.js 單執行緒模型：JS 不會真正並行執行
- `readProfile()` 和 `writeProfile()` 之間沒有 `await`，屬於同步操作
- 事件迴圈確保一個 request handler 的同步讀改寫段落不會被另一個 handler 插入

如果改用多 worker（cluster）或 async file I/O 才會出現真正的 race condition。目前不需要加 mutex。

---

### X4. CORS 接受所有 Origin
**為何排除：** 這是個人工具，唯一的使用者就是 Boss Tung。限制 CORS 需要在 env 裡寫死 Render URL，每次重新部署 URL 改變就會 break。
**若要修：** 改成從 `VOICE_ALLOWED_ORIGIN` env var 讀取，fallback 到 `*`。

---

### X5. 分析完成的 1.5 秒 UI 過渡動畫已移除
已改為立即換題（修正 #8）。但如果使用者反映「換太快看不清分析結果」，可加回一個短暫的 `opacity: 0 → 1` CSS 動畫，比 setTimeout 更好。
**教訓：** 用 CSS animation 處理視覺過渡，不要用 JS setTimeout 阻塞邏輯。

---

---

### X6（後記）. `useEffect` dep array 引用 `useMemo` 導致 TDZ crash（部署後發現）
**為何排除 → 改為緊急修正：** 修正 #7（beforeunload sendBeacon）加入後，`useEffect(..., [chatHistory, sessionSamples])` 的 dep array 在 function body 執行到這行時就立刻被求值，但 `sessionSamples = useMemo(...)` 宣告在 450 行後面。`const` 的 TDZ 導致生產環境出現 `ReferenceError: Cannot access 'Jn' before initialization`，整個 React app 無法 render（白屏）。
```js
// ❌ 錯誤：useEffect 在 line 271，sessionSamples 在 line 725
useEffect(() => { ... }, [chatHistory, sessionSamples])  // dep array 立刻求值！

// ✅ 修正：把 useEffect 移到 sessionSamples 宣告之後
const sessionSamples = useMemo(...)
useEffect(() => { ... }, [chatHistory, sessionSamples])  // OK
```
**教訓：** React dep array 不是 closure，它是立刻求值的陣列字面值。在 React component function body 裡，`const` 變數在宣告前都在 TDZ。把 `useEffect` 的 dep 包含到比 `useEffect` 本身晚宣告的變數，Vite 打包不會報錯，但瀏覽器 runtime 直接爆炸。rule: **所有 dep array 的變數必須在 `useEffect` 呼叫之前宣告。**

---

## 通用教訓總結

| 模式 | 教訓 |
|------|------|
| **多 provider AI** | 各 provider 的 API quirks（content=null, reasoning field）要在 callProvider 層統一處理，不能期待每個 caller 都知道 |
| **In-memory cache** | 每加一個新 data store 就要問：「我有沒有給它快取？快取失效時機是否正確？」|
| **個人工具部署** | 即使是個人工具，部署到公開 URL 就要加 token auth。opt-in（未設定就開放）的設計兼顧開發便利 |
| **beforeunload** | `fetch` 在 beforeunload 中不可靠；必須用 `sendBeacon`。sendBeacon 不支援自訂 header，token 改走 query param |
| **useEffect dep TDZ** | dep array 是立刻求值的，不是 closure。dep 中的所有變數必須在 `useEffect` 呼叫前已宣告，Vite 不會在 build 時報錯但 runtime 會 crash |
| **AI fallback 策略** | reasoning model + effort=none ≈ 一般 model，不需要從 fallback 池子排除。排除要有明確理由 |
| **參數上限一致性** | API 的 limit/max 參數上限要和實際儲存/查詢上限一致，避免 caller 誤判 |
| **probe 快取** | 任何外部服務的可用性探測都要加快取 TTL，避免在 hot path 反覆做 |
