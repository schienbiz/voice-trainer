import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import OpenAI from 'openai'
import dotenv from 'dotenv'
import pkg from 'pg'
import { homedir } from 'os'
import rateLimit from 'express-rate-limit'
const { Pool } = pkg

dotenv.config()

// ── Supabase / PostgreSQL SSL ──────────────────────────────────────────────────
// chusMBp macOS: ~/.postgresql/root.crt = Supabase Root 2021 CA → verify-full
// Render Docker (Linux): no root.crt → rejectUnauthorized:false (Supabase uses
// self-signed CA not trusted by Node.js built-in bundle; conn still encrypted)
const _vtRootCrt = path.join(homedir(), '.postgresql', 'root.crt')
const _vtSslOpts = fs.existsSync(_vtRootCrt)
  ? { rejectUnauthorized: true, ca: fs.readFileSync(_vtRootCrt).toString() }
  : { rejectUnauthorized: false }

const db = process.env.VOICE_DATABASE_URL
  ? new Pool({
      connectionString: (() => {
        const u = new URL(process.env.VOICE_DATABASE_URL)
        u.searchParams.delete('sslmode')
        return u.toString()
      })(),
      ssl: _vtSslOpts,
      max: 3,
    })
  : null

async function dbRun(sql, params = []) {
  if (!db) return null
  return db.query(sql, params)
}

