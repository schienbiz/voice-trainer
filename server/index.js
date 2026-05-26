import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import OpenAI from 'openai'
import dotenv from 'dotenv'
import pkg from 'pg'
const { Pool } = pkg

dotenv.config()

// ── Neon DB ───────────────────────────────────────────────────────────────────
const db = process.env.VOICE_DATABASE_URL
  ? new Pool({ connectionString: process.env.VOICE_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 })
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
  } catch (e) { console.error('[neon] profile sync error:', e.message) }
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
  } catch (e) { console.error('[neon] sample sync error:', e.message) }
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

app.get('/health', (req, res) => res.json({ ok: true, service: 'voice-trainer' }))

app.get('/api/topic', async (req, res) => {
  const category = req.query.category || 'greeting'
  const usedTopics = readJSON(path.join(DATA_DIR, 'topics-used.json'), {})
  const used = usedTopics[category] || []

  // Try AI generation first (Groq is fastest)
  const groqProvider = PROVIDERS.find(p => p.name === 'Groq-Llama')
  const aiTopic = groqProvider ? await callProvider(groqProvider, [
    {
      role: 'system',
      content: `你是一個對話訓練助理。幫使用者練習自然的訊息回覆，讓我們能學習他的說話風格。用繁體中文+英文混用（台灣日常風格）。只輸出情境描述，一兩句話，不要其他說明。`,
    },
    {
      role: 'user',
      content: `類別：${CATEGORIES[category]?.desc || category}
已使用情境（請避免重複）：${used.slice(-5).join(' / ') || '無'}
請生成一個新的日常對話情境，讓使用者用自然方式回應。要真實、具體，給出明確的對象和情況。`,
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
  const { topic, response: userMsg, category } = req.body
  if (!userMsg?.trim()) return res.status(400).json({ error: 'empty response' })

  const messages = buildAnalyzeMessages(topic, userMsg)

  // Run all providers in parallel
  const [r1, r2, r3, r4, r5, r6] = await Promise.all(
    PROVIDERS.map(p => callProvider(p, messages, 400))
  )

  const analyses = [r1, r2, r3, r4, r5, r6].map(parseStyleJSON)
  const merged = mergeAnalyses(analyses)

  if (!merged) {
    return res.status(503).json({ error: 'All AI providers failed — check your API keys in .env' })
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

  // Use best available provider for template generation
  let templates = null
  for (const p of PROVIDERS) {
    const raw = await callProvider(p, templatePrompt, 1000)
    if (!raw) continue
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) { templates = JSON.parse(match[0]); break }
    } catch { continue }
  }

  if (!templates) return res.status(503).json({ error: 'Template generation failed — try again' })

  // Save templates
  const tmplFile = path.join(DATA_DIR, 'templates.json')
  writeJSON(tmplFile, { generated: new Date().toISOString(), basedOnSamples: profile.totalSamples, templates })

  console.log(`[voice] generated ROS templates from ${profile.totalSamples} samples`)

  // Auto-import into ROS database
  const rosUrl = process.env.VOICE_ROS_IMPORT_URL
  let rosImported = 0
  if (rosUrl) {
    try {
      const r = await fetch(`${rosUrl}/api/import-voice-templates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Voice-Import-Token': process.env.VOICE_ROS_IMPORT_SECRET || '',
        },
        body: JSON.stringify({ templates }),
        signal: AbortSignal.timeout(15_000),
      })
      const result = await r.json()
      rosImported = result.imported || 0
      console.log(`[voice→ros] imported ${rosImported} templates into ROS database`)
    } catch (err) {
      console.warn(`[voice→ros] ROS import failed (non-fatal): ${err.message}`)
    }
  }

  res.json({ templates, basedOnSamples: profile.totalSamples, rosImported })
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
      `你是說話風格採集夥伴，透過情境問題讓使用者自然說話，從中學習他的對話風格。`,
      `目前收集類別：${catInfo.label}（${catInfo.desc}）`,
      `每次：問一個真實具體的情境（要有對象與場景，例：「你同事傳訊息說…你怎麼回？」）`,
      `使用者回答後：用一句台灣口語自然回應，然後問下一個同類情境。`,
      `風格：輕鬆友善，台灣口語繁體中文，不說「已記錄」「謝謝提供」等機械語言。`,
      isStart ? `開場：先用一句話輕鬆打招呼說明目的，馬上問第一個情境。` : '',
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

// ── Neon: init schema + migrate existing JSON data ───────────────────────────
async function initNeon() {
  if (!db) { console.log('[neon] no VOICE_DATABASE_URL — skipping'); return }
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
    console.log('[neon] schema ready')

    // Migrate existing JSON data if Neon is empty
    const { rows } = await dbRun('SELECT COUNT(*)::int AS n FROM voice_samples')
    if (rows[0].n === 0) {
      const localProfile = readJSON(PROFILE_FILE, null)
      const localSamples = readJSON(CONV_FILE, [])
      if (localProfile) await syncProfileToNeon(localProfile)
      for (const s of localSamples) await saveSampleToNeon(s)
      if (localSamples.length > 0)
        console.log(`[neon] migrated ${localSamples.length} samples from JSON`)
    } else {
      console.log(`[neon] ${rows[0].n} samples already in DB`)
    }
  } catch (e) { console.error('[neon] init error:', e.message) }
}

const PORT = process.env.PORT || 3005
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[voice-trainer] started on http://localhost:${PORT}`)
  initNeon()
})
