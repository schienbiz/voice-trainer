import { useState, useEffect, useCallback, useRef, useMemo } from 'react'

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

const STYLE_PRESETS = [
  { id: 'old-friend',  name: '老朋友',  emoji: '😄', desc: '輕鬆隨性，像老朋友', color: '#f59e0b' },
  { id: 'gentle',      name: '溫柔關心', emoji: '🥰', desc: '溫柔體貼，多關心對方', color: '#f43f5e' },
  { id: 'humor',       name: '幽默風趣', emoji: '😂', desc: '幽默風趣，讓對話有趣', color: '#22c55e' },
  { id: 'formal',      name: '正式有禮', emoji: '🤝', desc: '正式有禮，商務感', color: '#0ea5e9' },
  { id: 'concise',     name: '簡短直接', emoji: '⚡', desc: '簡短直接，一句話搞定', color: '#6c63ff' },
  { id: 'energetic',   name: '熱情活潑', emoji: '🔥', desc: '熱情活潑，充滿能量', color: '#f97316' },
  { id: 'mysterious',  name: '神秘低調', emoji: '🕶️', desc: '神秘低調，讓對方好奇', color: '#8b5cf6' },
  { id: 'elder',       name: '長輩關懷', emoji: '👴', desc: '長輩關懷，溫暖叮嚀', color: '#10b981' },
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

async function streamSSE(url, body, onToken, onDone, onError, signal) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      onError?.(data.error || `HTTP ${res.status}`)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let fullText = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') { onDone?.(fullText); return }
        try {
          const { token, error } = JSON.parse(raw)
          if (token) { fullText += token; onToken?.(fullText) }
          else if (error) { onError?.(error); return }
        } catch {}
      }
    }
    if (fullText) onDone?.(fullText)
    else onError?.('empty response')
  } catch (err) {
    if (err.name !== 'AbortError') onError?.(err.message)
  }
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
  const [templates, setTemplates] = useState(null)   // { generated, basedOnSamples, templates: { cat: [{text,applied,appliedAt}] } }
  const [applyingTemplate, setApplyingTemplate] = useState(null)  // "cat::text" being applied
  const [feedback, setFeedback] = useState(null)
  const feedbackTimerRef = useRef(null)
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
  const [sessionCatCounts, setSessionCatCounts] = useState({})
  const [coachTip, setCoachTip] = useState(null)
  const assistantRecRef = useRef(null)
  const assistantInputRef = useRef('')
  const sendAssistantRef = useRef(null)
  const chatEndRef = useRef(null)

  // 風格練習 tab
  const [selectedStyle, setSelectedStyle] = useState(null)
  const [styleChatHistory, setStyleChatHistory] = useState([])
  const [styleInput, setStyleInput] = useState('')
  const [styleLoading, setStyleLoading] = useState(false)
  const [styleListening, setStyleListening] = useState(false)
  const [styleInterim, setStyleInterim] = useState('')
  const styleInputRef = useRef('')
  const styleSendRef = useRef(null)
  const styleRecRef = useRef(null)
  const styleChatEndRef = useRef(null)

  const [memories, setMemories] = useState([])

  // Auto-mic (hands-free mode)
  const [autoMicEnabled, setAutoMicEnabled] = useState(false)
  const autoMicRef = useRef(false)
  const assistantListeningRef = useRef(false)
  const styleListeningRef = useRef(false)
  const toggleAssistantVoiceRef = useRef(null)
  const toggleStyleVoiceRef = useRef(null)

  // Abort controllers for in-flight SSE streams
  const assistantAbortRef = useRef(null)
  const styleAbortRef = useRef(null)

  const showFeedback = (fb) => {
    clearTimeout(feedbackTimerRef.current)
    setFeedback(fb)
    if (fb) feedbackTimerRef.current = setTimeout(() => setFeedback(null), 5000)
  }

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

  useEffect(() => {
    styleChatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [styleChatHistory])

  const prevTabRef = useRef('train')

  // Auto-start interview when entering 助手 tab; save memory when leaving
  useEffect(() => {
    if (prevTabRef.current === 'assistant' && tab !== 'assistant') {
      saveSessionMemory(chatHistory, sessionSamples)
    }
    prevTabRef.current = tab
    if (tab === 'assistant' && chatHistory.length === 0 && !loading.assistant) {
      startInterview()
    }
    if (tab === 'profile') fetchMemories()
  }, [tab])

  const speak = useCallback((text, onEnd) => {
    if (!ttsEnabled || !window.speechSynthesis || !text) { onEnd?.(); return }
    window.speechSynthesis.cancel()
    const utt = new SpeechSynthesisUtterance(text)
    utt.lang = 'zh-TW'
    utt.rate = 1.1
    const zhVoice = ttsVoices.find(v => v.lang.includes('TW') || v.lang.includes('HK'))
      || ttsVoices.find(v => v.lang.startsWith('zh'))
    if (zhVoice) utt.voice = zhVoice
    if (onEnd) utt.onend = onEnd
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

  const fetchTemplates = useCallback(async () => {
    const r = await fetch(`${API}/templates`)
    if (r.ok) {
      const data = await r.json()
      if (data) setTemplates(data)
    }
  }, [])

  const fetchMemories = useCallback(async () => {
    const r = await fetch(`${API}/session/memories`)
    if (r.ok) setMemories(await r.json())
  }, [])

  useEffect(() => {
    fetchProfile()
    fetchProviders()
    fetchHistory()
    fetchTemplates()
    fetchMemories()
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
        showFeedback({ type: 'success', msg: `✅ 樣本 #${data.profile.totalSamples} 已收集（${data.analysis.modelCount} 個 AI 同時分析）` })
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
        showFeedback({ type: 'error', msg: `❌ ${data.error}` })
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
        setTemplates({ templates: data.templates, basedOnSamples: data.basedOnSamples, generated: new Date().toISOString() })
        setTab('templates')
        const rosMsg = data.rosImported > 0 ? `，已自動套用 ${data.rosImported} 個到 ROS` : '（ROS 未連線，可手動套用）'
        showFeedback({ type: 'success', msg: `✅ 已根據 ${data.basedOnSamples} 個樣本生成模板${rosMsg}` })
      } else {
        showFeedback({ type: 'error', msg: `❌ ${data.error}` })
      }
    } finally {
      setLoading(l => ({ ...l, export: false }))
    }
  }

  async function applyTemplate(category, text) {
    const key = `${category}::${text}`
    setApplyingTemplate(key)
    try {
      const r = await fetch(`${API}/templates/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, text }),
      })
      const data = await r.json()
      if (r.ok && data.ok) {
        setTemplates(prev => ({
          ...prev,
          templates: {
            ...prev.templates,
            [category]: prev.templates[category].map(item =>
              item.text === text ? { ...item, applied: true, appliedAt: new Date().toISOString() } : item
            ),
          },
        }))
      } else {
        showFeedback({ type: 'error', msg: `❌ 套用失敗：${data.error}` })
      }
    } finally {
      setApplyingTemplate(null)
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
      if (assistantRecRef.current) assistantRecRef.current._autoSubmit = false
      assistantRecRef.current?.stop()
      return
    }

    const rec = new SR()
    rec.lang = 'zh-TW'
    rec.continuous = false
    rec.interimResults = true
    rec._autoSubmit = true  // auto-send when mic ends naturally
    assistantRecRef.current = rec

    rec.onstart = () => { setAssistantListening(true); setAssistantInterim('') }
    rec.onresult = (e) => {
      let fin = '', intr = ''
      for (const r of e.results) {
        if (r.isFinal) fin += r[0].transcript
        else intr += r[0].transcript
      }
      if (fin) {
        const newVal = assistantInputRef.current ? assistantInputRef.current + ' ' + fin : fin
        assistantInputRef.current = newVal
        setAssistantInput(newVal)
      }
      setAssistantInterim(intr)
    }
    rec.onerror = () => { setAssistantListening(false); setAssistantInterim('') }
    rec.onend = () => {
      setAssistantListening(false)
      setAssistantInterim('')
      if (rec._autoSubmit && assistantInputRef.current.trim()) {
        sendAssistantRef.current?.()
      }
    }
    rec.start()
  }

  function sendToAssistant() {
    const msg = (assistantInputRef.current || assistantInput).trim()
    if (!msg || loading.assistant) return
    assistantInputRef.current = ''
    setAssistantInput('')
    setAssistantInterim('')

    const msgId = Date.now().toString()
    const streamId = msgId + '-ai'
    const catForMsg = interviewCategory
    const lastAIQuestion = chatHistory.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '日常對話練習'
    const historySnap = chatHistory.map(({ role, content }) => ({ role, content }))

    const futureCounts = { ...sessionCatCounts, [catForMsg.id]: (sessionCatCounts[catForMsg.id] || 0) + 1 }
    const nextCat = CATEGORIES.reduce((best, cat) => {
      const b = (profile?.byCategory?.[best.id]?.samples || 0) + (futureCounts[best.id] || 0)
      const c = (profile?.byCategory?.[cat.id]?.samples  || 0) + (futureCounts[cat.id]  || 0)
      return c < b ? cat : best
    })

    // Abort any previous stream before starting a new one
    assistantAbortRef.current?.abort()
    const ctrl = new AbortController()
    assistantAbortRef.current = ctrl

    // Add user message + empty streaming placeholder in one update
    setChatHistory(h => [...h,
      { role: 'user', content: msg, saving: true, id: msgId, catLabel: catForMsg.label },
      { role: 'assistant', content: '', id: streamId, streaming: true },
    ])
    setLoading(l => ({ ...l, assistant: true }))

    streamSSE(
      `${API}/assistant/chat/stream`,
      { messages: historySnap, userMessage: msg, interviewMode: true, interviewCategory: nextCat.id },
      (full) => setChatHistory(h => h.map(m => m.id === streamId ? { ...m, content: full } : m)),
      (full) => {
        setChatHistory(h => h.map(m => m.id === streamId ? { ...m, content: full, streaming: false } : m))
        setSessionCatCounts(c => ({ ...c, [catForMsg.id]: (c[catForMsg.id] || 0) + 1 }))
        setLoading(l => ({ ...l, assistant: false }))
        speak(full, () => {
          if (autoMicRef.current && !assistantListeningRef.current)
            setTimeout(() => toggleAssistantVoiceRef.current?.(), 350)
        })
      },
      () => {
        setChatHistory(h => h.map(m => m.id === streamId ? { ...m, content: '⚠️ 連線失敗，請重試', streaming: false } : m))
        setLoading(l => ({ ...l, assistant: false }))
      },
      ctrl.signal,
    )

    // Parallel fast analyze (fire-and-forget)
    fetch(`${API}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: lastAIQuestion, response: msg, category: catForMsg.id, fast: true }),
    }).then(r => r.json()).then(data => {
      if (data.profile) { setProfile(data.profile); fetchHistory() }
      setChatHistory(h => h.map(m => m.id === msgId ? { ...m, saving: false, saved: true } : m))
    }).catch(() => {
      setChatHistory(h => h.map(m => m.id === msgId ? { ...m, saving: false } : m))
    })
  }

  function saveSessionMemory(history, samplesCount) {
    const userMsgs = history.filter(m => m.role === 'user' && m.content?.trim())
    if (userMsgs.length < 2) return
    const messages = history.map(({ role, content }) => ({ role, content: content || '' }))
    fetch(`${API}/session/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, sessionSamples: samplesCount }),
    }).then(r => r.json()).then(data => {
      if (data.memory) setMemories(prev => [...prev, data.memory].slice(-20))
    }).catch(() => {})
  }

  function startInterview() {
    if (loading.assistant) return
    // Save current session memory before resetting
    if (chatHistory.length > 0) saveSessionMemory(chatHistory, sessionSamples)
    assistantAbortRef.current?.abort()
    const ctrl = new AbortController()
    assistantAbortRef.current = ctrl

    setSessionCatCounts({})
    const firstCat = CATEGORIES.reduce((best, cat) => {
      const b = profile?.byCategory?.[best.id]?.samples || 0
      const c = profile?.byCategory?.[cat.id]?.samples  || 0
      return c < b ? cat : best
    })
    const streamId = 'start-stream'
    setChatHistory([{ role: 'assistant', content: '', id: streamId, streaming: true }])
    setLoading(l => ({ ...l, assistant: true }))

    streamSSE(
      `${API}/assistant/chat/stream`,
      { messages: [], interviewMode: true, interviewCategory: firstCat.id, isStart: true },
      (full) => setChatHistory(h => h.map(m => m.id === streamId ? { ...m, content: full } : m)),
      (full) => {
        setChatHistory(h => h.map(m => m.id === streamId ? { ...m, content: full, streaming: false } : m))
        setLoading(l => ({ ...l, assistant: false }))
        speak(full, () => {
          if (autoMicRef.current && !assistantListeningRef.current)
            setTimeout(() => toggleAssistantVoiceRef.current?.(), 350)
        })
      },
      () => {
        setChatHistory([{ role: 'assistant', content: '⚠️ 無法連線，請重新整理', id: 'start' }])
        setLoading(l => ({ ...l, assistant: false }))
      },
      ctrl.signal,
    )
  }

  function startStyleChat(style) {
    styleAbortRef.current?.abort()
    const ctrl = new AbortController()
    styleAbortRef.current = ctrl

    setSelectedStyle(style)
    styleInputRef.current = ''
    setStyleInput('')
    const streamId = 'style-start'
    setStyleChatHistory([{ role: 'assistant', content: '', id: streamId, streaming: true }])
    setStyleLoading(true)

    streamSSE(
      `${API}/style/chat/stream`,
      { messages: [], styleId: style.id, isStart: true },
      (full) => setStyleChatHistory(h => h.map(m => m.id === streamId ? { ...m, content: full } : m)),
      (full) => {
        setStyleChatHistory(h => h.map(m => m.id === streamId ? { ...m, content: full, streaming: false } : m))
        setStyleLoading(false)
        speak(full, () => {
          if (autoMicRef.current && !styleListeningRef.current)
            setTimeout(() => toggleStyleVoiceRef.current?.(), 350)
        })
      },
      () => {
        setStyleChatHistory([{ role: 'assistant', content: '⚠️ 無法連線，請重新整理', id: 'style-start-err' }])
        setStyleLoading(false)
      },
      ctrl.signal,
    )
  }

  function sendStyleMessage() {
    const msg = (styleInputRef.current || styleInput).trim()
    if (!msg || styleLoading) return
    styleInputRef.current = ''
    setStyleInput('')
    setStyleInterim('')

    const msgId = Date.now().toString()
    const streamId = msgId + '-ai'
    const historySnap = styleChatHistory.map(({ role, content }) => ({ role, content }))

    styleAbortRef.current?.abort()
    const styleCtrl = new AbortController()
    styleAbortRef.current = styleCtrl

    setStyleChatHistory(h => [...h,
      { role: 'user', content: msg, id: msgId },
      { role: 'assistant', content: '', id: streamId, streaming: true },
    ])
    setStyleLoading(true)

    streamSSE(
      `${API}/style/chat/stream`,
      { messages: historySnap, userMessage: msg, styleId: selectedStyle.id },
      (full) => setStyleChatHistory(h => h.map(m => m.id === streamId ? { ...m, content: full } : m)),
      (full) => {
        setStyleChatHistory(h => h.map(m => m.id === streamId ? { ...m, content: full, streaming: false } : m))
        setStyleLoading(false)
        speak(full, () => {
          if (autoMicRef.current && !styleListeningRef.current)
            setTimeout(() => toggleStyleVoiceRef.current?.(), 350)
        })
      },
      () => {
        setStyleChatHistory(h => h.map(m => m.id === streamId ? { ...m, content: '⚠️ 連線失敗，請重試', streaming: false } : m))
        setStyleLoading(false)
      },
      styleCtrl.signal,
    )
  }

  function toggleStyleVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { alert('此瀏覽器不支援語音輸入，請改用 Chrome 或 Safari。'); return }

    if (styleListening) {
      if (styleRecRef.current) styleRecRef.current._autoSubmit = false
      styleRecRef.current?.stop()
      return
    }

    const rec = new SR()
    rec.lang = 'zh-TW'
    rec.continuous = false
    rec.interimResults = true
    rec._autoSubmit = true
    styleRecRef.current = rec

    rec.onstart = () => { setStyleListening(true); setStyleInterim('') }
    rec.onresult = (e) => {
      let fin = '', intr = ''
      for (const r of e.results) {
        if (r.isFinal) fin += r[0].transcript
        else intr += r[0].transcript
      }
      if (fin) {
        const newVal = styleInputRef.current ? styleInputRef.current + ' ' + fin : fin
        styleInputRef.current = newVal
        setStyleInput(newVal)
      }
      setStyleInterim(intr)
    }
    rec.onerror = () => { setStyleListening(false); setStyleInterim('') }
    rec.onend = () => {
      setStyleListening(false)
      setStyleInterim('')
      if (rec._autoSubmit && styleInputRef.current.trim()) styleSendRef.current?.()
    }
    rec.start()
  }

  const totalSamples = profile?.totalSamples || 0
  const readyForExport = totalSamples >= 5
  const sessionSamples = useMemo(
    () => Object.values(sessionCatCounts).reduce((s, c) => s + c, 0),
    [sessionCatCounts],
  )
  const interviewCategory = useMemo(() => CATEGORIES.reduce((best, cat) => {
    const b = (profile?.byCategory?.[best.id]?.samples || 0) + (sessionCatCounts[best.id] || 0)
    const c = (profile?.byCategory?.[cat.id]?.samples  || 0) + (sessionCatCounts[cat.id]  || 0)
    return c < b ? cat : best
  }), [profile, sessionCatCounts])

  // Keep refs current (all mutated each render so closures never go stale)
  sendAssistantRef.current = sendToAssistant
  styleSendRef.current = sendStyleMessage
  autoMicRef.current = autoMicEnabled
  assistantListeningRef.current = assistantListening
  styleListeningRef.current = styleListening
  toggleAssistantVoiceRef.current = toggleAssistantVoice
  toggleStyleVoiceRef.current = toggleStyleVoice

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
      {tab !== 'assistant' && tab !== 'styles' && (
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
        {tab !== 'assistant' && tab !== 'styles' && (
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
            {[['train', '🎙 收集訓練'], ['assistant', '🤖 AI 助手'], ['styles', '🎨 風格練習'], ['profile', '📊 風格報告'], ['history', '📜 歷史記錄'], ['templates', '💬 ROS 模板']].map(([id, label]) => (
              <button key={id} style={s.tabBtn(tab === id)} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {/* Feedback */}
          {feedback && tab !== 'assistant' && tab !== 'styles' && (
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 11px', borderRadius: 20, background: '#6c63ff22', border: '1px solid #6c63ff44' }}>
                    <span>{interviewCategory.emoji}</span>
                    <span style={{ fontSize: 13, color: '#9d96ff', fontWeight: 600 }}>{interviewCategory.label}</span>
                  </div>
                  <span style={{ fontSize: 12, color: '#555' }}>
                    本次 <strong style={{ color: '#22c55e' }}>{sessionSamples}</strong> 個
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => setAutoMicEnabled(e => !e)}
                    title={autoMicEnabled ? '關閉自動接麥' : '開啟自動接麥（AI說完後自動錄音）'}
                    style={{
                      padding: '4px 11px', borderRadius: 20, border: 'none', fontSize: 12, cursor: 'pointer',
                      background: autoMicEnabled ? '#22c55e22' : '#1e1e2a',
                      color: autoMicEnabled ? '#22c55e' : '#444',
                      outline: autoMicEnabled ? '1px solid #22c55e44' : 'none',
                    }}
                  >
                    {autoMicEnabled ? '🔄 關閉自動接麥' : '🔄 開啟自動接麥'}
                  </button>
                  <button
                    onClick={startInterview}
                    disabled={loading.assistant}
                    style={{ padding: '4px 11px', borderRadius: 20, border: 'none', background: '#1e1e2a', color: '#555', fontSize: 12, cursor: 'pointer' }}
                  >
                    ↺ 重開
                  </button>
                </div>
              </div>

              {/* Category progress bars */}
              <div style={{ display: 'flex', gap: 3, marginBottom: 10 }}>
                {CATEGORIES.map(cat => {
                  const profCount = profile?.byCategory?.[cat.id]?.samples || 0
                  const sessCount = sessionCatCounts[cat.id] || 0
                  const isCurrent = cat.id === interviewCategory.id
                  const pctProf = Math.min(100, Math.round((profCount / 10) * 100))
                  const pctSess = Math.min(100 - pctProf, Math.round((sessCount / 10) * 100))
                  return (
                    <div key={cat.id} style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: isMobile ? 10 : 11, marginBottom: 2, opacity: isCurrent ? 1 : 0.45 }}>{cat.emoji}</div>
                      <div style={{ height: 4, background: '#0d0d15', borderRadius: 2, overflow: 'hidden', outline: isCurrent ? '1px solid #6c63ff55' : 'none', position: 'relative' }}>
                        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pctProf}%`, background: isCurrent ? '#6c63ff' : '#2a2a4a', borderRadius: 2 }} />
                        {sessCount > 0 && <div style={{ position: 'absolute', left: `${pctProf}%`, top: 0, height: '100%', width: `${pctSess}%`, background: isCurrent ? '#9d96ff88' : '#44448888', borderRadius: 2 }} />}
                      </div>
                      <div style={{ fontSize: 9, color: isCurrent ? '#9d96ff' : '#333', marginTop: 1 }}>
                        {profCount}{sessCount > 0 ? `+${sessCount}` : ''}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div style={{ fontSize: 11, color: '#444', marginBottom: 8 }}>
                說完後自動送出 · 回答存為樣本 · 集滿各類別後點「套用到 ROS」
              </div>

              {/* Chat messages */}
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 12 }}>
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
                        {msg.streaming && !msg.content
                          ? <span style={{ color: '#555' }}>思考中<span style={{ animation: 'pulse 1s infinite' }}>…</span></span>
                          : msg.content}
                        {msg.streaming && msg.content && <span style={{ color: '#6c63ff', opacity: 0.7 }}> ▋</span>}
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
                      {msg.role === 'assistant' && !msg.streaming && ttsEnabled && (
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
                    placeholder="用最自然的方式回答 AI 的問題…（或按 🎤 說完自動送出）"
                    onChange={e => { assistantInputRef.current = e.target.value; setAssistantInput(e.target.value) }}
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

          {/* ── STYLES TAB ── */}
          {tab === 'styles' && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              {!selectedStyle ? (
                <div>
                  <div style={{ fontSize: 13, color: '#666', marginBottom: 16, lineHeight: 1.6 }}>
                    選擇一種說話風格，AI 教練會出情境讓你練習，並即時評分回饋。
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 10 }}>
                    {STYLE_PRESETS.map(style => (
                      <button
                        key={style.id}
                        onClick={() => startStyleChat(style)}
                        style={{
                          background: '#13131a', border: `1px solid ${style.color}33`,
                          borderRadius: 12, padding: isMobile ? '14px 10px' : '18px 12px',
                          cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s',
                          color: 'inherit',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = style.color + '88'; e.currentTarget.style.background = style.color + '11' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = style.color + '33'; e.currentTarget.style.background = '#13131a' }}
                      >
                        <div style={{ fontSize: isMobile ? 28 : 34, marginBottom: 8 }}>{style.emoji}</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 4 }}>{style.name}</div>
                        <div style={{ fontSize: 11, color: '#666', lineHeight: 1.4 }}>{style.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                  {/* Top bar */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        onClick={() => { setSelectedStyle(null); setStyleChatHistory([]) }}
                        style={{ padding: '4px 10px', borderRadius: 20, border: 'none', background: '#1e1e2a', color: '#888', fontSize: 12, cursor: 'pointer' }}
                      >
                        ← 換風格
                      </button>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 11px', borderRadius: 20, background: selectedStyle.color + '22', border: `1px solid ${selectedStyle.color}44` }}>
                        <span>{selectedStyle.emoji}</span>
                        <span style={{ fontSize: 13, color: selectedStyle.color, fontWeight: 600 }}>{selectedStyle.name}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => setAutoMicEnabled(e => !e)}
                        title={autoMicEnabled ? '關閉自動接麥' : '開啟自動接麥（AI說完後自動錄音）'}
                        style={{
                          padding: '4px 11px', borderRadius: 20, border: 'none', fontSize: 12, cursor: 'pointer',
                          background: autoMicEnabled ? '#22c55e22' : '#1e1e2a',
                          color: autoMicEnabled ? '#22c55e' : '#444',
                          outline: autoMicEnabled ? '1px solid #22c55e44' : 'none',
                        }}
                      >
                        {autoMicEnabled ? '🔄 關閉自動接麥' : '🔄 開啟自動接麥'}
                      </button>
                      <button
                        onClick={() => startStyleChat(selectedStyle)}
                        disabled={styleLoading}
                        style={{ padding: '4px 11px', borderRadius: 20, border: 'none', background: '#1e1e2a', color: '#555', fontSize: 12, cursor: 'pointer' }}
                      >
                        ↺ 重開
                      </button>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: '#444', marginBottom: 8 }}>
                    {selectedStyle.desc} · AI 即時評分 · 說完自動送出
                  </div>

                  {/* Chat messages */}
                  <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 12 }}>
                    {styleChatHistory.map((msg, idx) => (
                      <div key={msg.id || idx} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: 8, alignItems: 'flex-end' }}>
                        {msg.role === 'assistant' && (
                          <div style={{ width: 28, height: 28, borderRadius: '50%', background: selectedStyle.color + '33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>
                            {selectedStyle.emoji}
                          </div>
                        )}
                        <div style={{ maxWidth: '75%' }}>
                          <div style={{
                            padding: '10px 14px',
                            borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                            background: msg.role === 'user' ? selectedStyle.color : '#1e1e2a',
                            color: '#fff', fontSize: 14, lineHeight: 1.65,
                          }}>
                            {msg.streaming && !msg.content
                              ? <span style={{ color: '#555' }}>思考中<span style={{ animation: 'pulse 1s infinite' }}>…</span></span>
                              : msg.content}
                            {msg.streaming && msg.content && <span style={{ color: selectedStyle.color, opacity: 0.7 }}> ▋</span>}
                          </div>
                          {msg.role === 'assistant' && !msg.streaming && ttsEnabled && (
                            <button
                              onClick={() => speak(msg.content)}
                              style={{ marginTop: 4, padding: '2px 10px', borderRadius: 20, border: 'none', background: '#1e1e2a', color: '#555', fontSize: 11, cursor: 'pointer' }}
                            >
                              🔊 重播
                            </button>
                          )}
                        </div>
                        {msg.role === 'user' && (
                          <div style={{ width: 28, height: 28, borderRadius: '50%', background: selectedStyle.color + '44', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>
                            😊
                          </div>
                        )}
                      </div>
                    ))}
                    <div ref={styleChatEndRef} />
                  </div>

                  {/* Input area */}
                  <div style={{ borderTop: '1px solid #1e1e2a', paddingTop: 12 }}>
                    {styleListening && (
                      <div style={{ fontSize: 12, color: '#f59e0b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                        錄音中…{styleInterim && <span style={{ color: '#888', fontStyle: 'italic' }}>{styleInterim}</span>}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <textarea
                        style={{ ...s.textarea, minHeight: 52, flex: 1 }}
                        value={styleInput}
                        onChange={e => { styleInputRef.current = e.target.value; setStyleInput(e.target.value) }}
                        placeholder={`用「${selectedStyle.name}」風格回答…（或按 🎤 說完自動送出）`}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendStyleMessage() } }}
                        rows={2}
                      />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <button
                          onClick={toggleStyleVoice}
                          style={{
                            padding: '10px 14px', borderRadius: 8, border: 'none', fontSize: 18, cursor: 'pointer',
                            background: styleListening ? '#ef444433' : '#1e1e2a',
                            color: styleListening ? '#fca5a5' : '#888',
                          }}
                          title="語音輸入"
                        >
                          {styleListening ? '⏹' : '🎤'}
                        </button>
                        <button
                          onClick={sendStyleMessage}
                          disabled={!styleInput.trim() || styleLoading}
                          style={{
                            padding: '10px 14px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 16,
                            cursor: 'pointer', background: selectedStyle.color, color: '#fff',
                            opacity: styleInput.trim() && !styleLoading ? 1 : 0.4,
                          }}
                        >
                          ↑
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: '#333', marginTop: 6 }}>Enter 送出 · Shift+Enter 換行</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── PROFILE TAB ── */}
          {tab === 'profile' && !totalSamples && (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <div style={{ fontSize: 32, marginBottom: 16 }}>🧬</div>
              <div style={{ color: '#666' }}>還沒有樣本。先到「🎙 收集訓練」或「🤖 AI 助手」回答幾個題目吧！</div>
            </div>
          )}
          {tab === 'profile' && !!totalSamples && profile && (
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

              {memories.length > 0 && (
                <div style={s.card}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>🧠 跨場次記憶</div>
                  {[...memories].reverse().map((m, i) => (
                    <div key={i} style={{ background: '#0d0d15', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, color: '#555' }}>{new Date(m.at).toLocaleString('zh-TW')}</span>
                        <span style={{ fontSize: 11, color: '#444' }}>{m.sessionLength} 輪對話</span>
                      </div>
                      <div style={{ fontSize: 13, color: '#bbb', lineHeight: 1.6, marginBottom: 6 }}>{m.insight}</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {m.focusNext?.map(id => {
                          const cat = CATEGORIES.find(c => c.id === id)
                          return cat ? (
                            <span key={id} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#6c63ff22', color: '#9d96ff', border: '1px solid #6c63ff33' }}>
                              補 {cat.emoji}{cat.label}
                            </span>
                          ) : null
                        })}
                        {m.strong?.map(id => {
                          const cat = CATEGORIES.find(c => c.id === id)
                          return cat ? (
                            <span key={id} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#22c55e22', color: '#86efac', border: '1px solid #22c55e33' }}>
                              強 {cat.emoji}{cat.label}
                            </span>
                          ) : null
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
              {!templates?.templates ? (
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
              ) : (() => {
                // Flatten all templates into { cat, item } pairs, split by applied state
                const allItems = Object.entries(templates.templates).flatMap(([cat, items]) =>
                  (items || []).map(item => ({ cat, item: typeof item === 'string' ? { text: item, applied: false } : item }))
                )
                const unapplied = allItems.filter(x => !x.item.applied)
                const applied   = allItems.filter(x => x.item.applied)

                const renderItem = ({ cat, item }) => {
                  const catInfo = CATEGORIES.find(c => c.id === cat)
                  const key = `${cat}::${item.text}`
                  const isApplying = applyingTemplate === key
                  return (
                    <div key={key} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10,
                      background: item.applied ? '#0a1a0a' : '#0d0d15',
                      border: `1px solid ${item.applied ? '#22c55e22' : '#1e1e2a'}`,
                      borderRadius: 8, padding: '10px 12px', marginBottom: 8,
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: item.applied ? '#22c55e88' : '#555', marginBottom: 4 }}>
                          {catInfo?.emoji} {catInfo?.label || cat}
                          {item.applied && item.appliedAt && (
                            <span style={{ marginLeft: 8 }}>· {new Date(item.appliedAt).toLocaleDateString('zh-TW')}</span>
                          )}
                        </div>
                        <div style={{ fontSize: 13, color: item.applied ? '#aaa' : '#ddd', lineHeight: 1.6 }}>
                          {item.text}
                        </div>
                      </div>
                      {item.applied ? (
                        <span style={{ fontSize: 11, color: '#22c55e', whiteSpace: 'nowrap', paddingTop: 2, flexShrink: 0 }}>✓ 已套用</span>
                      ) : (
                        <button
                          onClick={() => applyTemplate(cat, item.text)}
                          disabled={!!applyingTemplate}
                          style={{
                            padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 12, cursor: 'pointer', flexShrink: 0,
                            background: isApplying ? '#1e1e2a' : '#6c63ff22',
                            color: isApplying ? '#555' : '#9d96ff',
                            outline: '1px solid #6c63ff33',
                          }}
                        >
                          {isApplying ? '套用中…' : '套用 ROS'}
                        </button>
                      )}
                    </div>
                  )
                }

                return (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <div style={{ fontSize: 12, color: '#555' }}>
                        基於 {templates.basedOnSamples} 個樣本 ·
                        {applied.length}/{allItems.length} 個已套用到 ROS
                      </div>
                      <button style={{ ...s.btn('secondary'), fontSize: 12, padding: '6px 12px' }}
                        onClick={generateTemplates} disabled={loading.export || !readyForExport}>
                        {loading.export ? '生成中…' : '🔄 重新生成'}
                      </button>
                    </div>

                    {unapplied.length > 0 && (
                      <div style={{ marginBottom: 24 }}>
                        <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
                          未套用（{unapplied.length} 個）
                        </div>
                        {unapplied.map(renderItem)}
                      </div>
                    )}

                    {applied.length > 0 && (
                      <div>
                        <div style={{ fontSize: 12, color: '#22c55e88', fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                          已套用到 Relationship OS（{applied.length} 個）
                        </div>
                        {applied.map(renderItem)}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )}
        </div>

        {/* Right panel — quick stats (hide for assistant tab) */}
        {tab !== 'assistant' && tab !== 'styles' && (
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