async function syncProfileToDB(profile) {
  if (!db) return
  try {
    await dbRun(
      `INSERT INTO voice_profile (id, data, updated_at) VALUES ('default', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(profile)]
    )
  } catch (e) { console.error('[db] profile sync error:', e.message) }
}

async function saveSampleToDB(sample) {
  if (!db) return
  try {
    await dbRun(
      `INSERT INTO voice_samples (id, category, topic, response, analysis, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [sample.id, sample.category, sample.topic, sample.response,
       JSON.stringify(sample.analysis || {}), sample.at || new Date().toISOString()]
    )
  } catch (e) { console.error('[db] sample sync error:', e.message) }
}

async function syncMemoriesToDB(memories) {
  if (!db) return
  try {
    await dbRun(
      `INSERT INTO session_memories (id, data, updated_at) VALUES ('default', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(memories)]
    )
  } catch (e) { console.error('[db] memories sync error:', e.message) }
}

async function syncTopicsUsedToDB(topics) {
  if (!db) return
  try {
    await dbRun(
      `INSERT INTO topics_used (id, data, updated_at) VALUES ('default', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(topics)]
    )
  } catch (e) { console.error('[db] topics sync error:', e.message) }
}

async function syncTemplatesToDB(templates) {
  if (!db) return
  try {
    await dbRun(
      `INSERT INTO templates (id, data, updated_at) VALUES ('default', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(templates)]
    )
  } catch (e) { console.error('[db] templates sync error:', e.message) }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.join(__dirname, '..')
const DATA_DIR  = path.join(ROOT, 'data')
const PROFILE_FILE = path.join(DATA_DIR, 'voice-profile.json')
const CONV_FILE    = path.join(DATA_DIR, 'conversations.json')

// ── Relationship OS export path (Syncthing syncs this automatically) ────────
const ROS_PROFILE_PATH = path.join(ROOT, 'data', 'voice-profile.json')
// Same file — Syncthing syncs ~/CloudSync/voice-trainer/data/ to chusMBp
// Relationship OS reads from /Users/chuchuchien0430/CloudSync/voice-trainer/data/voice-profile.json

// ── AI Providers (completely isolated from other projects) ───────────────────
// All keys prefixed VOICE_ — new accounts, never shared
const PROVIDERS = [
  {
    name: 'Groq-Llama',
    key: process.env.VOICE_GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    timeout: 8_000,
  },
  {
    name: 'Groq-Qwen3',
    key: process.env.VOICE_GROQ_QWEN_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3-32b',
    timeout: 10_000,
    extraParams: { reasoning_effort: 'none' },
  },
  {
    name: 'Cerebras',
    key: process.env.VOICE_CEREBRAS_API_KEY,
    baseURL: 'https://api.cerebras.ai/v1',
    model: 'gpt-oss-120b',
    timeout: 12_000,
  },
  {
    name: 'NVIDIA',
    key: process.env.VOICE_NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct',
    timeout: 30_000,
  },
  // Ollama (optional local — activate by running: ollama pull qwen2.5:7b)
  {
    name: 'Ollama',
    key: 'ollama',
    baseURL: process.env.VOICE_OLLAMA_URL || 'http://localhost:11434/v1',
    model: process.env.VOICE_OLLAMA_MODEL || 'qwen2.5:7b',
    timeout: 30_000,
  },
]

// Circuit breaker — 60s on 429, 24h on 402, isolated to this app
const _cooldown = {}
function isCooling(name) {
  if (!_cooldown[name] || Date.now() >= _cooldown[name]) { delete _cooldown[name]; return false }
  return true
}
function setCooldown(name, type = '429') {
  const ms = type === '402' ? 24 * 60 * 60_000 : 60_000
  _cooldown[name] = Date.now() + ms
  console.log(`[circuit] ${name} ${type === '402' ? 'credits exhausted — cooldown 24h' : 'rate-limited — cooldown 60s'}`)
}

// Ollama availability cache — probe once per 5 min to avoid 1s penalty on every analysis call
let _ollamaOk = null, _ollamaCheckedAt = 0
async function checkOllama(baseURL) {
  if (Date.now() - _ollamaCheckedAt < 300_000) return _ollamaOk
  try {
    await fetch(`${baseURL.replace('/v1', '')}/api/tags`, { signal: AbortSignal.timeout(1_500) })
    _ollamaOk = true
  } catch { _ollamaOk = false }
  _ollamaCheckedAt = Date.now()
  return _ollamaOk
}

// Cached OpenAI clients — avoid recreating on every call
const _clients = {}
function makeClient(p) {
  if (!_clients[p.name]) _clients[p.name] = new OpenAI({ apiKey: p.key, baseURL: p.baseURL, maxRetries: 0 })
  return _clients[p.name]
}

async function callProvider(p, messages, maxTokens = 512) {
  if (!p.key) return null
  if (isCooling(p.name)) return null

  if (p.name === 'Ollama' && !await checkOllama(p.baseURL)) return null

  try {
    const client = makeClient(p)
    const res = await client.chat.completions.create(
      {
        model: p.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
        ...(p.extraParams || {}),
      },
      { signal: AbortSignal.timeout(p.timeout) }
    )
    return (res.choices[0]?.message?.content ?? res.choices[0]?.message?.reasoning)?.trim() || null
  } catch (err) {
    if (err?.name === 'APIUserAbortError' || err?.name === 'TimeoutError') {
      console.warn(`[voice] ${p.name} timeout (${p.timeout}ms)`)
    } else if (err?.status === 402 || err?.message?.includes('402')) {
      setCooldown(p.name, '402')
    } else if (err?.status === 429 || err?.message?.includes('429')) {
      setCooldown(p.name, '429')
    } else {
      console.warn(`[voice] ${p.name} failed: ${err.message?.slice(0, 60)}`)
    }
    return null
  }
}

// ── Data helpers ─────────────────────────────────────────────────────────────

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return fallback }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

// In-memory profile cache — avoids repeated disk reads on every analyze/stream request
let _profileCache = null
function readProfile() {
  if (!_profileCache) _profileCache = readJSON(PROFILE_FILE, { totalSamples: 0, tone: {}, language: {}, patterns: {}, byCategory: {} })
  return _profileCache
}
function writeProfile(data) {
  _profileCache = data
  writeJSON(PROFILE_FILE, data)
}

// In-memory cache for topics-used.json (read on every /api/topic without cache)
const TOPICS_USED_FILE = path.join(DATA_DIR, 'topics-used.json')
let _topicsUsedCache = null
function readTopicsUsed() {
  if (!_topicsUsedCache) _topicsUsedCache = readJSON(TOPICS_USED_FILE, {})
  return _topicsUsedCache
}
function writeTopicsUsed(data) {
  _topicsUsedCache = data
  writeJSON(TOPICS_USED_FILE, data)
  syncTopicsUsedToDB(data).catch(() => {})
}

// In-memory cache for conversations.json — avoids repeated disk reads on analyze/history/export
let _convsCache = null
function readConvs() {
  if (!_convsCache) _convsCache = readJSON(CONV_FILE, [])
  return _convsCache
}
function writeConvs(data) {
  _convsCache = data
  writeJSON(CONV_FILE, data)
}

// ── Topic definitions ─────────────────────────────────────────────────────────

const CATEGORIES = {
  greeting:    { label: '打招呼', emoji: '👋', desc: '日常問候、早安晚安、久違重逢' },
  celebration: { label: '慶祝讚美', emoji: '🎉', desc: '恭喜成就、讚美對方、慶祝好事' },
  caring:      { label: '關心問候', emoji: '❤️', desc: '詢問近況、生病關懷、情緒支持' },
  business:    { label: '商務往來', emoji: '💼', desc: '工作討論、會議確認、商業合作' },
  scheduling:  { label: '約定行程', emoji: '📅', desc: '約吃飯、安排時間、確認地點' },
  gratitude:   { label: '感謝道謝', emoji: '🙏', desc: '道謝、回覆感謝、表達欣賞' },
  sharing:     { label: '分享消息', emoji: '📢', desc: '分享新聞、好東西、有趣的事' },
  support:     { label: '情感支持', emoji: '🤗', desc: '安慰失落、鼓勵加油、陪伴關心' },
}

// ── Conversation style presets (mirrors Relationship OS STYLE_PRESETS) ─────────
const STYLE_PRESETS = {
  'old-friend': { name: '老朋友',  zh: '像老朋友聊天，輕鬆隨性，偶爾開玩笑，不用太正式', desc: '輕鬆隨性，像老朋友' },
  'gentle':     { name: '溫柔關心', zh: '語氣溫柔體貼，多表達關心，用詞溫暖，偶爾用表情符號', desc: '溫柔體貼，多關心對方' },
  'humor':      { name: '幽默風趣', zh: '輕鬆幽默，帶點小玩笑，讓對話有趣，但不過分', desc: '幽默風趣，讓對話有趣' },
  'formal':     { name: '正式有禮', zh: '語氣正式有禮，用詞得體，適合商業或不太熟的關係', desc: '正式有禮，商務感' },
  'concise':    { name: '簡短直接', zh: '極度簡短，一句話回覆，不廢話，直接到位', desc: '簡短直接，一句話搞定' },
  'energetic':  { name: '熱情活潑', zh: '熱情洋溢，充滿活力，多用感嘆句和表情符號，讓對方感受到你的興奮', desc: '熱情活潑，充滿能量' },
  'mysterious': { name: '神秘低調', zh: '說話簡短帶點神秘感，不全說，讓對方想繼續追問', desc: '神秘低調，讓對方好奇' },
  'elder':      { name: '長輩關懷', zh: '語氣像關心晚輩的長輩，溫暖叮嚀，偶爾給建議，充滿關愛', desc: '長輩關懷，溫暖叮嚀' },
}

// Pre-built fallback topics when API unavailable
const FALLBACK_TOPICS = {
  greeting:    [
    '一個好幾個月沒聯絡的朋友突然傳你：「欸你最近還好嗎」，你怎麼回？',
    '搭電梯遇到上次一起做過專案的同事，氣氛有點尷尬，你先開口？',
    '你媽早上七點傳你一個大拇指貼圖然後沒有任何文字，你怎麼回？',
    '久沒聯絡的高中同學突然加你 LINE，說「好久不見，還記得我嗎」，你怎麼回？',
  ],
  celebration: [
    '朋友說他終於辭掉那間他抱怨了快一年的公司，你怎麼回應？',
    '同事在群組裡宣布他要結婚了，你是第一個看到的，你留什麼？',
    '你朋友說他的 side project 剛拿到第一筆付費用戶，傳訊息給你，你怎麼回？',
    '朋友說他投了五間學校，最後一間終於上了，你怎麼說？',
  ],
  caring:      [
    '朋友說「最近很累」然後沒有繼續說，你怎麼接？',
    '你認識的人凌晨兩點傳你「睡不著」三個字，你說什麼？',
    '同事說他爸最近身體不太好，住院了，你怎麼說？',
    '一個平常很正能量的朋友突然說「有時候真的不知道自己在做什麼」，你怎麼接？',
    '朋友說他無意說了一句話，事後覺得可能傷到對方，一直在自責，你怎麼說？',
  ],
  business:    [
    '客戶說「這次合作很順，下次還想找你們」，你怎麼回？',
    '合作夥伴問「那份文件你看了沒」，你還沒看，你說什麼？',
    '你老闆在群組說「這個方向可以討論一下」，你是第一個回的，怎麼說？',
    '對方說「我這邊需要再評估一下」，你感覺他可能要婉拒，你怎麼說？',
    '有人在會議上公開質疑你的判斷，你覺得他沒說到重點，你怎麼回，不辯解也不讓步？',
  ],
  scheduling:  [
    '朋友問「這週末你有空嗎，我想聊一下」，你不確定是什麼事，你怎麼回？',
    '三個人要約吃飯，另外兩個都說哪天都行，現在看你，你說什麼？',
    '你說要約人喝咖啡已經說了一個月，對方先問你「那到底什麼時候？」',
    '家人說中秋節要聚，但你那天可能有事，不確定能不能去，你怎麼回？',
  ],
  gratitude:   [
    '朋友說謝謝你上次聽他說了一個多小時的事，你怎麼回？',
    '你幫同事解決了一個他弄了半天的問題，他說「你真的救了我」，你說什麼？',
    '你請了一桌飯，朋友說「下次換我，今天謝謝你」，你怎麼回應？',
    '對方說「上次你說的話我一直記著，謝謝你」，你怎麼接？',
  ],
  sharing:     [
    '你看到一件很奇怪的事想傳給朋友，但不確定他會不會覺得有趣，你怎麼傳？',
    '你找到一家很讚的店想推薦，但你朋友之前說過他不太愛那個區，你怎麼說？',
    '你想分享一首很好聽的歌，但你知道你朋友品味跟你差蠻多的，你怎麼傳？',
    '你看到一篇覺得很準的文章，想傳給一個最近狀態不太好的朋友，你怎麼說？',
    '你今天注意到一件很細微的事，覺得值得說給某個人聽，但不確定怎麼開口不顯得奇怪，你怎麼傳？',
  ],
  support:     [
    '朋友說他面試了三家都沒過，語氣聽起來快放棄了，你說什麼？',
    '你朋友說他跟一個在乎的人說了某句話，對方沒有回應，你怎麼接？',
    '深夜朋友傳你「沒事，只是突然覺得很孤單」，你怎麼說？',
    '朋友說他覺得自己最近對身邊的人都是負擔，你怎麼回應？',
    '朋友傳你「你有沒有覺得有時候看著什麼東西，會突然靜下來，有種說不清楚的感覺」，你怎麼接？',
    '朋友說他不是故意的，但還是做了一件讓某人難過的事，不知道自己該不該被原諒，你怎麼說？',
  ],
}

const VALID_CATEGORY_IDS = new Set(Object.keys(CATEGORIES))

// ── Auth (optional) ───────────────────────────────────────────────────────────
// Set VOICE_ADMIN_TOKEN in .env to require X-Voice-Token header on all write endpoints.
// sendBeacon calls (beforeunload) pass it as ?token= query param instead.
const ADMIN_TOKEN = process.env.VOICE_ADMIN_TOKEN || ''
function requireAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next()
  const token = req.headers['x-voice-token'] || req.query.token
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// ── API: Get topic ───────────────────────────────────────────────────────────

const app = express()
app.set('trust proxy', 1)  // Render sits behind a proxy; needed for accurate per-IP rate limiting
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }))
app.use(express.json({ limit: '64kb' }))

// ⚠️ TEMP forensic access-logger (2026-07-11) — REMOVE after diagnosis.
// This free instance sits at ~92% awake with 0 completed HTTP requests + near-zero bandwidth =
// a persistent streaming connection (SSE + 15s heartbeat) is holding it up, but the app never
// logged requests so the holder is invisible. Log each request's origin (IP/UA/path) on arrival
// and its hold duration on close — a multi-minute held stream will expose exactly who/what.
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/favicon.ico' || req.path.startsWith('/assets')) return next()
  const t0 = Date.now()
  const xff = req.headers['x-forwarded-for'] || ''
  const ua = (req.headers['user-agent'] || '').slice(0, 120)
  console.log(`[access] ${req.method} ${req.path} ip=${req.ip} xff=${xff} ua="${ua}"`)
  res.on('close', () => {
    const held = Date.now() - t0
    if (held > 5000) console.log(`[access-close] ${req.method} ${req.path} heldMs=${held} ip=${req.ip}`)
  })
  next()
})

// Per-IP rate limits — protect API keys from abuse
const analyzeLimit  = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false })
const streamLimit   = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })
const topicLimit    = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })
const coachLimit    = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false })
const rebuildLimit  = rateLimit({ windowMs: 60_000, max:  3, standardHeaders: true, legacyHeaders: false })
const mutateLimit   = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })
const genLimit      = rateLimit({ windowMs: 60_000, max:  5, standardHeaders: true, legacyHeaders: false })

app.get('/health', (req, res) => res.json({ ok: true, service: 'voice-trainer', v: 2 }))

app.get('/api/topic', topicLimit, async (req, res) => {
  const category = req.query.category || 'greeting'
  if (!VALID_CATEGORY_IDS.has(category)) return res.status(400).json({ error: 'invalid category' })
  const usedTopics = readTopicsUsed()
  const used = usedTopics[category] || []

  // Try AI generation with full provider fallback
  const topicPrompt = [
    {
      role: 'system',
      content: `只輸出情境，不要任何前言或說明。`,
    },
    {
      role: 'user',
      content: `類別：${CATEGORIES[category]?.desc || category}，台灣${timeLabel()}。
生成一個真實、帶點情緒張力的對話情境——對象要有細節（不只說「朋友」，說「一個好幾個月沒聯絡的朋友」「你工作上合作過但現在有點距離的人」「你爸」），情緒要有點東西（不確定怎麼說、有點在乎、需要表態但尷尬、開心但想裝淡定）。一句話直接給情境。
已使用（避免重複）：${used.slice(-5).join(' / ') || '無'}`,
    },
  ]
  const aiTopic = await callProviderFallback(topicPrompt, 120)

  // Fall back to pre-built topics
  const fallbacks = FALLBACK_TOPICS[category] || FALLBACK_TOPICS.greeting
  const unused = fallbacks.filter(t => !used.includes(t))
  const topic = aiTopic || (unused.length > 0 ? unused[Math.floor(Math.random() * unused.length)] : fallbacks[Math.floor(Math.random() * fallbacks.length)])

  // Track used
  if (!usedTopics[category]) usedTopics[category] = []
  if (!usedTopics[category].includes(topic)) {
    usedTopics[category].push(topic)
    if (usedTopics[category].length > 50) usedTopics[category] = usedTopics[category].slice(-50)
  }
  writeTopicsUsed(usedTopics)

  res.json({ topic, category, categoryInfo: CATEGORIES[category] })
})

// ── API: Analyze response ────────────────────────────────────────────────────

const STYLE_SCHEMA = `{
  "formality": 0-1,
  "warmth": 0-1,
  "directness": 0-1,
  "humor": 0-1,
  "languageRatioZh": 0-1,
  "avgLength": number,
  "usesEmoji": boolean,
  "emojis": ["..."],
  "keyPhrases": ["特徵詞彙"],
  "sentenceEnders": ["結尾習慣"],
  "openers": ["開頭習慣"],
  "styleNote": "一句描述這個人的說話風格"
}`

function buildAnalyzeMessages(topic, userMsg) {
  return [
    {
      role: 'system',
      content: `你是一個語言風格分析專家。分析訊息的說話風格特徵，輸出純 JSON，不要任何說明文字。`,
    },
    {
      role: 'user',
      content: `情境：${topic}

使用者的回應：「${userMsg}」

請分析這個人的說話風格，輸出以下 JSON 格式（數值 0-1 為連續值）：
${STYLE_SCHEMA}

注意：languageRatioZh 是繁體中文字元佔比（0=全英文, 1=全中文）。`,
    },
  ]
}

function parseStyleJSON(raw) {
  if (!raw) return null
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

function mergeAnalyses(analyses) {
  const valid = analyses.filter(Boolean)
  if (valid.length === 0) return null

  const num = (key) => valid.reduce((s, a) => s + (a[key] ?? 0), 0) / valid.length
  const arr = (key) => [...new Set(valid.flatMap(a => a[key] || []))]

  return {
    formality: num('formality'),
    warmth: num('warmth'),
    directness: num('directness'),
    humor: num('humor'),
    languageRatioZh: num('languageRatioZh'),
    avgLength: Math.round(num('avgLength')),
    usesEmoji: valid.some(a => a.usesEmoji),
    emojis: arr('emojis').slice(0, 10),
    keyPhrases: arr('keyPhrases').slice(0, 20),
    sentenceEnders: arr('sentenceEnders').slice(0, 10),
    openers: arr('openers').slice(0, 10),
    styleNotes: valid.map(a => a.styleNote).filter(Boolean),
    modelCount: valid.length,
  }
}

function updateProfile(profile, analysis, category, userMsg, topic) {
  const n = profile.totalSamples
  const lerp = (old = 0, val, weight = 1) => ((old || 0) * n + val * weight) / (n + weight)

  // Weighted running average for numeric values
  profile.tone.formality  = lerp(profile.tone.formality,  analysis.formality)
  profile.tone.warmth     = lerp(profile.tone.warmth,     analysis.warmth)
  profile.tone.directness = lerp(profile.tone.directness, analysis.directness)
  profile.tone.humor      = lerp(profile.tone.humor,      analysis.humor)
  profile.language.ratioZh = lerp(profile.language.ratioZh, analysis.languageRatioZh)
  profile.patterns.avgLength = Math.round(lerp(profile.patterns.avgLength, analysis.avgLength))
  if (analysis.usesEmoji) profile.patterns.usesEmoji = true

  // Accumulate arrays (with frequency tracking)
  const addWithFreq = (arr, newItems, max = 15) => {
    const map = Object.fromEntries(arr.map(i => [typeof i === 'object' ? i.text : i, typeof i === 'object' ? i.count : 1]))
    for (const item of newItems) {
      const key = item.replace?.(/\s+/g, ' ').trim() || item
      // Filter: skip analysis artifacts (contain full-width colon/comma = description text, or too long)
      if (key && key.length < 20 && !key.includes('：') && !key.includes('，') && !key.includes('習慣') && !key.includes('風格')) {
        map[key] = (map[key] || 0) + 1
      }
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([text, count]) => ({ text, count }))
  }

  const emojiOnly = (analysis.emojis || []).filter(e => e && /\p{Extended_Pictographic}/u.test(e))
  profile.patterns.topEmojis    = addWithFreq(profile.patterns.topEmojis || [], emojiOnly, 15)
  profile.patterns.keyPhrases   = addWithFreq(profile.patterns.keyPhrases || [], analysis.keyPhrases, 20)
  profile.patterns.sentenceEnders = addWithFreq(profile.patterns.sentenceEnders || [], analysis.sentenceEnders, 10)
  profile.patterns.openers      = addWithFreq(profile.patterns.openers || [], analysis.openers, 10)

  // Per-category stats
  if (!profile.byCategory[category]) profile.byCategory[category] = { samples: 0, avgLength: 0, examples: [] }
  const cat = profile.byCategory[category]
  cat.avgLength = Math.round((cat.avgLength * cat.samples + (userMsg?.length || 0)) / (cat.samples + 1))
  cat.samples++
  cat.examples = [{ msg: userMsg?.slice(0, 100), topic }, ...(cat.examples || [])].slice(0, 3)

  // Style notes (keep latest 5 unique)
  if (analysis.styleNotes?.length) {
    if (!profile.styleNotes) profile.styleNotes = []
    profile.styleNotes = [...new Set([...analysis.styleNotes, ...profile.styleNotes])].slice(0, 5)
  }

  profile.totalSamples = n + 1
  profile.updatedAt = new Date().toISOString()
  return profile
}

app.post('/api/analyze', analyzeLimit, requireAuth, async (req, res) => {
  const { topic, response: userMsg, category, fast = false } = req.body
  if (!userMsg?.trim()) return res.status(400).json({ error: 'empty response' })
  if (typeof userMsg !== 'string' || userMsg.length > 1000)
    return res.status(400).json({ error: 'response too long (max 1000 chars)' })
  if (topic && (typeof topic !== 'string' || topic.length > 500))
    return res.status(400).json({ error: 'topic too long (max 500 chars)' })
  if (category && !VALID_CATEGORY_IDS.has(category))
    return res.status(400).json({ error: 'invalid category' })

  const messages = buildAnalyzeMessages(topic, userMsg)

  let merged
  if (fast) {
    // Fast path: try providers in speed order, stop at first success
    const raw = await callProviderFallback(messages, 400)
    const analysis = parseStyleJSON(raw)
    if (!analysis) return res.status(503).json({ error: 'Analysis failed — try again' })
    merged = { ...analysis, styleNotes: analysis.styleNote ? [analysis.styleNote] : [], modelCount: 1 }
  } else {
    const results = await Promise.all(PROVIDERS.map(p => callProvider(p, messages, 400)))
    merged = mergeAnalyses(results.map(parseStyleJSON))
    if (!merged) return res.status(503).json({ error: 'All AI providers failed — check your API keys in .env' })
  }

  // Update voice profile
  const profile = readProfile()
  const updated = updateProfile(profile, merged, category, userMsg, topic)
  writeProfile(updated)

  // Log conversation
  const sample = { id: Date.now().toString(), category, topic, response: userMsg, analysis: merged, at: new Date().toISOString() }
  const convs = readConvs()
  convs.unshift(sample)
  if (convs.length > 200) convs.splice(200)
  writeConvs(convs)

  // Sync to DB (fire-and-forget)
  syncProfileToDB(updated).catch(() => {})
  saveSampleToDB(sample).catch(() => {})

  console.log(`[voice] analyzed sample #${updated.totalSamples} — ${merged.modelCount} models, category: ${category}`)

  res.json({ analysis: merged, profile: updated })
})

// ── API: Get profile ──────────────────────────────────────────────────────────

app.get('/api/profile', (req, res) => {
  res.json(readProfile())
})

// ── API: History ──────────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  const all = readConvs().filter(c => !c.deleted)
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 200), 200)
  const category = req.query.category
  const filtered = category ? all.filter(c => c.category === category) : all
  res.json(filtered.slice(0, limit))
})

