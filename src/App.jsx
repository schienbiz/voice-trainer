import { useState, useEffect, useCallback } from 'react'

const API = '/api'

const CATEGORIES = [
  { id: 'greeting',    label: '打招呼',   emoji: '👋' },
  { id: 'celebration', label: '慶祝讚美', emoji: '🎉' },
  { id: 'caring',      label: '關心問候', emoji: '❤️' },
  { id: 'business',    label: '商務往來', emoji: '💼' },
  { id: 'scheduling',  label: '約定行程', emoji: '📅' },
  { id: 'gratitude',   label: '感謝道謝', emoji: '🙏' },
  { id: 'sharing',     label: '分享消息', emoji: '📢' },
  { id: 'support',     label: '情感支持', emoji: '🤗' },
]

function bar(val, label, color = '#6c63ff') {
  const pct = Math.round((val || 0) * 100)
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12, color: '#aaa' }}>
        <span>{label}</span><span>{pct}%</span>
      </div>
      <div style={{ height: 6, background: '#1e1e2a', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.5s' }} />
      </div>
    </div>
  )
}

function chip(text, count) {
  return (
    <span key={text} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: '#1e1e2a', border: '1px solid #2a2a3a',
      borderRadius: 20, padding: '3px 10px', fontSize: 12, color: '#c0c0d0', margin: '2px',
    }}>
      {text}{count > 1 && <span style={{ color: '#6c63ff', fontWeight: 600 }}>×{count}</span>}
    </span>
  )
}

