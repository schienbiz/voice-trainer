import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import OpenAI from 'openai'
import dotenv from 'dotenv'
import pkg from 'pg'
import { homedir } from 'os'
const { Pool } = pkg

dotenv.config()

// ── CockroachDB ───────────────────────────────────────────────────────────────
// Use CA cert if present (~/.postgresql/root.crt). Needed on macOS Monterey
// (chusMBp) which doesn't trust CockroachDB's intermediate CA by default.
// Strip sslmode from URL — pg driver's URL sslmode overrides the ssl config
// object and prevents the ca cert from being applied.
const _vtRootCrt = path.join(homedir(), '.postgresql', 'root.crt')
const _vtSslOpts = fs.existsSync(_vtRootCrt)
  ? { rejectUnauthorized: true, ca: fs.readFileSync(_vtRootCrt).toString() }
  : { rejectUnauthorized: true }

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
  const client = await db.connect()
  try { return await client.query(sql, params) }
  finally { client.release() }
}

async function syncProfileToNeon(profile) {
  if (!db) return
  try {
    await dbRun(
      `INSERT INTO voice_profile (id, data, updated_at) VALUES ('default', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(profile)]
    )
  } catch (e) { console.error('[db] profile sync error:', e.message) }
}

async function saveSampleToNeon(sample) {
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
    model: 'llama-3.3-70b-versatile',
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
  {
    name: 'OpenRouter',
    key: process.env.VOICE_OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-oss-120b:free',
    timeout: 20_000,
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

// Cached OpenAI clients — avoid recreating on every call
const _clients = {}
function makeClient(p) {
  if (!_clients[p.name]) _clients[p.name] = new OpenAI({ apiKey: p.key, baseURL: p.baseURL, maxRetries: 0 })
  return _clients[p.name]
}

async function callProvider(p, messages, maxTokens = 512) {
  if (!p.key) return null
  if (isCooling(p.name)) return null

  // Check if Ollama is available (skip if not running)
  if (p.name === 'Ollama') {
    try {
      await fetch(`${p.baseURL.replace('/v1', '')}/api/tags`, { signal: AbortSignal.timeout(1000) })
    } catch {
      return null  // Ollama not running — skip silently
    }
  }

  let done = false
  try {
    const client = makeClient(p)
    return await Promise.race([
      (async () => {
        const res = await client.chat.completions.create({
          model: p.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.3,
          ...(p.extraParams || {}),
        })
        done = true
        return res.choices[0]?.message?.content?.trim() || null
      })(),
      new Promise(resolve => setTimeout(() => { if (!done) console.warn(`[voice] ${p.name} timeout`); resolve(null) }, p.timeout)),
    ])
  } catch (err) {
    done = true
    if (err?.status === 402 || err?.message?.includes('402')) setCooldown(p.name, '402')
    else if (err?.status === 429 || err?.message?.includes('429')) setCooldown(p.name, '429')
    console.warn(`[voice] ${p.name} failed: ${err.message?.slice(0, 60)}`)
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
  greeting:    ['你的老朋友突然傳訊息給你：「最近好嗎？好久沒聯絡了！」你怎麼回？', '早上上班路上遇到同事，你們在電梯裡，你會怎麼打招呼？', '週末睡醒看到家人傳來早安訊息，你怎麼回應？'],
  celebration: ['同事剛升職，在群組裡分享好消息，你會怎麼恭喜？', '朋友說他考上研究所了！你的反應？', '好友在IG貼出新家照片，你怎麼留言？'],
  caring:      ['朋友說他最近壓力很大，你怎麼回應？', '同事說他感冒了，你傳什麼給他？', '許久沒聯絡的舊同學突然說「最近很低潮」，你怎麼說？'],
  business:    ['客戶問你專案進度怎麼樣了，你怎麼回？', '同事說開會時間要改到下午三點，你確認一下？', '合作夥伴感謝你這次合作，你怎麼回覆？'],
  scheduling:  ['朋友問你這週五晚上有沒有空吃飯，你怎麼回？', '同事說要約你喝咖啡聊最近的工作，你怎麼說？', '家人問你中秋節要在哪裡吃飯，你怎麼回？'],
  gratitude:   ['朋友謝謝你上次借他錢，你怎麼回？', '同事說謝謝你幫他完成報告，你的反應？', '客戶說這次服務很滿意，謝謝你，你怎麼說？'],
  sharing:     ['你看到一篇很有趣的文章想傳給朋友，你怎麼傳？', '你發現一家很好吃的餐廳，傳給朋友的訊息是？', '在群組裡分享你週末去爬山的照片，你配什麼文字？'],
  support:     ['朋友說他面試失敗很沮喪，你怎麼安慰？', '同事說他跟男友/女友分手了，你說什麼？', '朋友說他爸媽最近身體不好，你怎麼關心？'],
}

// ── API: Get topic ───────────────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (req, res) => res.json({ ok: true, service: 'voice-trainer', v: 2 }))

app.get('/api/topic', async (req, res) => {
  const category = req.query.category || 'greeting'
  const usedTopics = readJSON(path.join(DATA_DIR, 'topics-used.json'), {})
  const used = usedTopics[category] || []

  // Try AI generation first (Groq is fastest)
  const groqProvider = PROVIDERS.find(p => p.name === 'Groq-Llama' && !isCooling('Groq-Llama'))
    || PROVIDERS.find(p => p.name === 'Cerebras' && !isCooling('Cerebras'))
  const aiTopic = groqProvider ? await callProvider(groqProvider, [
    {
      role: 'system',
      content: `你是一個對話訓練助理。幫使用者練習自然的訊息回覆，讓我們能學習他的說話風格。用繁體中文+英文混用（台灣日常風格）。只輸出情境描述，一兩句話，不要其他說明。`,
    },
    {
      role: 'user',
      content: `類別：${CATEGORIES[category]?.desc || category}
現在是台灣${timeLabel()}，情境要符合這個時段會發生的事。
已使用情境（請避免重複）：${used.slice(-5).join(' / ') || '無'}
請生成一個新的日常對話情境，讓使用者用自然方式回應。要真實、具體，給出明確對象和情況，一兩句話就好。`,
    },
  ], 150) : null

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
  writeJSON(path.join(DATA_DIR, 'topics-used.json'), usedTopics)

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
  const lerp = (old, val, weight = 1) => (old * n + val * weight) / (n + weight)

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

app.post('/api/analyze', async (req, res) => {
  const { topic, response: userMsg, category, fast = false } = req.body
  if (!userMsg?.trim()) return res.status(400).json({ error: 'empty response' })

  const messages = buildAnalyzeMessages(topic, userMsg)

  let merged
  if (fast) {
    // Fast path: single fastest available provider (~1-2s)
    const fp = PROVIDERS.filter(p => !isCooling(p.name) && p.key && p.name !== 'Ollama').sort((a, b) => a.timeout - b.timeout)[0]
    const raw = fp ? await callProvider(fp, messages, 400) : null
    const analysis = parseStyleJSON(raw)
    if (!analysis) return res.status(503).json({ error: 'Analysis failed — try again' })
    merged = { ...analysis, styleNotes: analysis.styleNote ? [analysis.styleNote] : [], modelCount: 1 }
  } else {
    const results = await Promise.all(PROVIDERS.map(p => callProvider(p, messages, 400)))
    merged = mergeAnalyses(results.map(parseStyleJSON))
    if (!merged) return res.status(503).json({ error: 'All AI providers failed — check your API keys in .env' })
  }

  // Update voice profile
  const profile = readJSON(PROFILE_FILE, { totalSamples: 0, tone: {}, language: {}, patterns: {}, byCategory: {} })
  const updated = updateProfile(profile, merged, category, userMsg, topic)
  writeJSON(PROFILE_FILE, updated)

  // Log conversation
  const sample = { id: Date.now().toString(), category, topic, response: userMsg, analysis: merged, at: new Date().toISOString() }
  const convs = readJSON(CONV_FILE, [])
  convs.unshift(sample)
  if (convs.length > 200) convs.splice(200)
  writeJSON(CONV_FILE, convs)

  // Sync to Neon (fire-and-forget)
  syncProfileToNeon(updated).catch(() => {})
  saveSampleToNeon(sample).catch(() => {})

  console.log(`[voice] analyzed sample #${updated.totalSamples} — ${merged.modelCount} models, category: ${category}`)

  res.json({ analysis: merged, profile: updated })
})

// ── API: Get profile ──────────────────────────────────────────────────────────

app.get('/api/profile', (req, res) => {
  res.json(readJSON(PROFILE_FILE, {}))
})

// ── API: History ──────────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  const all = readJSON(CONV_FILE, [])
  const limit = parseInt(req.query.limit) || 20
  const category = req.query.category
  const filtered = category ? all.filter(c => c.category === category) : all
  res.json(filtered.slice(0, limit))
})