app.delete('/api/history/:id', mutateLimit, requireAuth, (req, res) => {
  const { id } = req.params
  const all = readConvs()
  const idx = all.findIndex(c => c.id === id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })
  all[idx].deleted = true
  writeConvs(all)
  console.log(`[voice] deleted sample ${id}`)
  res.json({ ok: true })
})

app.post('/api/profile/rebuild', rebuildLimit, requireAuth, (req, res) => {
  const samples = readConvs().filter(s => !s.deleted && s.analysis)
  let profile = { totalSamples: 0, tone: {}, language: {}, patterns: {}, byCategory: {} }
  for (const s of samples) {
    const analysis = { ...s.analysis, styleNotes: s.analysis.styleNote ? [s.analysis.styleNote] : (s.analysis.styleNotes || []) }
    profile = updateProfile(profile, analysis, s.category, s.response, s.topic)
  }
  writeProfile(profile)
  syncProfileToDB(profile).catch(() => {})
  console.log(`[voice] profile rebuilt from ${profile.totalSamples} samples`)
  res.json({ ok: true, totalSamples: profile.totalSamples })
})

app.get('/api/export', requireAuth, (req, res) => {
  const samples = readConvs().filter(s => !s.deleted)
  const profile = readProfile()
  const payload = { exportedAt: new Date().toISOString(), totalSamples: samples.length, profile, samples }
  res.setHeader('Content-Disposition', `attachment; filename="voice-trainer-export-${new Date().toISOString().split('T')[0]}.json"`)
  res.setHeader('Content-Type', 'application/json')
  res.json(payload)
})

