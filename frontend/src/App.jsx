import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  LiveKitRoom,
  useVoiceAssistant,
  BarVisualizer,
  RoomAudioRenderer,
  useLocalParticipant,
  useChat,
} from '@livekit/components-react';
import {
  Mic,
  MicOff,
  PhoneOff,
  MessageSquare,
  Sparkles,
  Cpu,
  Volume2,
  Play,
  RotateCw,
  History,
  ArrowLeft,
  Calendar,
  MessageCircle,
  AlertCircle,
} from 'lucide-react';
import '@livekit/components-styles';

// H8: Shared fetch & date utility functions to eliminate duplicate code
const getTokenServerUrl = () => {
  if (import.meta.env.VITE_TOKEN_SERVER_URL) {
    return import.meta.env.VITE_TOKEN_SERVER_URL;
  }
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:8081`;
};

const TOKEN_SERVER_URL = getTokenServerUrl();

// Labels reflect the actual Kokoro voices the agent maps these values to
// (see KOKORO_VOICE_MAP in backend/agent.py). The value keys are kept so no
// backend change is needed.
const VOICE_OPTIONS = [
  { value: 'alloy', label: 'Bella (Female · warm)' },        // af_bella
  { value: 'nova', label: 'Nicole (Female · soft)' },        // af_nicole
  { value: 'shimmer', label: 'Sarah (Female)' },             // af_sarah
  { value: 'echo', label: 'Adam (Male)' },                   // am_adam
  { value: 'onyx', label: 'Michael (Male · deep)' },         // am_michael
  { value: 'fable', label: 'Emma (Female · British)' },      // bf_emma
];

const fetchConversationsAPI = async () => {
  const res = await fetch(`${TOKEN_SERVER_URL}/conversations`);
  if (!res.ok) {
    throw new Error(`Failed to load sessions list (HTTP ${res.status})`);
  }
  return res.json();
};

const fetchSessionMessagesAPI = async (roomName) => {
  const res = await fetch(`${TOKEN_SERVER_URL}/conversations/${roomName}/messages`);
  if (!res.ok) {
    throw new Error(`Failed to load messages (HTTP ${res.status})`);
  }
  return res.json();
};

const formatDateHelper = (dateStr) => {
  try {
    // Postgres returns "YYYY-MM-DD HH:MM:SS.ffffff" (space-separated, no TZ). Safari/Firefox
    // reject that form, so normalize the space to 'T' for cross-browser ISO parsing.
    const normalized = typeof dateStr === 'string' ? dateStr.replace(' ', 'T') : dateStr;
    const d = new Date(normalized);
    if (isNaN(d.getTime())) {
      return dateStr;
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return dateStr;
  }
};

// H6: Standard Error Boundary Component to prevent white screen crashes
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an uncaught React error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0d0822', color: '#fff' }}>
          <div className="ambient-bg" />
          <div className="connect-container" style={{ maxWidth: '440px', padding: '40px 30px', textAlign: 'center', gap: '20px' }}>
            <div className="connect-icon-wrapper" style={{ width: '64px', height: '64px', borderRadius: '20px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
              <AlertCircle size={28} />
            </div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: '600' }}>Application Crash Detected</h2>
            <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.9rem', lineHeight: '1.5' }}>
              {this.state.error?.message || "An unexpected rendering error occurred inside the assistant client."}
            </p>
            <button
              className="btn-circle btn-accent"
              onClick={() => window.location.reload()}
              style={{ width: 'auto', borderRadius: '50px', padding: '0 30px', fontSize: '0.9rem', height: '44px', marginTop: '10px' }}
            >
              Restart Application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Shared "Saved History" tab content. Self-contained (REST only, no LiveKit context
// required) so it renders identically whether or not a live session is active.
function HistoryTab({ onReconnect }) {
  const [pastConversations, setPastConversations] = useState([]);
  const [selectedPastConv, setSelectedPastConv] = useState(null);
  const [pastMessages, setPastMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const chatEndRef = useRef(null);

  const loadConversations = async () => {
    setIsLoading(true);
    setError(null);
    try {
      setPastConversations(await fetchConversationsAPI());
    } catch (e) {
      console.error('Error fetching past sessions:', e);
      setError(e.message || 'Failed to retrieve saved history.');
    } finally {
      setIsLoading(false);
    }
  };

  const loadSession = async (roomName) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchSessionMessagesAPI(roomName);
      setPastMessages(data);
      setSelectedPastConv(roomName);
    } catch (e) {
      console.error('Error loading session messages:', e);
      setError(e.message || 'Failed to load conversation history.');
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch the session list when this tab first mounts
  useEffect(() => {
    loadConversations();
  }, []);

  // Scroll to the latest message when a session opens
  useEffect(() => {
    if (selectedPastConv && !isLoading) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [pastMessages, selectedPastConv, isLoading]);

  return (
    <div className="history-container" id="saved-history-panel" role="tabpanel" aria-labelledby="saved-history-tab">
      {selectedPastConv ? (
        /* INDIVIDUAL PAST SESSION MESSAGES */
        <div className="history-chat-view">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px', borderBottom: '1px solid var(--glass-border)', background: 'rgba(0,0,0,0.1)' }}>
            <button className="back-btn" onClick={() => setSelectedPastConv(null)} style={{ margin: 0, padding: '0 10px', width: 'auto', background: 'transparent', border: 'none' }}>
              <ArrowLeft size={16} />
              <span>Sessions</span>
            </button>
            <button
              className="btn-circle btn-accent"
              onClick={() => onReconnect(selectedPastConv)}
              style={{ width: 'auto', borderRadius: '50px', padding: '0 20px', height: '36px', fontSize: '0.85rem', display: 'flex', gap: '6px', margin: 0 }}
            >
              <Play size={14} fill="white" />
              <span>Continue</span>
            </button>
          </div>

          {isLoading ? (
            <div className="history-empty">
              <RotateCw size={32} className="animate-spin text-violet-400" />
              <p>Loading session messages...</p>
            </div>
          ) : error ? (
            <div className="history-empty text-red-500">
              <AlertCircle size={32} />
              <p>{error}</p>
            </div>
          ) : (
            <div className="chat-scroll">
              {pastMessages.length === 0 ? (
                <p className="no-msgs">No messages found in this session.</p>
              ) : (
                pastMessages.map((msg, idx) => {
                  const isUser = msg.role === 'user';
                  return (
                    <div key={`past-${idx}`} className={`chat-bubble-wrapper ${isUser ? 'user' : 'agent'}`}>
                      <div className="bubble">{msg.content}</div>
                      <div className="bubble-meta">{isUser ? 'You' : 'Agent'}</div>
                    </div>
                  );
                })
              )}
              <div ref={chatEndRef} />
            </div>
          )}
        </div>
      ) : (
        /* LIST OF SAVED SESSIONS */
        <div className="history-list-view">
          {isLoading ? (
            <div className="history-empty">
              <RotateCw size={32} className="animate-spin text-violet-400" />
              <p>Loading saved sessions...</p>
            </div>
          ) : error ? (
            <div className="history-empty text-red-500">
              <AlertCircle size={32} />
              <p>{error}</p>
            </div>
          ) : pastConversations.length === 0 ? (
            <div className="history-empty">
              <History size={40} className="text-gray-700" />
              <p>No saved conversation logs found yet.</p>
            </div>
          ) : (
            <div className="session-list">
              {pastConversations.map((conv) => (
                <button
                  key={conv.id}
                  className="session-card"
                  onClick={() => loadSession(conv.room_name)}
                  style={{ width: '100%', background: 'transparent', textAlign: 'left', border: '1px solid var(--glass-border)', display: 'block' }}
                  aria-label={`View conversation from ${formatDateHelper(conv.created_at)}`}
                >
                  <div className="session-card-header">
                    <span className="session-title">{conv.title || `Session #${conv.id}`}</span>
                    <Calendar size={14} className="text-gray-500" />
                  </div>
                  <span className="session-date">{formatDateHelper(conv.created_at)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Shared right-hand panel: "Active Session" tab (live content passed in) + "Saved History" tab.
function ChatPanel({ activeContent, onReconnect }) {
  const [activeTab, setActiveTab] = useState('active');

  return (
    <div className="transcript-panel">
      <div className="tab-header" role="tablist" aria-label="Session logs tabs">
        <button
          className={`tab-btn ${activeTab === 'active' ? 'active' : ''}`}
          onClick={() => setActiveTab('active')}
          role="tab"
          aria-selected={activeTab === 'active'}
          aria-controls="active-session-panel"
          id="active-session-tab"
        >
          <MessageCircle size={16} />
          <span>Active Session</span>
        </button>
        <button
          className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
          role="tab"
          aria-selected={activeTab === 'history'}
          aria-controls="saved-history-panel"
          id="saved-history-tab"
        >
          <History size={16} />
          <span>Saved History</span>
        </button>
      </div>

      {activeTab === 'active' ? activeContent : <HistoryTab onReconnect={onReconnect} />}
    </div>
  );
}

// CONNECTED view: live orb, mic/hang-up controls, and the live transcript. Uses LiveKit hooks,
// so it only ever renders inside <LiveKitRoom>.
function LiveDashboard({ onHangUp, onReconnect }) {
  const { state: agentState, audioTrack, agentTranscriptions } = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();
  const { chatMessages } = useChat();
  const [showTranscript, setShowTranscript] = useState(true);
  const activeChatEndRef = useRef(null);
  const statusDescRef = useRef(null);

  // Scroll active chat to bottom on new messages
  useEffect(() => {
    activeChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Auto scroll status description to bottom when it changes (for long transcriptions)
  useEffect(() => {
    if (statusDescRef.current) {
      statusDescRef.current.scrollTop = statusDescRef.current.scrollHeight;
    }
  }, [agentState, agentTranscriptions]);

  const isMuted = localParticipant ? !localParticipant.isMicrophoneEnabled : false;
  const toggleMic = useCallback(() => {
    if (localParticipant) {
      localParticipant.setMicrophoneEnabled(isMuted);
    }
  }, [localParticipant, isMuted]);

  const getStatusDetails = () => {
    switch (agentState) {
      case 'connecting':
        return { label: 'Connecting', desc: 'Warming up engines...' };
      case 'initializing':
        return { label: 'Initializing', desc: 'Syncing cognitive systems...' };
      case 'listening':
        return { label: 'Listening', desc: "Go ahead, I'm listening closely..." };
      case 'thinking':
        return { label: 'Thinking', desc: 'Formulating a smart response...' };
      case 'speaking': {
        const lastSegment = agentTranscriptions && agentTranscriptions.length > 0
          ? agentTranscriptions[agentTranscriptions.length - 1]
          : null;
        const transcript = lastSegment ? lastSegment.text : '';
        return { label: 'Speaking', desc: transcript || 'Synthesizing voice...' };
      }
      default:
        return { label: 'Ready', desc: 'Awaiting your command...' };
    }
  };

  const status = getStatusDetails();

  const getOrbStateClass = () => {
    if (agentState === 'connecting' || agentState === 'initializing') return 'connecting';
    if (agentState === 'listening') return 'listening';
    if (agentState === 'thinking') return 'thinking';
    if (agentState === 'speaking') return 'speaking';
    return '';
  };

  // M9: Parse JSON chat messages once on receipt and memoize output to prevent render lag
  const formattedChatMessages = useMemo(() => {
    return chatMessages.map((msg, idx) => {
      let isUser = msg.from?.identity !== 'agent' && !msg.from?.identity?.includes('agent');
      let text = msg.message;
      try {
        const parsed = JSON.parse(msg.message);
        if (parsed && typeof parsed === 'object') {
          if (parsed.sender) {
            isUser = parsed.sender === 'user';
          }
          if (parsed.text) {
            text = parsed.text;
          }
        }
      } catch (e) {
        // Fallback to plain text
      }
      return { id: msg.id || `msg-${idx}`, isUser, text };
    });
  }, [chatMessages]);

  const activeContent = (
    <div className="chat-scroll" id="active-session-panel" role="tabpanel" aria-labelledby="active-session-tab">
      {formattedChatMessages.length === 0 ? (
        <div className="chat-empty">
          <Cpu size={48} className="text-gray-700 animate-pulse" />
          <p>Say hello to your personal voice assistant to start the conversation!</p>
        </div>
      ) : (
        formattedChatMessages.map((msg) => (
          <div key={msg.id} className={`chat-bubble-wrapper ${msg.isUser ? 'user' : 'agent'}`}>
            <div className="bubble">{msg.text}</div>
            <div className="bubble-meta">{msg.isUser ? 'You' : 'Agent'}</div>
          </div>
        ))
      )}
      <div ref={activeChatEndRef} />
    </div>
  );

  return (
    <div className={`dashboard-grid ${showTranscript ? '' : 'minimal'}`}>
      <div className="main-stage">
        <div className="ambient-bg" />

        <div className="header">
          <div className="brand">
            <div className="logo-dot" />
            <h2>KAY</h2>
          </div>
          <div className="status-badge">
            <div className={`badge-dot ${getOrbStateClass()}`} />
            <span>KAY ONLINE</span>
          </div>
        </div>

        <div className="center-stage">
          <div className="orb-wrapper">
            <div className={`fluid-orb ${getOrbStateClass()}`}>
              <div className="orb-inner">
                {agentState === 'speaking' ? (
                  <Volume2 size={36} className="orb-icon text-red-500" />
                ) : agentState === 'thinking' ? (
                  <Sparkles size={36} className="orb-icon text-violet-500" />
                ) : (
                  <Cpu size={36} className="orb-icon text-cyan-500" />
                )}
              </div>
              <div className="orb-glow" />
            </div>
          </div>

          <div className="status-container">
            <div className="status-label">{status.label}</div>
            <div className="status-desc" ref={statusDescRef}>{status.desc}</div>
          </div>

          <div className={`bar-visualizer-container ${agentState === 'speaking' ? 'speaking' : agentState === 'listening' ? 'listening' : ''}`}>
            <BarVisualizer barCount={9} options={{ minHeight: 6, maxHeight: 80 }} track={audioTrack} state={agentState} />
          </div>
        </div>

        <div className="controls-container">
          <button
            className={`btn-circle ${isMuted ? 'btn-red' : 'active'}`}
            onClick={toggleMic}
            aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            title={isMuted ? 'Unmute Mic' : 'Mute Mic'}
          >
            {isMuted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>

          <button
            className={`btn-circle ${showTranscript ? 'active' : ''}`}
            onClick={() => setShowTranscript(!showTranscript)}
            aria-label="Toggle chat transcript panel"
            title="Toggle Transcript Panel"
          >
            <MessageSquare size={22} />
          </button>

          <button
            className="btn-circle btn-red"
            onClick={() => onHangUp()}
            aria-label="Disconnect active voice call"
            title="Disconnect"
          >
            <PhoneOff size={22} />
          </button>
        </div>
      </div>

      <ChatPanel activeContent={activeContent} onReconnect={onReconnect} />
    </div>
  );
}

// DISCONNECTED view: same chat-page layout, but the orb is idle and the controls area holds the
// voice selector + Connect button. The Saved History tab works here too (REST only).
function IdleDashboard({ selectedVoice, onVoiceChange, onConnect, isConnecting, error, onReconnect }) {
  const activeContent = (
    <div className="chat-scroll" id="active-session-panel" role="tabpanel" aria-labelledby="active-session-tab">
      <div className="chat-empty">
        <Cpu size={48} className="text-gray-700 animate-pulse" />
        <p>Choose a voice and press Connect to start talking to Kay.</p>
      </div>
    </div>
  );

  return (
    <div className="dashboard-grid">
      <div className="main-stage">
        <div className="ambient-bg" />

        <div className="header">
          <div className="brand">
            <div className="logo-dot" style={{ background: '#6b7280', boxShadow: 'none' }} />
            <h2>KAY</h2>
          </div>
          <div className="status-badge">
            <div className="badge-dot disconnected" />
            <span>OFFLINE</span>
          </div>
        </div>

        <div className="center-stage">
          <div className="orb-wrapper">
            <div className="fluid-orb">
              <div className="orb-inner">
                <Cpu size={36} className="orb-icon text-cyan-500" />
              </div>
              <div className="orb-glow" />
            </div>
          </div>

          <div className="status-container">
            <div className="status-label">Ready</div>
            <div className="status-desc">Select your assistant voice, then connect.</div>
          </div>

          {/* Voice selector + Connect — the entire entry flow lives here on the chat page */}
          <div className="connect-controls" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', width: '100%', maxWidth: '360px' }}>
            <div className="voice-select-wrapper" style={{ width: '100%' }}>
              <label id="voice-select-label" style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '2px', color: 'rgba(255,255,255,0.35)', display: 'block', marginBottom: '8px', textAlign: 'left', fontWeight: '600' }}>
                Assistant Voice
              </label>
              <select
                value={selectedVoice}
                onChange={(e) => onVoiceChange(e.target.value)}
                className="voice-select"
                aria-labelledby="voice-select-label"
                disabled={isConnecting}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '12px',
                  color: '#fff',
                  fontSize: '0.85rem',
                  outline: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  appearance: 'none',
                  backgroundImage: 'url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'rgba%28255,255,255,0.4%29\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpolyline points=\'6 9 12 15 18 9\'%3E%3C/polyline%3E%3C/svg%3E")',
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 16px center',
                  backgroundSize: '16px',
                  paddingRight: '40px',
                }}
              >
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.value} value={v.value} style={{ background: '#0d0822', color: '#fff' }}>{v.label}</option>
                ))}
              </select>
            </div>

            <button
              className="btn-circle btn-accent"
              onClick={onConnect}
              disabled={isConnecting}
              aria-label={isConnecting ? 'Establishing connection to assistant' : 'Connect to assistant'}
              style={{ width: '100%', borderRadius: '50px', padding: '0 30px', display: 'flex', gap: '8px', fontSize: '0.9rem', height: '48px' }}
            >
              {isConnecting ? (
                <>
                  <RotateCw size={16} className="animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <Play size={16} fill="white" />
                  <span>Connect</span>
                </>
              )}
            </button>

            {error && <p className="error" style={{ color: '#f87171', fontSize: '0.85rem', textAlign: 'center' }}>{error}</p>}
          </div>
        </div>
      </div>

      <ChatPanel activeContent={activeContent} onReconnect={onReconnect} />
    </div>
  );
}