// ── Template helpers ──────────────────────────────────────────────────────────

const TMPL_FILE = path.join(DATA_DIR, 'templates.json')

// Normalize templates.json → always { generated, basedOnSamples, templates: { cat: [{ text, applied, appliedAt }] } }
function readTemplates() {
  const raw = readJSON(TMPL_FILE, null)
  if (!raw) return null
  const normalized = {}
  for (const [cat, items] of Object.entries(raw.templates || {})) {
    normalized[cat] = (items || []).map(item =>
      typeof item === 'string'
        ? { text: item, applied: false, appliedAt: null }
        : item
    )
  }
  return { ...raw, templates: normalized }
}

function saveTemplates(tmpl) {
  writeJSON(TMPL_FILE, tmpl)
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

app.post('/api/templates/apply', async (req, res) => {
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

app.post('/api/generate-templates', async (req, res) => {
  const profile = readJSON(PROFILE_FILE, {})
  if (profile.totalSamples < 5) {
    return res.status(400).json({ error: `需要至少 5 個樣本才能生成模板（目前：${profile.totalSamples}）` })
  }

  const examples = readJSON(CONV_FILE, []).slice(0, 10).map(c => `[${c.category}] ${c.response}`).join('\n')
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

請為以下類別各生成 3 個模板，每個模板用 {{contact_name}} 代替名字。
格式：{ "greeting": ["模板1", "模板2", "模板3"], "follow_up": [...], "celebration": [...], "caring": [...], "gratitude": [...] }

模板必須完全符合這個人的真實說話風格、長度、語言比例和用詞習慣。`,
    },
  ]

  let rawTemplates = null
  for (const p of PROVIDERS) {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

export function buildVoiceDescription(profile) {
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

// ── API: AI Assistant chat ────────────────────────────────────────────────────

app.post('/api/assistant/chat', async (req, res) => {
  const { messages = [], userMessage, interviewMode = false, interviewCategory = 'greeting', isStart = false } = req.body
  if (!isStart && !userMessage?.trim()) return res.status(400).json({ error: 'empty message' })

  const profile = readJSON(PROFILE_FILE, {})
  const voiceDesc = profile.totalSamples >= 3 ? buildVoiceDescription(profile) : null
  const catInfo = CATEGORIES[interviewCategory] || CATEGORIES.greeting

  let systemContent
  if (interviewMode) {
    systemContent = [
      `你是說話風格採集夥伴，用情境問題讓使用者自然說話，學習他的對話風格。`,
      `目前類別：${catInfo.label}（${catInfo.desc}）`,
      `情境設計：要有具體對象（朋友/同事/家人/客戶）+ 場景（LINE 訊息/當面/群組），每次親密度和壓力不同。`,
      `使用者回答後：一句台灣口語自然回應（如「哈這樣說蠻自然的」「好，換個角度」），接著馬上問下一個情境。`,
      `規則：口語繁體中文，一次一個情境，不說「已記錄」「謝謝提供」等機械語言，保持像朋友聊天的感覺。`,
      isStart ? `開場：一句輕鬆招呼說要練對話風格，馬上問第一個情境，不要解釋太多。` : '',
    ].filter(Boolean).join('\n')
  } else {
    systemContent = [
      '你是一個友善輕鬆的對話練習夥伴，幫助使用者練習自然的台灣日常對話。',
      voiceDesc ? `使用者說話風格：\n${voiceDesc}\n` : '',
      '用繁體中文（台灣口語）回應，保持簡短（1-3句話），像朋友在 LINE 聊天一樣。不要加任何說明或前綴文字。',
    ].filter(Boolean).join('\n')
  }

  const chatMsgs = [
    { role: 'system', content: systemContent },
    ...messages.slice(-10),
  ]

  if (isStart) {
    chatMsgs.push({ role: 'user', content: '準備好了，請開始！' })
  } else if (userMessage) {
    chatMsgs.push({ role: 'user', content: userMessage })
  }

  const fast = PROVIDERS
    .filter(p => !isCooling(p.name) && p.key && p.name !== 'Ollama')
    .sort((a, b) => a.timeout - b.timeout)[0] || PROVIDERS[0]

  const reply = await callProvider(fast, chatMsgs, 200)
  if (!reply) return res.status(503).json({ error: 'AI providers unavailable' })

  res.json({ reply, provider: fast.name })
})

// ── API: Style practice ──────────────────────────────────────────────────────

app.get('/api/styles', (req, res) => {
  res.json(Object.entries(STYLE_PRESETS).map(([id, s]) => ({ id, name: s.name, desc: s.desc })))
})

app.post('/api/style/chat', async (req, res) => {
  const { messages = [], userMessage, styleId, isStart = false } = req.body
  if (!isStart && !userMessage?.trim()) return res.status(400).json({ error: 'empty message' })

  const style = STYLE_PRESETS[styleId]
  if (!style) return res.status(400).json({ error: 'unknown style' })

  const systemContent = [
    `你是對話風格教練，幫使用者練習「${style.name}」風格。`,
    `「${style.name}」的特色：${style.zh}`,
    `你的工作流程：`,
    `1. 給出一個具體的對話情境（明確對象如朋友/同事/家人 + 場景如LINE訊息/當面/群組）`,
    `2. 使用者回應後，先用1-2句話評估他的表現（幾分/10、哪裡好、哪裡可以更到位），語氣像朋友，不說教`,
    `3. 馬上出下一個情境`,
    `規則：繁體中文台灣口語，評分要具體（如「老朋友感有7分！」），不要長篇大論。`,
    isStart ? `開場：一句輕鬆說今天要練的風格，直接出第一個情境，不要廢話。` : '',
  ].filter(Boolean).join('\n')

  const chatMsgs = [
    { role: 'system', content: systemContent },
    ...messages.slice(-12),
  ]

  if (isStart) chatMsgs.push({ role: 'user', content: '開始！' })
  else if (userMessage) chatMsgs.push({ role: 'user', content: userMessage })

  const fast = PROVIDERS
    .filter(p => !isCooling(p.name) && p.key && p.name !== 'Ollama')
    .sort((a, b) => a.timeout - b.timeout)[0] || PROVIDERS[0]

  const reply = await callProvider(fast, chatMsgs, 300)
  if (!reply) return res.status(503).json({ error: 'AI providers unavailable' })

  res.json({ reply, provider: fast.name })
})

// ── Conversation variety helpers ─────────────────────────────────────────────

function timeLabel() {
  const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).getHours()
  if (h < 6)  return '深夜'
  if (h < 11) return '早上'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '夜晚'
}

// 8 opening hooks — rotate by second so each session feels different
const OPENING_HOOKS = [
  '開場時先說一句輕鬆的廢話（天氣/今天怎樣/最近在忙啥），讓對話感覺像真實對話才開始情境。',
  '直接丟一個很生活的具體情境，不廢話，像突然傳訊息給朋友一樣。',
  '開場帶一點懸念：先描述情況的「問題」，讓使用者想幫忙解決。',
  '以角色扮演方式開場：你是他的朋友，突然傳了一則訊息，讓他回應。',
  '先分享一件你（AI）剛經歷的小事，再問他遇到類似情況怎麼說。',
  '用一個反問開場：「如果你的同事這樣說你會怎麼回？」直接給對話截圖文字。',
  '帶出一個多人情境（群組/聚會），讓他的回覆對象更明確有趣。',
  '從一個真實場景出發（捷運上/咖啡廳/公司茶水間），讓情境立體。',
]

function openingHook() {
  return OPENING_HOOKS[Math.floor(Date.now() / 1000) % OPENING_HOOKS.length]
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
      const token = chunk.choices[0]?.delta?.content
      if (token) write({ token })
    }
  } catch (err) {
    if (err?.status === 402) setCooldown(provider.name, '402')
    else if (err?.status === 429) setCooldown(provider.name, '429')
    console.warn(`[voice] ${provider.name} stream error: ${err.message?.slice(0, 60)}`)
    write({ error: 'stream interrupted' })
  } finally {
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

app.post('/api/assistant/chat/stream', async (req, res) => {
  const { messages = [], userMessage, interviewMode = false, interviewCategory = 'greeting', isStart = false } = req.body
  if (!isStart && !userMessage?.trim()) return res.status(400).json({ error: 'empty message' })

  const profile = readJSON(PROFILE_FILE, {})
  const voiceDesc = profile.totalSamples >= 3 ? buildVoiceDescription(profile) : null
  const catInfo = CATEGORIES[interviewCategory] || CATEGORIES.greeting
  const time = timeLabel()

  let systemContent
  if (interviewMode) {
    systemContent = [
      `你是說話風格採集夥伴，現在是台灣${time}，用情境問題讓使用者自然說話，學習他的對話風格。`,
      `目前類別：${catInfo.label}（${catInfo.desc}）`,
      `情境設計原則：具體對象（朋友/同事/家人/客戶/陌生人）+ 明確場景（LINE 訊息/群組/當面/電話），每次親密度、壓力、緊迫感都不同。`,
      `今日情境變化方向：${openingHook()}`,
      `使用者回答後：一句台灣口語自然反應（短、口語，如「哈這樣說蠻自然的」「這個角度不錯」「我懂，但我可能會說…不對，你這樣也行」），接著馬上出下一個情境。`,
      `禁止：「已記錄」「謝謝提供」「分析完畢」等機械感語言。保持像朋友聊天的自然節奏。`,
      isStart ? `開場：${time === '早上' ? '早上好，' : time === '深夜' ? '還沒睡啊，' : ''}一句輕鬆搭話，馬上出第一個情境，不要解釋今天要做什麼。` : '',
    ].filter(Boolean).join('\n')
  } else {
    systemContent = [
      '你是一個友善輕鬆的對話練習夥伴，幫助使用者練習自然的台灣日常對話。',
      voiceDesc ? `使用者說話風格：\n${voiceDesc}\n` : '',
      '用繁體中文（台灣口語）回應，保持簡短（1-3句話），像朋友在 LINE 聊天一樣。不要加任何說明或前綴文字。',
    ].filter(Boolean).join('\n')
  }

  const chatMsgs = [{ role: 'system', content: systemContent }, ...messages.slice(-10)]
  if (isStart) chatMsgs.push({ role: 'user', content: '準備好了，請開始！' })
  else if (userMessage) chatMsgs.push({ role: 'user', content: userMessage })

  const provider = pickFastProvider()
  if (!provider) return res.status(503).json({ error: 'no providers available' })

  await streamToClient(res, provider, chatMsgs, 200)
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
  return STYLE_SCENARIO_SEEDS[Math.floor(Date.now() / 1000) % STYLE_SCENARIO_SEEDS.length]
}

app.post('/api/style/chat/stream', async (req, res) => {
  const { messages = [], userMessage, styleId, isStart = false } = req.body
  if (!isStart && !userMessage?.trim()) return res.status(400).json({ error: 'empty message' })

  const style = STYLE_PRESETS[styleId]
  if (!style) return res.status(400).json({ error: 'unknown style' })
  const time = timeLabel()

  const systemContent = [
    `你是對話風格教練，現在是台灣${time}，幫使用者練習「${style.name}」風格。`,
    `「${style.name}」的核心：${style.zh}`,
    `今日情境方向：${styleScenarioSeed()}`,
    `你的節奏：`,
    `1. 出一個具體情境（對象 + 場景 + 一句對白，像真實截圖一樣）`,
    `2. 使用者回應後，1-2句評分：幾分/10 + 哪一個字/句最到位或最跑掉，語氣像好友不說教`,
    `3. 馬上出下一個情境（換對象或場景，不重複）`,
    `禁止：長篇解說、「溫馨提示」、超過3句的評語。評分要快、準、有趣。`,
    isStart ? `開場：現在是${time}，一句進入狀態的話，直接出第一個情境（不解釋今天要練什麼）。` : '',
  ].filter(Boolean).join('\n')

  const chatMsgs = [{ role: 'system', content: systemContent }, ...messages.slice(-12)]
  if (isStart) chatMsgs.push({ role: 'user', content: '開始！' })
  else if (userMessage) chatMsgs.push({ role: 'user', content: userMessage })

  const provider = pickFastProvider()
  if (!provider) return res.status(503).json({ error: 'no providers available' })

  await streamToClient(res, provider, chatMsgs, 300)
})

// ── API: Coach tip ─────────────────────────────────────────────────────────────

app.post('/api/coach', async (req, res) => {
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

  const fast = PROVIDERS
    .filter(p => !isCooling(p.name) && p.key && p.name !== 'Ollama')
    .sort((a, b) => a.timeout - b.timeout)[0]

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
async function initNeon() {
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
    console.log('[db] schema ready')

    const { rows: [{ n: dbCount }] } = await dbRun('SELECT COUNT(*)::int AS n FROM voice_samples')
    const localSamples = readJSON(CONV_FILE, [])
    const localProfile = readJSON(PROFILE_FILE, null)

    if (dbCount === 0 && localSamples.length > 0) {
      // Local has data, DB is empty → upload to DB
      if (localProfile) await syncProfileToNeon(localProfile)
      for (const s of localSamples) await saveSampleToNeon(s)
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
      writeJSON(CONV_FILE, restored)
      if (profileRows.length > 0) writeJSON(PROFILE_FILE, profileRows[0].data)
      console.log(`[db] restored ${restored.length} samples from DB to local JSON`)
    } else {
      console.log(`[db] ${dbCount} samples in DB, ${localSamples.length} local — in sync`)
    }
  } catch (e) { console.error('[db] init error:', e.message) }
}

const PORT = process.env.PORT || 3005
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[voice-trainer] started on http://localhost:${PORT}`)
  initNeon()
})