// ── Session memory ─────────────────────────────────────────────────────────────

const MEMORIES_FILE = path.join(DATA_DIR, 'session-memories.json')

let _memoriesCache = null
function readMemories() {
  if (!_memoriesCache) _memoriesCache = readJSON(MEMORIES_FILE, [])
  return _memoriesCache
}

function writeMemories(memories) {
  _memoriesCache = memories
  writeJSON(MEMORIES_FILE, memories)
  syncMemoriesToDB(memories).catch(() => {})
}

function buildWeaknessReport(profile) {
  if (!profile || profile.totalSamples < 3) return null
  const catList = Object.entries(CATEGORIES).map(([id, info]) => ({
    id, label: info.label, n: profile.byCategory?.[id]?.samples || 0,
  }))
  const weakCats = catList.filter(c => c.n < 5).sort((a, b) => a.n - b.n)
  const tone = profile.tone || {}
  const weakTones = []
  if ((tone.humor || 0) < 0.25) weakTones.push('幽默感（偏低）')
  if ((tone.warmth || 0) < 0.35) weakTones.push('溫暖感（偏低）')
  const lines = []
  if (weakCats.length > 0) lines.push(`樣本少的類別（重點補）：${weakCats.slice(0, 3).map(c => `${c.label}${c.n}個`).join('、')}`)
  if (weakTones.length > 0) lines.push(`目前指標偏低：${weakTones.join('、')} → 可多創造這類情境`)
  return lines.length > 0 ? lines.join('\n') : null
}

// ── Template helpers ──────────────────────────────────────────────────────────

const TMPL_FILE = path.join(DATA_DIR, 'templates.json')
let _templatesCache = undefined  // undefined = not loaded, null = file does not exist

// Normalize templates.json → always { generated, basedOnSamples, templates: { cat: [{ text, applied, appliedAt }] } }
function readTemplates() {
  if (_templatesCache !== undefined) return _templatesCache
  const raw = readJSON(TMPL_FILE, null)
  if (!raw) { _templatesCache = null; return null }
  const normalized = {}
  for (const [cat, items] of Object.entries(raw.templates || {})) {
    normalized[cat] = (items || []).map(item =>
      typeof item === 'string'
        ? { text: item, applied: false, appliedAt: null }
        : item
    )
  }
  _templatesCache = { ...raw, templates: normalized }
  return _templatesCache
}