function App() {
  const [token, setToken] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [selectedVoice, setSelectedVoice] = useState('alloy');

  // C5 & H9: Ref to store active reconnection timer to prevent leaks on unmount
  const reconnectTimeoutRef = useRef(null);

  // M8: Ref to store voice state so the connect callback doesn't re-trigger on voice changes
  const selectedVoiceRef = useRef(selectedVoice);
  useEffect(() => {
    selectedVoiceRef.current = selectedVoice;
  }, [selectedVoice]);

  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  // Fetch a LiveKit token and join. No auto-start: only ever called from a user action.
  const connect = useCallback(async (roomName = null) => {
    setIsConnecting(true);
    setError(null);
    try {
      const targetRoom = roomName || `voice-agent-${Date.now()}`;
      const participantName = `user-${Math.random().toString(36).slice(2, 8)}`;
      const currentVoice = selectedVoiceRef.current;

      const res = await fetch(
        `${TOKEN_SERVER_URL}/token?room=${targetRoom}&identity=${participantName}&voice=${currentVoice}`
      );
      if (!res.ok) {
        throw new Error(`Failed to retrieve secure LiveKit token (HTTP status ${res.status})`);
      }

      const data = await res.json();
      setToken(data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const handleHangUp = useCallback(() => {
    setToken(null);
  }, []);

  // Continue a past session: tear down any live room first, then reconnect to that room.
  const handleReconnect = useCallback((targetRoomName) => {
    setIsConnecting(true);
    setToken(null);

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    reconnectTimeoutRef.current = setTimeout(() => {
      connect(targetRoomName);
    }, 500);
  }, [connect]);

  if (token) {
    return (
      <LiveKitRoom
        token={token}
        serverUrl={
          import.meta.env.VITE_LIVEKIT_URL ||
          `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:7880`
        }
        connect={true}
        audio={true}
        video={false}
        onDisconnected={handleHangUp}
      >
        <RoomAudioRenderer />
        <div className="app">
          <LiveDashboard onHangUp={handleHangUp} onReconnect={handleReconnect} />
        </div>
      </LiveKitRoom>
    );
  }

  return (
    <div className="app">
      <IdleDashboard
        selectedVoice={selectedVoice}
        onVoiceChange={setSelectedVoice}
        onConnect={() => connect(null)}
        isConnecting={isConnecting}
        error={error}
        onReconnect={handleReconnect}
      />
    </div>
  );
}

// Export App wrapped inside Error Boundary to prevent full application failures
export default function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