export default function App() {
  const [category, setCategory] = useState('greeting')
  const [topic, setTopic]       = useState(null)
  const [response, setResponse] = useState('')
  const [profile, setProfile]   = useState(null)
  const [history, setHistory]   = useState([])
  const [providers, setProviders] = useState([])
  const [loading, setLoading]   = useState({ topic: false, analyze: false, export: false })
  const [lastAnalysis, setLastAnalysis] = useState(null)
  const [tab, setTab]           = useState('train')  // train | profile | history | templates
  const [templates, setTemplates] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const fetchProfile = useCallback(async () => {
    const r = await fetch(`${API}/profile`)
    if (r.ok) setProfile(await r.json())
  }, [])

  const fetchProviders = useCallback(async () => {
    const r = await fetch(`${API}/providers`)
    if (r.ok) setProviders(await r.json())
  }, [])

  const fetchHistory = useCallback(async () => {
    const r = await fetch(`${API}/history?limit=30`)
    if (r.ok) setHistory(await r.json())
  }, [])

  useEffect(() => {
    fetchProfile()
    fetchProviders()
    fetchHistory()
    loadTopic('greeting')
  }, [])

  async function loadTopic(cat) {
    setLoading(l => ({ ...l, topic: true }))
    setTopic(null)
    setResponse('')
    setLastAnalysis(null)
    try {
      const r = await fetch(`${API}/topic?category=${cat}`)
      if (r.ok) setTopic(await r.json())
    } finally {
      setLoading(l => ({ ...l, topic: false }))
    }
  }

  function switchCategory(cat) {
    setCategory(cat)
    loadTopic(cat)
  }

  async function analyze() {
    if (!response.trim() || !topic) return
    setLoading(l => ({ ...l, analyze: true }))
    setFeedback(null)
    try {
      const r = await fetch(`${API}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topic.topic, response, category }),
      })
      const data = await r.json()
      if (r.ok) {
        setLastAnalysis(data.analysis)
        setProfile(data.profile)
        setFeedback({ type: 'success', msg: `✅ 樣本 #${data.profile.totalSamples} 已收集（${data.analysis.modelCount} 個 AI 同時分析）` })
        fetchHistory()
        // Auto-load next topic
        setTimeout(() => loadTopic(category), 1500)
      } else {
        setFeedback({ type: 'error', msg: `❌ ${data.error}` })
      }
    } finally {
      setLoading(l => ({ ...l, analyze: false }))
    }
  }

  async function generateTemplates() {
    setLoading(l => ({ ...l, export: true }))
    setFeedback(null)
    try {
      const r = await fetch(`${API}/generate-templates`, { method: 'POST' })
      const data = await r.json()
      if (r.ok) {
        setTemplates(data.templates)
        setTab('templates')
        setFeedback({ type: 'success', msg: `✅ 已根據 ${data.basedOnSamples} 個樣本生成 Relationship OS 模板` })
      } else {
        setFeedback({ type: 'error', msg: `❌ ${data.error}` })
      }
    } finally {
      setLoading(l => ({ ...l, export: false }))
    }
  }

  const totalSamples = profile?.totalSamples || 0
  const readyForExport = totalSamples >= 5

  // ── Styles ───────────────────────────────────────────────────────────────────
  const s = {
    page:    { display: 'flex', flexDirection: 'column', minHeight: '100vh', padding: 0 },
    header:  { background: '#13131a', borderBottom: '1px solid #1e1e2a', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    title:   { fontSize: 18, fontWeight: 700, color: '#fff', letterSpacing: '-0.3px' },
    badge:   { background: '#6c63ff22', border: '1px solid #6c63ff44', borderRadius: 20, padding: '4px 12px', fontSize: 13, color: '#9d96ff' },
    body:    { display: 'flex', flex: 1 },
    sidebar: { width: 200, background: '#13131a', borderRight: '1px solid #1e1e2a', padding: '16px 0', flexShrink: 0 },
    main:    { flex: 1, padding: 24, overflowY: 'auto' },
    right:   { width: 300, background: '#13131a', borderLeft: '1px solid #1e1e2a', padding: 20, overflowY: 'auto', flexShrink: 0 },
    catBtn:  (active) => ({
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
      background: active ? '#1e1e2e' : 'transparent',
      borderLeft: active ? '3px solid #6c63ff' : '3px solid transparent',
      border: 'none', color: active ? '#fff' : '#888', fontSize: 13, width: '100%', textAlign: 'left',
      cursor: 'pointer', transition: 'all 0.15s',
    }),
    card:    { background: '#13131a', border: '1px solid #1e1e2a', borderRadius: 12, padding: 20, marginBottom: 16 },
    topicBox: { background: '#0d0d15', border: '1px solid #6c63ff33', borderRadius: 10, padding: 16, marginBottom: 16, lineHeight: 1.6 },
    textarea: { width: '100%', background: '#0d0d15', border: '1px solid #1e1e2a', borderRadius: 10, color: '#e8e8f0', padding: 14, fontSize: 15, lineHeight: 1.6, minHeight: 120, outline: 'none' },
    btn:     (variant = 'primary') => ({
      padding: '10px 20px', borderRadius: 8, border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer',
      background: variant === 'primary' ? '#6c63ff' : variant === 'success' ? '#22c55e' : '#1e1e2a',
      color: '#fff', opacity: 1, transition: 'opacity 0.15s',
    }),
    tabBtn:  (active) => ({
      padding: '8px 16px', border: 'none', background: active ? '#6c63ff' : 'transparent',
      color: active ? '#fff' : '#888', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer',
    }),
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <span style={s.title}>🎙 Voice Trainer — 個人對話風格學習</span>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={s.badge}>{totalSamples} 個樣本已收集</span>
          <button
            style={{ ...s.btn('success'), opacity: readyForExport ? 1 : 0.4 }}
            disabled={!readyForExport || loading.export}
            onClick={generateTemplates}
          >
            {loading.export ? '生成中…' : '⬆ 套用到 Relationship OS'}
          </button>
        </div>
      </div>

      <div style={s.body}>
        {/* Sidebar — categories */}
        <div style={s.sidebar}>
          <div style={{ padding: '0 16px 12px', fontSize: 11, color: '#555', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>對話類別</div>
          {CATEGORIES.map(cat => {
            const catData = profile?.byCategory?.[cat.id]
            return (
              <button key={cat.id} style={s.catBtn(category === cat.id)} onClick={() => switchCategory(cat.id)}>
                <span>{cat.emoji}</span>
                <span style={{ flex: 1 }}>{cat.label}</span>
                {catData?.samples > 0 && (
                  <span style={{ fontSize: 11, color: '#6c63ff', background: '#6c63ff22', borderRadius: 10, padding: '1px 6px' }}>
                    {catData.samples}
                  </span>
                )}
              </button>
            )
          })}

          <div style={{ borderTop: '1px solid #1e1e2a', marginTop: 12, paddingTop: 12, padding: '12px 16px 0' }}>
            <div style={{ fontSize: 11, color: '#555', fontWeight: 600, letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>AI 分析器</div>
            {providers.map(p => (
              <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 11 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: p.cooling > 0 ? '#f59e0b' : p.hasKey || p.isOllama ? '#22c55e' : '#ef4444', flexShrink: 0 }} />
                <span style={{ color: p.hasKey || p.isOllama ? '#888' : '#555', flex: 1 }}>{p.name}</span>
                {p.cooling > 0 && <span style={{ color: '#f59e0b', fontSize: 10 }}>{p.cooling}s</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Main content */}
        <div style={s.main}>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
            {[['train', '🎙 收集訓練'], ['profile', '📊 風格報告'], ['history', '📜 歷史記錄'], ['templates', '💬 ROS 模板']].map(([id, label]) => (
              <button key={id} style={s.tabBtn(tab === id)} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {/* Feedback */}
          {feedback && (
            <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13,
              background: feedback.type === 'success' ? '#22c55e22' : '#ef444422',
              border: `1px solid ${feedback.type === 'success' ? '#22c55e44' : '#ef444444'}`,
              color: feedback.type === 'success' ? '#86efac' : '#fca5a5' }}>
              {feedback.msg}
            </div>
          )}

          {/* ── TRAIN TAB ── */}
          {tab === 'train' && (
            <div>
              <div style={s.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>
                    {CATEGORIES.find(c => c.id === category)?.emoji} {CATEGORIES.find(c => c.id === category)?.label}
                  </div>
                  <button style={s.btn('secondary')} onClick={() => loadTopic(category)} disabled={loading.topic}>
                    {loading.topic ? '載入中…' : '🔄 換一題'}
                  </button>
                </div>

                {loading.topic ? (
                  <div style={{ color: '#555', padding: 16, textAlign: 'center' }}>AI 正在生成情境…</div>
                ) : topic ? (
                  <div style={s.topicBox}>
                    <div style={{ fontSize: 12, color: '#6c63ff', marginBottom: 8, fontWeight: 600 }}>📍 情境</div>
                    <div style={{ fontSize: 15, color: '#e0e0f0', lineHeight: 1.7 }}>{topic.topic}</div>
                  </div>
                ) : (
                  <div style={{ color: '#555', textAlign: 'center', padding: 16 }}>點擊類別或等待情境載入</div>
                )}

                <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>💬 你會怎麼回覆？（用你最自然的方式）</div>
                <textarea
                  style={s.textarea}
                  value={response}
                  onChange={e => setResponse(e.target.value)}
                  placeholder="打上你自然的回應方式…不用想太多，就像真的在傳訊息一樣"
                  onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) analyze() }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: '#555' }}>⌘↵ 快速送出 · 目標：每類 10 個樣本</div>
                  <button
                    style={{ ...s.btn('primary'), opacity: response.trim() && !loading.analyze ? 1 : 0.4 }}
                    onClick={analyze}
                    disabled={!response.trim() || loading.analyze}
                  >
                    {loading.analyze ? '⏳ 分析中（最多 20s）…' : '🔍 送出分析'}
                  </button>
                </div>
              </div>

              {/* Last analysis result */}
              {lastAnalysis && (
                <div style={s.card}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>📊 這次的分析結果（{lastAnalysis.modelCount} 個模型）</div>
                  {bar(lastAnalysis.formality, '正式程度', '#6c63ff')}
                  {bar(lastAnalysis.warmth, '溫暖熱情', '#f43f5e')}
                  {bar(lastAnalysis.directness, '直接程度', '#0ea5e9')}
                  {bar(lastAnalysis.humor, '幽默指數', '#f59e0b')}
                  {bar(lastAnalysis.languageRatioZh, '中文比例', '#22c55e')}
                  {lastAnalysis.emojis?.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>偵測到的 Emoji</div>
                      <div>{lastAnalysis.emojis.map(e => chip(e, 1))}</div>
                    </div>
                  )}
                  {lastAnalysis.styleNotes?.map((n, i) => (
                    <div key={i} style={{ fontSize: 12, color: '#888', marginTop: 8, fontStyle: 'italic' }}>💭 {n}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── PROFILE TAB ── */}
          {tab === 'profile' && profile && (
            <div>
              <div style={s.card}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>🧬 你的說話風格基因</div>
                <div style={{ fontSize: 13, color: '#666', marginBottom: 20 }}>
                  基於 {totalSamples} 個樣本 · 最後更新 {profile.updatedAt ? new Date(profile.updatedAt).toLocaleString('zh-TW') : '—'}
                </div>
                {bar(profile.tone?.formality, '正式程度（0=超口語，1=超正式）', '#6c63ff')}
                {bar(profile.tone?.warmth, '溫暖熱情指數', '#f43f5e')}
                {bar(profile.tone?.directness, '直接程度', '#0ea5e9')}
                {bar(profile.tone?.humor, '幽默感', '#f59e0b')}
                {bar(profile.language?.ratioZh, '中文比例', '#22c55e')}
                <div style={{ marginTop: 12, padding: '10px 14px', background: '#0d0d15', borderRadius: 8, fontSize: 13 }}>
                  平均訊息長度：<strong style={{ color: '#9d96ff' }}>{profile.patterns?.avgLength || 0} 字</strong>
                  {profile.patterns?.usesEmoji && <span style={{ marginLeft: 12 }}>✓ 習慣使用 emoji</span>}
                </div>
              </div>

              {profile.patterns?.topEmojis?.length > 0 && (
                <div style={s.card}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>🎭 常用 Emoji</div>
                  <div>{profile.patterns.topEmojis.map(e => chip(e.text || e, e.count || 1))}</div>
                </div>
              )}

              {profile.patterns?.keyPhrases?.length > 0 && (
                <div style={s.card}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>✍️ 特徵詞彙</div>
                  <div>{profile.patterns.keyPhrases.map(e => chip(e.text || e, e.count || 1))}</div>
                </div>
              )}

              {profile.patterns?.openers?.length > 0 && (
                <div style={s.card}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>🚀 開頭習慣</div>
                  <div>{profile.patterns.openers.map(e => chip(e.text || e, e.count || 1))}</div>
                </div>
              )}

              {profile.patterns?.sentenceEnders?.length > 0 && (
                <div style={s.card}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>🔚 結尾習慣</div>
                  <div>{profile.patterns.sentenceEnders.map(e => chip(e.text || e, e.count || 1))}</div>
                </div>
              )}

              {profile.styleNotes?.length > 0 && (
                <div style={s.card}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>💡 AI 觀察</div>
                  {profile.styleNotes.map((n, i) => (
                    <div key={i} style={{ fontSize: 13, color: '#aaa', marginBottom: 6, padding: '6px 10px', background: '#0d0d15', borderRadius: 6 }}>
                      {n}
                    </div>
                  ))}
                </div>
              )}

              {/* Per-category breakdown */}
              <div style={s.card}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>📂 各類別收集狀況</div>
                {CATEGORIES.map(cat => {
                  const data = profile.byCategory?.[cat.id]
                  const pct = Math.min(100, Math.round(((data?.samples || 0) / 10) * 100))
                  return (
                    <div key={cat.id} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#aaa', marginBottom: 4 }}>
                        <span>{cat.emoji} {cat.label}</span>
                        <span>{data?.samples || 0}/10</span>
                      </div>
                      <div style={{ height: 4, background: '#1e1e2a', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: pct >= 100 ? '#22c55e' : '#6c63ff', borderRadius: 2 }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── HISTORY TAB ── */}
          {tab === 'history' && (
            <div>
              {history.length === 0 ? (
                <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>還沒有記錄。去「收集訓練」頁面回答幾個題目吧！</div>
              ) : history.map(h => (
                <div key={h.id} style={{ ...s.card, marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: '#6c63ff' }}>
                      {CATEGORIES.find(c => c.id === h.category)?.emoji} {CATEGORIES.find(c => c.id === h.category)?.label}
                    </span>
                    <span style={{ fontSize: 11, color: '#555' }}>{new Date(h.at).toLocaleString('zh-TW')}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>📍 {h.topic}</div>
                  <div style={{ fontSize: 14, color: '#ddd', background: '#0d0d15', padding: '10px 12px', borderRadius: 8, lineHeight: 1.6 }}>
                    {h.response}
                  </div>
                  {h.analysis && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, color: '#888' }}>正式:{Math.round((h.analysis.formality||0)*100)}%</span>
                      <span style={{ fontSize: 11, color: '#888' }}>溫暖:{Math.round((h.analysis.warmth||0)*100)}%</span>
                      <span style={{ fontSize: 11, color: '#888' }}>中文:{Math.round((h.analysis.languageRatioZh||0)*100)}%</span>
                      <span style={{ fontSize: 11, color: '#6c63ff' }}>{h.analysis.modelCount} 模型</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── TEMPLATES TAB ── */}
          {tab === 'templates' && (
            <div>
              {!templates ? (
                <div style={{ textAlign: 'center', padding: 40 }}>
                  <div style={{ fontSize: 32, marginBottom: 16 }}>💬</div>
                  <div style={{ color: '#888', marginBottom: 20 }}>
                    收集 {totalSamples}/5 個樣本後可以生成 Relationship OS 模板
                  </div>
                  {readyForExport && (
                    <button style={s.btn('primary')} onClick={generateTemplates} disabled={loading.export}>
                      {loading.export ? '生成中…' : '生成我的專屬模板'}
                    </button>
                  )}
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
                    以下模板已根據你的說話風格生成，並自動同步到 Relationship OS（透過 Syncthing）
                  </div>
                  {Object.entries(templates).map(([cat, msgs]) => (
                    <div key={cat} style={s.card}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#9d96ff', marginBottom: 10 }}>
                        {CATEGORIES.find(c => c.id === cat)?.emoji || '💬'} {CATEGORIES.find(c => c.id === cat)?.label || cat}
                      </div>
                      {(msgs || []).map((msg, i) => (
                        <div key={i} style={{ fontSize: 13, color: '#ddd', background: '#0d0d15', padding: '10px 12px', borderRadius: 8, marginBottom: 8, lineHeight: 1.6 }}>
                          {msg}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right panel — quick stats */}
        <div style={s.right}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: '#888' }}>快速概覽</div>

          <div style={{ background: '#1e1e2a', borderRadius: 10, padding: 16, marginBottom: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 36, fontWeight: 700, color: '#9d96ff' }}>{totalSamples}</div>
            <div style={{ fontSize: 12, color: '#666' }}>樣本已收集</div>
            <div style={{ fontSize: 12, color: totalSamples >= 5 ? '#22c55e' : '#f59e0b', marginTop: 4 }}>
              {totalSamples >= 20 ? '✅ 資料充足' : totalSamples >= 5 ? '⚡ 可以生成模板' : `還需 ${5 - totalSamples} 個`}
            </div>
          </div>

          {profile?.tone && (
            <div style={{ background: '#0d0d15', borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 10, fontWeight: 600 }}>風格快照</div>
              {bar(profile.tone.formality, '正式', '#6c63ff')}
              {bar(profile.tone.warmth, '溫暖', '#f43f5e')}
              {bar(profile.tone.humor, '幽默', '#f59e0b')}
              {bar(profile.language?.ratioZh, '中文比例', '#22c55e')}
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#666', fontWeight: 600, marginBottom: 8 }}>各類別進度</div>
            {CATEGORIES.map(cat => {
              const n = profile?.byCategory?.[cat.id]?.samples || 0
              return (
                <div key={cat.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}>
                  <span style={{ color: '#888' }}>{cat.emoji} {cat.label}</span>
                  <span style={{ color: n >= 10 ? '#22c55e' : n > 0 ? '#9d96ff' : '#333' }}>{n}/10</span>
                </div>
              )
            })}
          </div>

          <div style={{ borderTop: '1px solid #1e1e2a', paddingTop: 14 }}>
            <div style={{ fontSize: 12, color: '#666', fontWeight: 600, marginBottom: 8 }}>使用說明</div>
            <div style={{ fontSize: 12, color: '#555', lineHeight: 1.7 }}>
              1️⃣ 選擇對話類別<br />
              2️⃣ 看情境，用自然方式回覆<br />
              3️⃣ 每類收集 10 個樣本<br />
              4️⃣ 點「套用到 Relationship OS」<br />
              5️⃣ 模板透過 Syncthing 自動同步
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