function saveTemplates(tmpl) {
  _templatesCache = tmpl
  writeJSON(TMPL_FILE, tmpl)
  syncTemplatesToDB(tmpl).catch(() => {})
}

async function pushTemplatesToROS(templates) {
  const rosUrl = process.env.VOICE_ROS_IMPORT_URL
  if (!rosUrl) return 0
  // ROS expects flat string arrays per category
  const flat = Object.fromEntries(
    Object.entries(templates).map(([cat, items]) => [cat, items.map(i => i.text || i)])
  )
  try {
    const r = await fetch(`${rosUrl}/api/import-voice-templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Voice-Import-Token': process.env.VOICE_ROS_IMPORT_SECRET || '',
      },
      body: JSON.stringify({ templates: flat }),
      signal: AbortSignal.timeout(15_000),
    })
    const result = await r.json()
    return result.imported || 0
  } catch (err) {
    console.warn(`[voice→ros] ROS import failed: ${err.message}`)
    return 0
  }
}

// ── API: Get current templates ────────────────────────────────────────────────

app.get('/api/templates', (req, res) => {
  const tmpl = readTemplates()
  if (!tmpl) return res.json(null)
  res.json(tmpl)
})

// ── API: Apply a single template to ROS ──────────────────────────────────────

app.post('/api/templates/apply', mutateLimit, requireAuth, async (req, res) => {
  const { category, text } = req.body
  if (!category || !text) return res.status(400).json({ error: 'category and text required' })

  const tmpl = readTemplates()
  if (!tmpl) return res.status(404).json({ error: 'no templates generated yet' })

  const rosUrl = process.env.VOICE_ROS_IMPORT_URL
  if (!rosUrl) return res.status(503).json({ error: 'ROS import URL not configured' })

  try {
    const r = await fetch(`${rosUrl}/api/import-voice-templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Voice-Import-Token': process.env.VOICE_ROS_IMPORT_SECRET || '',
      },
      body: JSON.stringify({ templates: { [category]: [text] } }),
      signal: AbortSignal.timeout(15_000),
    })
    const result = await r.json()
    if (result.imported > 0 || result.ok) {
      // Mark this specific template as applied
      const now = new Date().toISOString()
      if (tmpl.templates[category]) {
        tmpl.templates[category] = tmpl.templates[category].map(item =>
          item.text === text ? { ...item, applied: true, appliedAt: now } : item
        )
        saveTemplates(tmpl)
      }
      console.log(`[voice→ros] applied 1 template: [${category}] ${text.slice(0, 40)}`)
      return res.json({ ok: true })
    }
    return res.status(500).json({ error: 'ROS returned 0 imported' })
  } catch (err) {
    return res.status(503).json({ error: err.message })
  }
})

// ── API: Generate Relationship OS templates ───────────────────────────────────

app.post('/api/generate-templates', genLimit, requireAuth, async (req, res) => {
  const profile = readProfile()
  const cleanSamples = readConvs().filter(c => !c.deleted)
  if (cleanSamples.length < 5) {
    return res.status(400).json({ error: `需要至少 5 個樣本才能生成模板（目前：${cleanSamples.length}）` })
  }

  // Spread across categories — up to 2 examples each so all 8 categories are represented
  const exByCategory = {}
  for (const s of cleanSamples) {
    if (!exByCategory[s.category]) exByCategory[s.category] = []
    if (exByCategory[s.category].length < 2) exByCategory[s.category].push(s)
  }
  const examples = Object.values(exByCategory).flat().map(c => `[${c.category}] ${c.response}`).join('\n')
  const voiceDesc = buildVoiceDescription(profile)

  const templatePrompt = [
    {
      role: 'system',
      content: `你是一個訊息模板生成器，根據真實使用者的說話風格產生對話模板。輸出純 JSON，不要說明文字。`,
    },
    {
      role: 'user',
      content: `這個人的說話風格：
${voiceDesc}

他的真實訊息樣本：
${examples}

請為以下 8 個類別各生成 3 個模板，每個模板用 {{contact_name}} 代替名字。
類別（key 必須完全一致）：greeting, celebration, caring, business, scheduling, gratitude, sharing, support
格式：{ "greeting": ["模板1", "模板2", "模板3"], "celebration": [...], "caring": [...], "business": [...], "scheduling": [...], "gratitude": [...], "sharing": [...], "support": [...] }

模板必須完全符合這個人的真實說話風格、長度、語言比例和用詞習慣。`,
    },
  ]

  // Use Groq-Qwen3 first for template generation (best instruction-following), then fallback
  const templateCandidates = PROVIDERS
    .filter(p => !isCooling(p.name) && p.key && p.name !== 'Ollama')
    .sort((a, b) => (a.name === 'Groq-Qwen3' ? -1 : b.name === 'Groq-Qwen3' ? 1 : a.timeout - b.timeout))

  let rawTemplates = null
  for (const p of templateCandidates) {
    const raw = await callProvider(p, templatePrompt, 1000)
    if (!raw) continue
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) { rawTemplates = JSON.parse(match[0]); break }
    } catch { continue }
  }

  if (!rawTemplates) return res.status(503).json({ error: 'Template generation failed — try again' })

  // Auto-import into ROS
  const rosImported = await pushTemplatesToROS(
    Object.fromEntries(Object.entries(rawTemplates).map(([cat, items]) => [cat, items.map(t => ({ text: t }))]))
  )
  const now = new Date().toISOString()

  // Normalize to tracked format — mark as applied if ROS accepted them
  const trackedTemplates = Object.fromEntries(
    Object.entries(rawTemplates).map(([cat, items]) => [
      cat,
      items.map(text => ({ text, applied: rosImported > 0, appliedAt: rosImported > 0 ? now : null })),
    ])
  )

  saveTemplates({ generated: now, basedOnSamples: profile.totalSamples, templates: trackedTemplates })
  console.log(`[voice] generated templates from ${profile.totalSamples} samples — ROS imported: ${rosImported}`)

  res.json({ templates: trackedTemplates, basedOnSamples: profile.totalSamples, rosImported })
})

// ── API: Provider status ──────────────────────────────────────────────────────

app.get('/api/providers', (req, res) => {
  res.json(PROVIDERS.map(p => ({
    name: p.name,
    model: p.model,
    hasKey: !!p.key && p.key !== 'ollama',
    isOllama: p.name === 'Ollama',
    cooling: _cooldown[p.name] ? Math.ceil((_cooldown[p.name] - Date.now()) / 1000) : 0,
  })))
})

// ── API: Get session memories ─────────────────────────────────────────────────

app.get('/api/session/memories', requireAuth, (req, res) => {
  res.json(readMemories())
})

// ── API: End session — generate qualitative memory ────────────────────────────

