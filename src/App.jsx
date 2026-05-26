import { useState, useEffect, useCallback, useRef } from 'react'

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
  const [loading, setLoading]   = useState({ topic: false, analyze: false, export: false, assistant: false })
  const [lastAnalysis, setLastAnalysis] = useState(null)
  const [tab, setTab]           = useState('train')
  const [templates, setTemplates] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const recognitionRef = useRef(null)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)

  // AI 助手 + TTS
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [ttsVoices, setTtsVoices] = useState([])
  const [chatHistory, setChatHistory] = useState([])
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantListening, setAssistantListening] = useState(false)
  const [assistantInterim, setAssistantInterim] = useState('')
  const [sessionSamples, setSessionSamples] = useState(0)
  const [coachTip, setCoachTip] = useState(null)
  const assistantRecRef = useRef(null)
  const chatEndRef = useRef(null)

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Load TTS voices (async in some browsers)
  useEffect(() => {
    const load = () => setTtsVoices(window.speechSynthesis?.getVoices() || [])
    load()
    window.speechSynthesis?.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load)
  }, [])

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatHistory])

  // Auto-start interview when entering 助手 tab
  useEffect(() => {
    if (tab === 'assistant' && chatHistory.length === 0 && !loading.assistant) {
      startInterview()
    }
  }, [tab])

  const speak = useCallback((text) => {
    if (!ttsEnabled || !window.speechSynthesis || !text) return
    window.speechSynthesis.cancel()
    const utt = new SpeechSynthesisUtterance(text)
    utt.lang = 'zh-TW'
    utt.rate = 1.05
    const zhVoice = ttsVoices.find(v => v.lang.includes('TW') || v.lang.includes('HK'))
      || ttsVoices.find(v => v.lang.startsWith('zh'))
    if (zhVoice) utt.voice = zhVoice
    window.speechSynthesis.speak(utt)
  }, [ttsEnabled, ttsVoices])

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
    setCoachTip(null)
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
    setCoachTip(null)
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

        // Fetch coaching tip in background
        const savedResponse = response
        fetch(`${API}/coach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ analysis: data.analysis, userMsg: savedResponse }),
        }).then(r => r.json()).then(d => {
          if (d.tip) { setCoachTip(d.tip); speak(d.tip) }
        }).catch(() => {})

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
        const rosMsg = data.rosImported > 0 ? `，已自動匯入 ${data.rosImported} 個到 ROS 資料庫` : ''
        setFeedback({ type: 'success', msg: `✅ 已根據 ${data.basedOnSamples} 個樣本生成 Relationship OS 模板${rosMsg}` })
      } else {
        setFeedback({ type: 'error', msg: `❌ ${data.error}` })
      }
    } finally {
      setLoading(l => ({ ...l, export: false }))
    }
  }

  function toggleVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { alert('此瀏覽器不支援語音輸入，請改用 Chrome 或 Safari。'); return }

    if (listening) {
      recognitionRef.current?.stop()
      return
    }

    const rec = new SR()
    rec.lang = 'zh-TW'
    rec.continuous = false
    rec.interimResults = true
    recognitionRef.current = rec

    rec.onstart = () => { setListening(true); setInterim('') }
    rec.onresult = (e) => {
      let fin = '', intr = ''
      for (const r of e.results) {
        if (r.isFinal) fin += r[0].transcript
        else intr += r[0].transcript
      }
      if (fin) setResponse(prev => prev ? prev + ' ' + fin : fin)
      setInterim(intr)
    }
    rec.onerror = () => { setListening(false); setInterim('') }
    rec.onend = () => { setListening(false); setInterim('') }
    rec.start()
  }

  function toggleAssistantVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { alert('此瀏覽器不支援語音輸入，請改用 Chrome 或 Safari。'); return }

    if (assistantListening) {
      assistantRecRef.current?.stop()
      return
    }

    const rec = new SR()
    rec.lang = 'zh-TW'
    rec.continuous = false
    rec.interimResults = true
    assistantRecRef.current = rec

    rec.onstart = () => { setAssistantListening(true); setAssistantInterim('') }
    rec.onresult = (e) => {
      let fin = '', intr = ''
      for (const r of e.results) {
        if (r.isFinal) fin += r[0].transcript
        else intr += r[0].transcript
      }
      if (fin) setAssistantInput(prev => prev ? prev + ' ' + fin : fin)
      setAssistantInterim(intr)
    }
    rec.onerror = () => { setAssistantListening(false); setAssistantInterim('') }
    rec.onend = () => { setAssistantListening(false); setAssistantInterim('') }
    rec.start()
  }

  function sendToAssistant() {
    const msg = assistantInput.trim()
    if (!msg || loading.assistant) return
    setAssistantInput('')
    setAssistantInterim('')

    const msgId = Date.now().toString()
    const catForMsg = interviewCategory
    const lastAIQuestion = chatHistory.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '日常對話練習'
    const nextCat = CATEGORIES[(sessionSamples + 1) % CATEGORIES.length]

    setChatHistory(h => [...h, { role: 'user', content: msg, saving: true, id: msgId }])
    setLoading(l => ({ ...l, assistant: true }))

    // Fast path: get AI's next question (~1-2s)
    fetch(`${API}/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: chatHistory.map(({ role, content }) => ({ role, content })),
        userMessage: msg,
        interviewMode: true,
        interviewCategory: nextCat.id,
      }),
    }).then(r => r.json()).then(data => {
      if (data.reply) {
        setChatHistory(h => [...h, { role: 'assistant', content: data.reply }])
        speak(data.reply)
        setSessionSamples(n => n + 1)
      } else {
        setChatHistory(h => [...h, { role: 'assistant', content: '⚠️ ' + (data.error || '請求失敗') }])
      }
    }).catch(() => {
      setChatHistory(h => [...h, { role: 'assistant', content: '⚠️ 網路錯誤，請稍後重試' }])
    }).finally(() => {
      setLoading(l => ({ ...l, assistant: false }))
    })

    // Slow path: analyze & save as training sample (~8-12s)
    fetch(`${API}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: lastAIQuestion, response: msg, category: catForMsg.id }),
    }).then(r => r.json()).then(data => {
      if (data.profile) { setProfile(data.profile); fetchHistory() }
      setChatHistory(h => h.map(m => m.id === msgId ? { ...m, saving: false, saved: true } : m))
    }).catch(() => {
      setChatHistory(h => h.map(m => m.id === msgId ? { ...m, saving: false } : m))
    })
  }

  function startInterview() {
    if (loading.assistant) return
    setChatHistory([])
    setSessionSamples(0)
    setLoading(l => ({ ...l, assistant: true }))
    fetch(`${API}/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [],
        interviewMode: true,
        interviewCategory: CATEGORIES[0].id,
        isStart: true,
      }),
    }).then(r => r.json()).then(data => {
      if (data.reply) {
        setChatHistory([{ role: 'assistant', content: data.reply, id: 'start' }])
        speak(data.reply)
      }
    }).catch(() => {
      setChatHistory([{ role: 'assistant', content: '⚠️ 無法連線，請重新整理', id: 'start' }])
    }).finally(() => {
      setLoading(l => ({ ...l, assistant: false }))
    })
  }

  const totalSamples = profile?.totalSamples || 0
  const readyForExport = totalSamples >= 5
  const interviewCategory = CATEGORIES[sessionSamples % CATEGORIES.length]

  // ── Styles ───────────────────────────────────────────────────────────────────
  const s = {
    page:    { display: 'flex', flexDirection: 'column', minHeight: '100vh', padding: 0 },
    header:  { background: '#13131a', borderBottom: '1px solid #1e1e2a', padding: isMobile ? '12px 16px' : '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    title:   { fontSize: isMobile ? 15 : 18, fontWeight: 700, color: '#fff', letterSpacing: '-0.3px', flexShrink: 1, minWidth: 0 },
    badge:   { background: '#6c63ff22', border: '1px solid #6c63ff44', borderRadius: 20, padding: isMobile ? '3px 8px' : '4px 12px', fontSize: isMobile ? 11 : 13, color: '#9d96ff', whiteSpace: 'nowrap' },
    body:    { display: 'flex', flex: 1, minHeight: 0 },
    sidebar: { width: 200, background: '#13131a', borderRight: '1px solid #1e1e2a', padding: '16px 0', flexShrink: 0, display: isMobile ? 'none' : 'block' },
    catScroll: { display: isMobile ? 'flex' : 'none', overflowX: 'auto', gap: 8, padding: '10px 16px', background: '#13131a', borderBottom: '1px solid #1e1e2a', flexShrink: 0, WebkitOverflowScrolling: 'touch' },
    catChip: (active) => ({
      display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', whiteSpace: 'nowrap',
      background: active ? '#6c63ff' : '#1e1e2a', borderRadius: 20, border: 'none',
      color: active ? '#fff' : '#888', fontSize: 13, cursor: 'pointer', flexShrink: 0,
    }),
    main:    { flex: 1, padding: isMobile ? 12 : 24, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
    right:   { width: 300, background: '#13131a', borderLeft: '1px solid #1e1e2a', padding: 20, overflowY: 'auto', flexShrink: 0, display: isMobile ? 'none' : 'block' },
    catBtn:  (active) => ({
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
      background: active ? '#1e1e2e' : 'transparent',
      borderLeft: active ? '3px solid #6c63ff' : '3px solid transparent',
      border: 'none', color: active ? '#fff' : '#888', fontSize: 13, width: '100%', textAlign: 'left',
      cursor: 'pointer', transition: 'all 0.15s',
    }),
    card:    { background: '#13131a', border: '1px solid #1e1e2a', borderRadius: 12, padding: isMobile ? 14 : 20, marginBottom: 14 },
    topicBox: { background: '#0d0d15', border: '1px solid #6c63ff33', borderRadius: 10, padding: isMobile ? 12 : 16, marginBottom: 14, lineHeight: 1.6 },
    textarea: { width: '100%', background: '#0d0d15', border: '1px solid #1e1e2a', borderRadius: 10, color: '#e8e8f0', padding: 14, fontSize: 16, lineHeight: 1.6, minHeight: isMobile ? 100 : 120, outline: 'none', boxSizing: 'border-box' },
    btn:     (variant = 'primary') => ({
      padding: isMobile ? '12px 18px' : '10px 20px', borderRadius: 8, border: 'none', fontSize: isMobile ? 15 : 14, fontWeight: 600, cursor: 'pointer',
      background: variant === 'primary' ? '#6c63ff' : variant === 'success' ? '#22c55e' : variant === 'danger' ? '#ef444433' : '#1e1e2a',
      color: variant === 'danger' ? '#fca5a5' : '#fff', opacity: 1, transition: 'opacity 0.15s',
    }),
    tabBtn:  (active) => ({
      padding: isMobile ? '9px 13px' : '8px 16px', border: 'none', background: active ? '#6c63ff' : 'transparent',
      color: active ? '#fff' : '#888', borderRadius: 6, fontSize: isMobile ? 12 : 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
    }),
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <span style={s.title}>🎙 Voice Trainer — 個人對話風格學習</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={s.badge}>{totalSamples} 個樣本</span>
          <button
            onClick={() => {
              if (ttsEnabled) window.speechSynthesis?.cancel()
              setTtsEnabled(e => !e)
            }}
            title={ttsEnabled ? '關閉語音播放' : '開啟語音播放（AI 說話）'}
            style={{
              padding: isMobile ? '6px 10px' : '7px 13px', borderRadius: 8, border: 'none', fontSize: isMobile ? 13 : 13,
              background: ttsEnabled ? '#6c63ff33' : '#1e1e2a',
              color: ttsEnabled ? '#9d96ff' : '#555', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {ttsEnabled ? '🔊 語音開' : '🔇 語音關'}
          </button>
          <button
            style={{ ...s.btn('success'), opacity: readyForExport ? 1 : 0.4 }}
            disabled={!readyForExport || loading.export}
            onClick={generateTemplates}
          >
            {loading.export ? '生成中…' : isMobile ? '⬆ ROS' : '⬆ 套用到 Relationship OS'}
          </button>
        </div>
      </div>

      {/* Mobile: horizontal category scroll (hide for assistant tab) */}
      {tab !== 'assistant' && (
        <div style={s.catScroll}>
          {CATEGORIES.map(cat => {
            const catData = profile?.byCategory?.[cat.id]
            return (
              <button key={cat.id} style={s.catChip(category === cat.id)} onClick={() => switchCategory(cat.id)}>
                <span>{cat.emoji}</span>
                <span>{cat.label}</span>
                {catData?.samples > 0 && (
                  <span style={{ fontSize: 10, color: category === cat.id ? '#c4c0ff' : '#6c63ff', background: category === cat.id ? '#ffffff22' : '#6c63ff22', borderRadius: 10, padding: '0px 5px' }}>
                    {catData.samples}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      <div style={s.body}>
        {/* Sidebar — categories (desktop only, hide for assistant tab) */}
        {tab !== 'assistant' && (
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
        )}

        {/* Main content */}
        <div style={s.main}>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 16, overflowX: 'auto', WebkitOverflowScrolling: 'touch', flexShrink: 0 }}>
            {[['train', '🎙 收集訓練'], ['assistant', '🤖 AI 助手'], ['profile', '📊 風格報告'], ['history', '📜 歷史記錄'], ['templates', '💬 ROS 模板']].map(([id, label]) => (
              <button key={id} style={s.tabBtn(tab === id)} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {/* Feedback */}
          {feedback && tab !== 'assistant' && (
            <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13,
              background: feedback.type === 'success' ? '#22c55e22' : '#ef444422',
              border: `1px solid ${feedback.type === 'success' ? '#22c55e44' : '#ef444444'}`,
              color: feedback.type === 'success' ? '#86efac' : '#fca5a5' }}>
              {feedback.msg}
            </div>
          )}

          {/* ── TRAIN TAB ── */}
          {tab === 'train' && (
            <div style={{ flex: 1 }}>
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
                    {ttsEnabled && (
                      <button
                        onClick={() => speak(topic.topic)}
                        style={{ marginTop: 10, padding: '4px 12px', borderRadius: 20, border: 'none', background: '#6c63ff22', color: '#9d96ff', fontSize: 12, cursor: 'pointer' }}
                      >
                        🔊 朗讀情境
                      </button>
                    )}
                  </div>
                ) : (
                  <div style={{ color: '#555', textAlign: 'center', padding: 16 }}>點擊類別或等待情境載入</div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: '#666' }}>💬 你會怎麼回覆？（用你最自然的方式）</div>
                  <button
                    onClick={toggleVoice}
                    style={{
                      padding: '5px 12px', borderRadius: 20, border: 'none', fontSize: 13, cursor: 'pointer',
                      background: listening ? '#ef444433' : '#1e1e2a',
                      color: listening ? '#fca5a5' : '#888',
                      display: 'flex', alignItems: 'center', gap: 6, transition: 'all 0.2s',
                    }}
                  >
                    <span style={{ fontSize: 15 }}>{listening ? '⏹' : '🎤'}</span>
                    {listening ? '停止錄音' : '語音輸入'}
                  </button>
                </div>
                {listening && (
                  <div style={{ fontSize: 12, color: '#f59e0b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444', display: 'inline-block', animation: 'pulse 1s infinite' }} />
                    錄音中…{interim && <span style={{ color: '#888', fontStyle: 'italic' }}>{interim}</span>}
                  </div>
                )}
                <textarea
                  style={s.textarea}
                  value={response}
                  onChange={e => setResponse(e.target.value)}
                  placeholder="打上你自然的回應方式，或按 🎤 語音輸入…"
                  onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) analyze() }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 8 }}>
                  <div style={{ fontSize: 12, color: '#555' }}>{isMobile ? '目標：每類 10 個樣本' : '⌘↵ 快速送出 · 目標：每類 10 個樣本'}</div>
                  <button
                    style={{ ...s.btn('primary'), opacity: response.trim() && !loading.analyze ? 1 : 0.4, flexShrink: 0 }}
                    onClick={analyze}
                    disabled={!response.trim() || loading.analyze}
                  >
                    {loading.analyze ? '⏳ 分析中…' : '🔍 送出分析'}
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

              {/* Coach tip */}
              {coachTip && (
                <div style={{ ...s.card, background: '#0d1a0d', border: '1px solid #22c55e33' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span style={{ fontSize: 20, flexShrink: 0 }}>🎯</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, color: '#22c55e', fontWeight: 600, marginBottom: 4 }}>語音教練建議</div>
                      <div style={{ fontSize: 14, color: '#86efac', lineHeight: 1.6 }}>{coachTip}</div>
                    </div>
                    {ttsEnabled && (
                      <button
                        onClick={() => speak(coachTip)}
                        style={{ padding: '4px 10px', borderRadius: 20, border: 'none', background: '#22c55e22', color: '#86efac', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}
                      >
                        🔊
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── AI 助手 TAB ── */}
          {tab === 'assistant' && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              {/* Top bar */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: '#1e1e2a', border: '1px solid #2a2a3a' }}>
                    <span>{interviewCategory.emoji}</span>
                    <span style={{ fontSize: 13, color: '#9d96ff', fontWeight: 600 }}>{interviewCategory.label}</span>
                  </div>
                  <span style={{ fontSize: 12, color: '#555' }}>
                    本次已收集 <strong style={{ color: '#22c55e' }}>{sessionSamples}</strong> 個樣本
                  </span>
                </div>
                <button
                  onClick={startInterview}
                  disabled={loading.assistant}
                  style={{ padding: '5px 12px', borderRadius: 20, border: 'none', background: '#1e1e2a', color: '#666', fontSize: 13, cursor: 'pointer' }}
                >
                  ↺ 重新開始
                </button>
              </div>
              <div style={{ fontSize: 12, color: '#444', marginBottom: 10 }}>
                AI 會問你情境問題，用最自然的方式回答，你的回應自動存為訓練樣本。
              </div>

              {/* Chat messages */}
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 12 }}>
                {chatHistory.length === 0 && loading.assistant && (
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#1e1e2a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>🤖</div>
                    <div style={{ padding: '10px 14px', borderRadius: '16px 16px 16px 4px', background: '#1e1e2a', fontSize: 13, color: '#555' }}>
                      準備中<span style={{ animation: 'pulse 1s infinite' }}>…</span>
                    </div>
                  </div>
                )}
                {chatHistory.map((msg, idx) => (
                  <div key={msg.id || idx} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: 8, alignItems: 'flex-end' }}>
                    {msg.role === 'assistant' && (
                      <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#1e1e2a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>
                        🤖
                      </div>
                    )}
                    <div style={{ maxWidth: '70%' }}>
                      <div style={{
                        padding: '10px 14px', borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                        background: msg.role === 'user' ? '#6c63ff' : '#1e1e2a',
                        color: '#fff', fontSize: 14, lineHeight: 1.65,
                      }}>
                        {msg.content}
                      </div>
                      {msg.role === 'user' && (
                        <div style={{ marginTop: 4, display: 'flex', justifyContent: 'flex-end' }}>
                          {msg.saved ? (
                            <span style={{ fontSize: 11, color: '#22c55e' }}>✓ 已存為樣本</span>
                          ) : msg.saving ? (
                            <span style={{ fontSize: 11, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 4 }}>
                              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', display: 'inline-block', animation: 'pulse 1s infinite' }} />
                              AI 分析中…
                            </span>
                          ) : null}
                        </div>
                      )}
                      {msg.role === 'assistant' && ttsEnabled && (
                        <button
                          onClick={() => speak(msg.content)}
                          style={{ marginTop: 4, padding: '2px 10px', borderRadius: 20, border: 'none', background: '#1e1e2a', color: '#555', fontSize: 11, cursor: 'pointer' }}
                        >
                          🔊 重播
                        </button>
                      )}
                    </div>
                    {msg.role === 'user' && (
                      <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#6c63ff33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>
                        😊
                      </div>
                    )}
                  </div>
                ))}
                {loading.assistant && chatHistory.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#1e1e2a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>🤖</div>
                    <div style={{ padding: '10px 14px', borderRadius: '16px 16px 16px 4px', background: '#1e1e2a', fontSize: 13, color: '#555' }}>
                      思考中<span style={{ animation: 'pulse 1s infinite' }}>…</span>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Input area */}
              <div style={{ borderTop: '1px solid #1e1e2a', paddingTop: 12 }}>
                {assistantListening && (
                  <div style={{ fontSize: 12, color: '#f59e0b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                    錄音中…{assistantInterim && <span style={{ color: '#888', fontStyle: 'italic' }}>{assistantInterim}</span>}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <textarea
                    style={{ ...s.textarea, minHeight: 52, flex: 1 }}
                    value={assistantInput}
                    onChange={e => setAssistantInput(e.target.value)}
                    placeholder="用最自然的方式回答 AI 的問題…"
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendToAssistant() } }}
                    rows={2}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <button
                      onClick={toggleAssistantVoice}
                      style={{
                        padding: '10px 14px', borderRadius: 8, border: 'none', fontSize: 18, cursor: 'pointer',
                        background: assistantListening ? '#ef444433' : '#1e1e2a',
                        color: assistantListening ? '#fca5a5' : '#888',
                      }}
                      title="語音輸入"
                    >
                      {assistantListening ? '⏹' : '🎤'}
                    </button>
                    <button
                      onClick={sendToAssistant}
                      disabled={!assistantInput.trim() || loading.assistant}
                      style={{ ...s.btn('primary'), opacity: assistantInput.trim() && !loading.assistant ? 1 : 0.4, padding: '10px 14px' }}
                    >
                      ↑
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#333', marginTop: 6 }}>Enter 送出 · Shift+Enter 換行 · 回答後自動存為樣本</div>
              </div>
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

        {/* Right panel — quick stats (hide for assistant tab) */}
        {tab !== 'assistant' && (
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
                3️⃣ 教練即時給建議 🎯<br />
                4️⃣ 或到「AI 助手」被問問題自然回答<br />
                5️⃣ 點「套用到 Relationship OS」
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