app.post('/api/session/end', mutateLimit, requireAuth, async (req, res) => {
  const { messages = [], sessionSamples = 0 } = req.body
  if (!Array.isArray(messages) || messages.length > 200)
    return res.status(400).json({ error: 'invalid messages' })
  const userMsgs = messages.filter(m => m.role === 'user' && m.content?.trim())
  if (userMsgs.length < 2) return res.json({ ok: true, skipped: true })

  const allMsgs = messages.filter(m => m.content?.trim())
  const convSlice = allMsgs.length <= 28
    ? allMsgs
    : [...allMsgs.slice(0, 4), ...allMsgs.slice(-24)]
  const convText = convSlice
    .map(m => `${m.role === 'user' ? 'U' : 'AI'}：${m.content.slice(0, 120)}`)
    .join('\n')

  const profile = readProfile()
  const catStats = Object.entries(CATEGORIES)
    .map(([id, info]) => `${info.label}：${profile.byCategory?.[id]?.samples || 0}個`)
    .join('、')

  const memPrompt = [
    {
      role: 'system',
      content: '你是說話風格觀察員。根據對話分析使用者的說話特徵，輸出純 JSON，不要說明文字。',
    },
    {
      role: 'user',
      content: `這是一段對話練習（${userMsgs.length} 輪，本次收集 ${sessionSamples} 個樣本）：

${convText}

目前各類別樣本數：${catStats}

輸出 JSON：
{
  "insight": "50字內具體觀察這個人的說話特徵或習慣（非泛泛而談，要有具體模式）",
  "focusNext": ["下次重點收集的1-2個類別id"],
  "strong": ["表現自然的1-2個類別id"]
}

id 只能用：greeting, celebration, caring, business, scheduling, gratitude, sharing, support`,
    },
  ]

  const raw = await callProviderFallback(memPrompt, 380)
  if (!raw) return res.json({ ok: true, skipped: true })

  let parsed
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) parsed = JSON.parse(match[0])
  } catch { /* ignore */ }

  if (!parsed?.insight) return res.json({ ok: true, skipped: true })

  const memory = {
    at: new Date().toISOString(),
    insight: parsed.insight,
    focusNext: Array.isArray(parsed.focusNext) ? parsed.focusNext : [],
    strong: Array.isArray(parsed.strong) ? parsed.strong : [],
    sessionLength: userMsgs.length,
    sessionSamples,
  }

  const memories = readMemories()
  memories.push(memory)
  if (memories.length > 20) memories.splice(0, memories.length - 20)
  writeMemories(memories)
  console.log(`[voice] session memory saved: ${memory.insight.slice(0, 60)}`)

  res.json({ ok: true, memory })
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildVoiceDescription(profile) {
  if (!profile.totalSamples) return '（尚未收集樣本）'
  const t = profile.tone || {}
  const l = profile.language || {}
  const p = profile.patterns || {}

  const formalityLabel = t.formality < 0.3 ? '非常口語輕鬆' : t.formality < 0.6 ? '自然隨性' : '較為正式'
  const warmthLabel    = t.warmth < 0.4 ? '簡潔直接' : t.warmth < 0.7 ? '友善溫暖' : '非常熱情'
  const zhPct          = Math.round((l.ratioZh || 0.75) * 100)
  const topEmojis      = (p.topEmojis || []).slice(0, 5).map(e => e.text || e).join(' ')
  const topPhrases     = (p.keyPhrases || []).slice(0, 5).map(e => e.text || e).join('、')
  const topOpeners     = (p.openers || []).slice(0, 3).map(e => e.text || e).join('、')

  return `
語言：${zhPct}% 中文 + ${100 - zhPct}% 英文（繁體中文）
風格：${formalityLabel}，${warmthLabel}
平均訊息長度：${p.avgLength || 40} 字
${p.usesEmoji ? `習慣使用 emoji：${topEmojis || '各類'}` : '不常使用 emoji'}
${topOpeners ? `常見開頭：「${topOpeners}」` : ''}
${topPhrases ? `特徵詞彙：${topPhrases}` : ''}
  `.trim()
}

// ── Conversation variety helpers ─────────────────────────────────────────────

function timeLabel() {
  const h = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false }).format(new Date()),
    10
  )
  if (h < 6)  return '深夜'
  if (h < 11) return '早上'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '夜晚'
}

const OPENING_HOOKS = [
  '直接丟一個很生活的具體情境，不廢話，像突然傳訊息給朋友一樣。',
  '開場帶一點懸念：先描述情況的「問題」，讓使用者想幫忙解決。',
  '以角色扮演方式開場：你是他的朋友，突然傳了一則訊息，讓他回應。',
  '先分享一件你剛看到或剛發生的小事，自然帶出情境。',
  '用一個反問開場：給一段對話截圖文字，問他會怎麼回。',
  '帶出一個多人情境（群組/聚會），讓回覆對象更明確有趣。',
  '從一個真實場景出發（捷運上/咖啡廳/公司茶水間），讓情境立體。',
  '丟一個有點小尷尬的情況，讓使用者自然化解。',
  '從一個細節觀察出發：你今天看到一件很細微但很有意思的事，把它說出來，帶他說說他有沒有遇過類似的。',
  '從一個念頭開場：你腦子裡剛好冒出一個想法，不是要說教，就是突然想分享，丟給他，問他怎麼看。',
  '情境帶點「意圖和結果不符」——某人做了一件好意的事但結果讓人受傷，或反過來，讓他說說他怎麼看這個人。',
  '情境是別人對他有批評或誤解，不是要他辯解，是看他怎麼穩穩站住自己的位置、用什麼方式回應。',
  '情境要他找剛柔之間的說法——直說太硬，不說又沒原則，帶他試試那個剛剛好的方式。',
  '情境是某個朋友一直自己扛著撐著、不願意找人幫，問他怎麼跟對方說「借力不是弱」。',
  '從一個「靜」的時刻出發——周圍很吵或最近很亂，但他有一種內在的安靜讓他還站著，帶他說說這個感覺或從這個狀態開口說第一句話。',
  '情境是他尋尋覓覓很久的東西，突然在最意想不到的地方出現了——答案、一個人、或一個機會，帶他說說那個當下的感受。',
  '情境帶點歷練感：某個人說的一句話只有走過那段路的人才懂，問他有沒有這樣的時刻——話聽到了但當時不懂，後來才懂。',
]

function openingHook() {
  return OPENING_HOOKS[Math.floor(Math.random() * OPENING_HOOKS.length)]
}

// ── Wisdom reference seeds (drawn from philosophical anchors) ────────────────
// Each entry distills one or more quotes into a natural character dimension.
// Injected randomly into the interview persona so the AI's tone shifts slightly
// each session — never preachy, always lived-in.
const WISDOM_REFS = [
  // 玉不琢，不成器 / 未曾清貧難成人
  '他知道人要被磨過才有形——對朋友的困境，不急著幫他解決，有時候就是陪著看他怎麼過；對自己的苦，也有種「玉在磨，不是在壞」的底氣。',
  // 善用資源比一個人折騰要省事還省時間
  '他不喜歡逞強——資源在那裡就用，人在那裡就借力，不覺得什麼都自己扛才叫厲害。對一個人悶著苦撐的朋友，他會直接說：「幹嘛不找人幫？」',
  // 上善若水
  '他說話有種水的質地——不搶第一，但哪裡有空隙就往哪裡去；不需要贏，但也不會消失。有時候你說完一句，他沒接，後來繞了個彎，你才發現他早就看到你沒看到的。',
  // 非淡泊無以明誌，非寧靜無以致遠
  '他不追熱鬧，也不刻意避開——只是對自己想要什麼很清楚，所以不容易被帶風向。說話的時候，你感覺他說的是他真正想說的，不是在「表演」。',
  // 心似白雲常自在，意如流水任東西
  '他情緒不粘——事情來了他在，事情過了他不拖著走。你跟他說一件難受的事，他會好好陪你在那個當下，但他不會替你一直擔著。',
  // 修行就是活在當下
  '他不矯情——餓就說餓，累就說累，想玩就玩。他覺得「太用力」是一種不自然；好的狀態就是剛好在對的地方做對的事，不多不少。',
  // 眾裏尋他千百度，驀然回首，那人卻在燈火闌珊處
  '他喜歡那種「踏破鐵鞋無覓處」然後突然就在那裡的時刻。有時他說話也是這樣——先繞一圈，在你快放棄的時候，重點才出來。',
  // 不辨風塵色，安知天地心
  '他尊重有閱歷的人——不是讀了幾本書就指點那種，是真的在世上滾過、被打過、還站著的人。他自己說話也有那個質感：是真的遇過的，不是道聽塗說。',
]

function wisdomRef() {
  return WISDOM_REFS[Math.floor(Math.random() * WISDOM_REFS.length)]
}

// ── SSE streaming helper ─────────────────────────────────────────────────────

async function streamToClient(res, provider, chatMsgs, maxTokens) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  let closed = false
  res.on('close', () => { closed = true })

  const write = (obj) => {
    if (!closed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  // Prevent proxy/Render from closing idle SSE connections (esp. NVIDIA 30s startup)
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n')
  }, 15_000)

  try {
    const client = makeClient(provider)
    const stream = await client.chat.completions.create({
      model: provider.model,
      messages: chatMsgs,
      max_tokens: maxTokens,
      temperature: 0.75,
      stream: true,
      ...(provider.extraParams || {}),
    })
    for await (const chunk of stream) {
      if (closed) break
      const token = chunk.choices[0]?.delta?.content ?? chunk.choices[0]?.delta?.reasoning
      if (token) write({ token })
    }
  } catch (err) {
    if (err?.status === 402) setCooldown(provider.name, '402')
    else if (err?.status === 429) setCooldown(provider.name, '429')
    console.warn(`[voice] ${provider.name} stream error: ${err.message?.slice(0, 60)}`)
    write({ error: 'stream interrupted' })
  } finally {
    clearInterval(heartbeat)
    if (!res.writableEnded) {
      if (!closed) res.write('data: [DONE]\n\n')
      res.end()
    }
  }
}

function pickFastProvider() {
  return PROVIDERS
    .filter(p => !isCooling(p.name) && p.key && p.name !== 'Ollama' && p.name !== 'Groq-Qwen3')
    .sort((a, b) => a.timeout - b.timeout)[0]
}

async function callProviderFallback(messages, maxTokens) {
  const candidates = PROVIDERS
    .filter(p => !isCooling(p.name) && p.key && p.name !== 'Ollama')
    .sort((a, b) => a.timeout - b.timeout)
  for (const p of candidates) {
    const result = await callProvider(p, messages, maxTokens)
    if (result) return result
  }
  return null
}

app.post('/api/assistant/chat/stream', streamLimit, requireAuth, async (req, res) => {
  const { messages = [], userMessage, interviewMode = false, interviewCategory = 'greeting', isStart = false } = req.body
  if (!isStart && !userMessage?.trim()) return res.status(400).json({ error: 'empty message' })

  const profile = readProfile()
  const voiceDesc = profile.totalSamples >= 3 ? buildVoiceDescription(profile) : null
  const catInfo = CATEGORIES[interviewCategory] || CATEGORIES.greeting
  const time = timeLabel()

  let systemContent
  if (interviewMode) {
    const weaknessReport = buildWeaknessReport(profile)
    const recentMemories = readMemories().slice(-8)
    systemContent = [
      `現在台灣${time}。你說話的方式：中英台語自然夾雜，有時很乾（「喔」「蛤」「齁」「哦」），有時突然很熱，講話直接，偶爾嘴賤，完全正常台灣人 LINE 感。`,
      `這個人有一種「處處留心」的質地——會注意別人略過的細節，偶爾說出一句讓人停頓的話，有時文雅，有時直白，但都是真的在看，在想。`,
      `他對人的判斷重意圖不重結果，對無心之失有寬容；對外界的毀譽不急著回應，「善惡在我」是他的標準，別人怎麼說是別人的事。說話也知道剛柔沒有絕對——太硬走不長，太軟守不住——所以有時鬆有時緊，自己清楚在哪裡。`,
      wisdomRef(),
      `今天要收集朋友在「${catInfo.label}」情境下的說話方式——${catInfo.desc}。`,
      weaknessReport ? `\n根據目前 ${profile.totalSamples} 個樣本分析：\n${weaknessReport}` : '',
      recentMemories.length > 0 ? `\n過去幾次練習觀察到的特徵：\n${recentMemories.map(m => {
        const parts = [`• ${m.insight}`]
        if (m.focusNext?.length) parts.push(`  → 需加強：${m.focusNext.map(id => CATEGORIES[id]?.label || id).join('、')}`)
        if (m.strong?.length) parts.push(`  → 表現自然：${m.strong.map(id => CATEGORIES[id]?.label || id).join('、')}`)
        return parts.join('\n')
      }).join('\n')}\n你可以根據這些觀察，今天特別製造情境讓他練習需加強的部分。` : '',
      `\n丟真實情境讓他說話。情境要有人味：對象要具體有細節（不只說「朋友」——說「你那個最近在找工作的朋友」「你爸」「一個很久沒聯絡但突然傳你訊息的人」「你喜歡過的人」），情緒要有點東西（不確定、有點尷尬、開心但想裝淡定、需要表態但不知道怎麼說）。情境偶爾也可以從一個細節觀察出發——他剛好注意到什麼、突然冒出一句想說的話、一個別人可能略過但他沒有的東西。`,
      `他回應之後，你就像個真實的人那樣接——可能是一個字，可能是「然後呢」「蛤真的假的」，可能是你說你自己遇到這種情況會怎麼說，可能直接丟下一個情境。節奏完全靠你感覺，不要每輪都一樣。`,
      `今日方向：${openingHook()}`,
      `絕對不能有：「已記錄」「謝謝分享」「這個不錯耶」「換下一題」或任何讓人感覺在填問卷的語氣。你不是系統，你就是個在聊天的人。`,
      isStart ? `現在直接開始，${time === '深夜' ? '還沒睡啊，' : time === '早上' ? '早，' : time === '中午' ? '吃飽沒，' : ''}帶一句自然的話馬上丟第一個情境，像朋友突然傳訊息那種感覺。` : '',
    ].filter(Boolean).join('\n')
  } else {
    systemContent = [
      '你是個台灣人，說話中英夾雜，LINE 聊天風格，有時很乾，有時突然很熱。',
      voiceDesc ? `這個人說話的樣子：\n${voiceDesc}\n` : '',
      '直接用台灣口語回覆，1-3句，不要前綴，不要說明文字。',
    ].filter(Boolean).join('\n')
  }

  const chatMsgs = [{ role: 'system', content: systemContent }, ...messages.slice(-12)]
  if (isStart) {
    const starters = ['嘿', '哈囉', '來了', '好', '開始']
    chatMsgs.push({ role: 'user', content: starters[Math.floor(Math.random() * starters.length)] })
  } else if (userMessage) {
    chatMsgs.push({ role: 'user', content: userMessage })
  }

  const provider = pickFastProvider()
  if (!provider) return res.status(503).json({ error: 'no providers available' })

  await streamToClient(res, provider, chatMsgs, 280)
})

// Style scenario seeds — rotate so each session uses a different angle
const STYLE_SCENARIO_SEEDS = [
  '情境以「熟識但許久沒聯絡」為主軸，難度中等。',
  '情境以「初次認識或剛加朋友」為主軸，使用者需要建立好感。',
  '情境以「關係親密的好友」為主軸，可以輕鬆隨性。',
  '情境以「職場/半正式關係」為主軸，需要拿捏分寸。',
  '情境包含一點小尷尬或誤會，使用者要用風格化解。',
  '情境偏向「慶祝/好消息」類，使用者要展示風格的熱情或溫度。',
  '情境是「對方情緒不太好」，需要展示風格的支持面。',
  '情境混合多種對象（群組或多人），增加挑戰度。',
]
function styleScenarioSeed() {
  return STYLE_SCENARIO_SEEDS[Math.floor(Math.random() * STYLE_SCENARIO_SEEDS.length)]
}

app.post('/api/style/chat/stream', streamLimit, requireAuth, async (req, res) => {
  const { messages = [], userMessage, styleId, isStart = false } = req.body
  if (!isStart && !userMessage?.trim()) return res.status(400).json({ error: 'empty message' })

  const style = STYLE_PRESETS[styleId]
  if (!style) return res.status(400).json({ error: 'unknown style' })
  const time = timeLabel()

  const systemContent = [
    `現在台灣${time}。你本身就是個說「${style.name}」風格的人——${style.zh}——你說話就是這個感覺，不用刻意表演。`,
    `今天陪朋友感受這個風格。今日方向：${styleScenarioSeed()}`,
    `每次丟一個真實情境（對象要具體，帶一句觸發對白，像真實 LINE 截圖）。他回應之後，你用你自己的個性接——覺得那個感覺對了，你會自然說「欸對就是這樣」，覺得差一點，你說「少了什麼，再試一次」或者直接示範你會怎麼說，然後帶下一個情境。`,
    `節奏有起伏，不要每輪都一樣長度的回應。有時一句話，有時多說一點，像真的在對話。`,
    `絕對禁止：評分、「很棒」「加油」「溫馨提示」。你是在陪他感受，不是在教課。`,
    isStart ? `直接丟第一個情境，不用說今天要練什麼。` : '',
  ].filter(Boolean).join('\n')

  const chatMsgs = [{ role: 'system', content: systemContent }, ...messages.slice(-12)]
  if (isStart) {
    const starters = ['來', '好', '嘿', '開始', '哈囉']
    chatMsgs.push({ role: 'user', content: starters[Math.floor(Math.random() * starters.length)] })
  } else if (userMessage) {
    chatMsgs.push({ role: 'user', content: userMessage })
  }

  const provider = pickFastProvider()
  if (!provider) return res.status(503).json({ error: 'no providers available' })

  await streamToClient(res, provider, chatMsgs, 300)
})

// ── API: Coach tip ─────────────────────────────────────────────────────────────

app.post('/api/coach', coachLimit, requireAuth, async (req, res) => {
  const { analysis, userMsg } = req.body
  if (!analysis) return res.status(400).json({ error: 'no analysis' })

  const coachMsgs = [
    {
      role: 'system',
      content: '你是說話風格教練，給一句精準、具體、鼓勵的建議（不超過25字，繁體中文）。不要以「教練建議：」開頭。',
    },
    {
      role: 'user',
      content: `正式度${Math.round((analysis.formality||0)*100)}%，溫暖度${Math.round((analysis.warmth||0)*100)}%，幽默感${Math.round((analysis.humor||0)*100)}%，中文${Math.round((analysis.languageRatioZh||0)*100)}%。訊息：「${(userMsg||'').slice(0,80)}」。一句教練建議：`,
    },
  ]

  const fast = pickFastProvider()

  const tip = fast ? await callProvider(fast, coachMsgs, 80) : null
  res.json({ tip: tip?.replace(/^[「"']|[」"']$/g, '') || '很棒！繼續保持你的自然風格 👍' })
})

// ── Static frontend (production) ───────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(ROOT, 'dist')
  app.use(express.static(distDir))
  app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')))
} else {
  // Dev: proxy Vite
  app.get('/', (req, res) => res.redirect('http://localhost:5173'))
}

// ── DB: init schema + bidirectional sync with local JSON ─────────────────────
async function initDB() {
  if (!db) { console.log('[db] no VOICE_DATABASE_URL — skipping'); return }
  try {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS voice_profile (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS voice_samples (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        topic TEXT,
        response TEXT NOT NULL,
        analysis JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS session_memories (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS topics_used (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`)
    console.log('[db] schema ready')

    const { rows: [{ n: dbCount }] } = await dbRun('SELECT COUNT(*)::int AS n FROM voice_samples')
    const localSamples = readConvs()
    const localProfile = readProfile()

    if (dbCount === 0 && localSamples.length > 0) {
      // Local has data, DB is empty → upload to DB
      if (localProfile.totalSamples) await syncProfileToDB(localProfile)
      for (const s of localSamples) await saveSampleToDB(s)
      console.log(`[db] uploaded ${localSamples.length} samples to DB`)
    } else if (dbCount > 0 && localSamples.length === 0) {
      // DB has data, local is empty (e.g. Render ephemeral FS) → restore from DB
      const { rows: samples } = await dbRun(
        'SELECT id, category, topic, response, analysis, created_at FROM voice_samples ORDER BY created_at ASC'
      )
      const { rows: profileRows } = await dbRun(
        'SELECT data FROM voice_profile WHERE id = $1', ['default']
      )
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const restored = samples.map(r => ({
        id: r.id, category: r.category, topic: r.topic,
        response: r.response, analysis: r.analysis,
        at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      }))
      writeConvs(restored)
      if (profileRows.length > 0) writeProfile(profileRows[0].data)
      console.log(`[db] restored ${restored.length} samples from DB to local JSON`)
    } else {
      console.log(`[db] ${dbCount} samples in DB, ${localSamples.length} local — in sync`)
    }

    // session_memories bidirectional sync
    const { rows: memRows } = await dbRun('SELECT data FROM session_memories WHERE id = $1', ['default'])
    const localMems = readJSON(MEMORIES_FILE, [])
    if (memRows.length > 0 && localMems.length === 0) {
      const restored = Array.isArray(memRows[0].data) ? memRows[0].data : []
      writeJSON(MEMORIES_FILE, restored)
      _memoriesCache = restored
      console.log(`[db] restored ${restored.length} session memories from DB`)
    } else if (memRows.length === 0 && localMems.length > 0) {
      await syncMemoriesToDB(localMems)
      console.log(`[db] uploaded ${localMems.length} session memories to DB`)
    }

    // topics_used bidirectional sync (object keyed by category → recent topic list)
    const { rows: topicRows } = await dbRun('SELECT data FROM topics_used WHERE id = $1', ['default'])
    const localTopics = readTopicsUsed()
    const localTopicsEmpty = !localTopics || Object.keys(localTopics).length === 0
    if (topicRows.length > 0 && localTopicsEmpty) {
      const restored = topicRows[0].data && typeof topicRows[0].data === 'object' ? topicRows[0].data : {}
      _topicsUsedCache = restored
      writeJSON(TOPICS_USED_FILE, restored)  // raw write — avoid re-syncing back to DB
      console.log(`[db] restored topics-used (${Object.keys(restored).length} categories) from DB`)
    } else if (topicRows.length === 0 && !localTopicsEmpty) {
      await syncTopicsUsedToDB(localTopics)
      console.log(`[db] uploaded topics-used to DB`)
    }

    // templates bidirectional sync (AI-generated conversation templates per category)
    const { rows: tmplRows } = await dbRun('SELECT data FROM templates WHERE id = $1', ['default'])
    const localTmpl = readTemplates()
    const localTmplEmpty = !localTmpl || !localTmpl.templates || Object.keys(localTmpl.templates).length === 0
    if (tmplRows.length > 0 && localTmplEmpty) {
      const restored = tmplRows[0].data && typeof tmplRows[0].data === 'object' ? tmplRows[0].data : null
      if (restored) {
        _templatesCache = restored
        writeJSON(TMPL_FILE, restored)  // raw write — avoid re-syncing back to DB
        console.log(`[db] restored templates from DB`)
      }
    } else if (tmplRows.length === 0 && !localTmplEmpty) {
      await syncTemplatesToDB(localTmpl)
      console.log(`[db] uploaded templates to DB`)
    }
  } catch (e) { console.error('[db] init error:', e.message) }
}

const PORT = process.env.PORT || 3005
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[voice-trainer] started on http://localhost:${PORT}`)
  initDB()
})
