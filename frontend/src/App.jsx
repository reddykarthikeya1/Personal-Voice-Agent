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
    const d = new Date(dateStr);
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

// Component to handle individual session layout & voice visualization
function DashboardContent({ onHangUp, onReconnect }) {
  const { state: agentState, audioTrack, agentTranscriptions } = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();
  const { chatMessages } = useChat();
  const [showTranscript, setShowTranscript] = useState(true);
  const [activeTab, setActiveTab] = useState('active'); // 'active' or 'history'
  const [pastConversations, setPastConversations] = useState([]);
  const [selectedPastConv, setSelectedPastConv] = useState(null);
  const [pastMessages, setPastMessages] = useState([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const activeChatEndRef = useRef(null);
  const historyChatEndRef = useRef(null);
  const statusDescRef = useRef(null);

  // Scroll active chat to bottom on new messages
  useEffect(() => {
    if (activeTab === 'active') {
      activeChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, activeTab]);

  // Scroll history chat to bottom when loaded or selected
  useEffect(() => {
    if (activeTab === 'history' && selectedPastConv && !isHistoryLoading) {
      historyChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [pastMessages, activeTab, selectedPastConv, isHistoryLoading]);

  // Auto scroll status description to bottom when it changes (for long transcriptions)
  useEffect(() => {
    if (statusDescRef.current) {
      statusDescRef.current.scrollTop = statusDescRef.current.scrollHeight;
    }
  }, [agentState, agentTranscriptions]);

  // Handle mic toggle
  const isMuted = localParticipant ? !localParticipant.isMicrophoneEnabled : false;
  const toggleMic = useCallback(() => {
    if (localParticipant) {
      localParticipant.setMicrophoneEnabled(isMuted);
    }
  }, [localParticipant, isMuted]);

  // Fetch past conversations (handles non-OK states - H7)
  const fetchPastConversations = async () => {
    setIsHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await fetchConversationsAPI();
      setPastConversations(data);
    } catch (e) {
      console.error('Error fetching past sessions:', e);
      setHistoryError(e.message || 'Failed to retrieve saved history.');
    } finally {
      setIsHistoryLoading(false);
    }
  };

  // Fetch specific past session messages (handles loading spinner - M13, and errors - H7)
  const loadPastSession = async (roomName) => {
    setIsHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await fetchSessionMessagesAPI(roomName);
      setPastMessages(data);
      setSelectedPastConv(roomName);
    } catch (e) {
      console.error('Error loading session messages:', e);
      setHistoryError(e.message || 'Failed to load conversation history.');
    } finally {
      setIsHistoryLoading(false);
    }
  };

  // Load history when tab is clicked
  useEffect(() => {
    if (activeTab === 'history') {
      fetchPastConversations();
    }
  }, [activeTab]);

  // Determine current descriptive status text
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
      case 'speaking':
        const lastSegment = agentTranscriptions && agentTranscriptions.length > 0
          ? agentTranscriptions[agentTranscriptions.length - 1]
          : null;
        const transcript = lastSegment ? lastSegment.text : '';
        return { label: 'Speaking', desc: transcript || 'Synthesizing voice...' };
      default:
        return { label: 'Ready', desc: 'Awaiting your command...' };
    }
  };

  const status = getStatusDetails();

  // Get active styling class for the fluid orb based on state
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
      return {
        id: msg.id || `msg-${idx}`,
        isUser,
        text
      };
    });
  }, [chatMessages]);

  return (
    <div className={`dashboard-grid ${showTranscript ? '' : 'minimal'}`}>
      
      {/* LEFT STAGE: Main Visuals & Control */}
      <div className="main-stage">
        {/* Animated Background Mesh Glow */}
        <div className="ambient-bg" />
        
        {/* Header */}
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

        {/* Center Visuals */}
        <div className="center-stage">
          <div className="orb-wrapper">
            {/* The Fluid Orb */}
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

          {/* Status Indicators */}
          <div className="status-container">
            <div className="status-label">{status.label}</div>
            <div className="status-desc" ref={statusDescRef}>{status.desc}</div>
          </div>

          {/* Live Neon Frequency Audio Wave Bars (Glow visualizer) */}
          <div className={`bar-visualizer-container ${agentState === 'speaking' ? 'speaking' : agentState === 'listening' ? 'listening' : ''}`}>
            <BarVisualizer barCount={9} options={{ minHeight: 6, maxHeight: 80 }} track={audioTrack} state={agentState} />
          </div>
        </div>

        {/* Dashboard Control Buttons - H17: Accessibility descriptive aria-labels added */}
        <div className="controls-container">
          {/* Mute/Unmute Microphone */}
          <button
            className={`btn-circle ${isMuted ? 'btn-red' : 'active'}`}
            onClick={toggleMic}
            aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            title={isMuted ? 'Unmute Mic' : 'Mute Mic'}
          >
            {isMuted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>

          {/* Slide-out Chat Transcript Toggle */}
          <button
            className={`btn-circle ${showTranscript ? 'active' : ''}`}
            onClick={() => setShowTranscript(!showTranscript)}
            aria-label="Toggle chat transcript panel"
            title="Toggle Transcript Panel"
          >
            <MessageSquare size={22} />
          </button>

          {/* Terminate Connection */}
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

      {/* RIGHT STAGE: Glassmorphism Live Transcript & History */}
      <div className="transcript-panel">
        
        {/* Navigation Tabs - X6: ARIA tablist/tab accessibility roles added */}
        <div className="tab-header" role="tablist" aria-label="Session logs tabs">
          <button
            className={`tab-btn ${activeTab === 'active' ? 'active' : ''}`}
            onClick={() => { setActiveTab('active'); setSelectedPastConv(null); }}
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

        {activeTab === 'active' ? (
          /* ACTIVE SESSION VIEW */
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
                  <div className="bubble-meta">
                    {msg.isUser ? 'You' : 'Agent'}
                  </div>
                </div>
              ))
            )}
            <div ref={activeChatEndRef} />
          </div>
        ) : (
          /* SAVED HISTORY VIEW */
          <div className="history-container" id="saved-history-panel" role="tabpanel" aria-labelledby="saved-history-tab">
            {selectedPastConv ? (
              /* INDIVIDUAL PAST SESSION MESSAGES */
              <div className="history-chat-view">
                <div style={{ display: 'flex', justifyItems: 'center', justifyContent: 'space-between', padding: '15px', borderBottom: '1px solid var(--glass-border)', background: 'rgba(0,0,0,0.1)' }}>
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
                
                {isHistoryLoading ? (
                  <div className="history-empty">
                    <RotateCw size={32} className="animate-spin text-violet-400" />
                    <p>Loading session messages...</p>
                  </div>
                ) : historyError ? (
                  <div className="history-empty text-red-500">
                    <AlertCircle size={32} />
                    <p>{historyError}</p>
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
                            <div className="bubble-meta">
                              {isUser ? 'You' : 'Agent'}
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={historyChatEndRef} />
                  </div>
                )}
              </div>
            ) : (
              /* LIST OF SAVED SESSIONS */
              <div className="history-list-view">
                {isHistoryLoading ? (
                  <div className="history-empty">
                    <RotateCw size={32} className="animate-spin text-violet-400" />
                    <p>Loading saved sessions...</p>
                  </div>
                ) : historyError ? (
                  <div className="history-empty text-red-500">
                    <AlertCircle size={32} />
                    <p>{historyError}</p>
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
                        onClick={() => loadPastSession(conv.room_name)}
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
        )}
      </div>
      
    </div>
  );
}

function App() {
  const [token, setToken] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [pastConversations, setPastConversations] = useState([]);
  const [selectedPastConv, setSelectedPastConv] = useState(null);
  const [pastMessages, setPastMessages] = useState([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [selectedVoice, setSelectedVoice] = useState('alloy');
  
  // X5: Separate historyError state to prevent leak to the connect screen
  const [historyError, setHistoryError] = useState(null);

  // C5 & H9: Ref to store active reconnection timer to prevent leaks on unmount
  const reconnectTimeoutRef = useRef(null);

  // M8: Ref to store voice state so that the connect callback does NOT re-trigger on voice changes
  const selectedVoiceRef = useRef(selectedVoice);
  useEffect(() => {
    selectedVoiceRef.current = selectedVoice;
  }, [selectedVoice]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  // Fetch past conversations for connect screen history (handles non-OK states - H7)
  const fetchPastConversations = async () => {
    setIsHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await fetchConversationsAPI();
      setPastConversations(data);
    } catch (e) {
      console.error(e);
      setHistoryError(e.message || 'Failed to retrieve saved history.');
    } finally {
      setIsHistoryLoading(false);
    }
  };

  // Fetch messages of a past conversation session (handles loading state - M13, and errors - H7)
  const loadPastSession = async (roomName) => {
    setIsHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await fetchSessionMessagesAPI(roomName);
      setPastMessages(data);
      setSelectedPastConv(roomName);
    } catch (e) {
      console.error(e);
      setHistoryError(e.message || 'Failed to load conversation history.');
    } finally {
      setIsHistoryLoading(false);
    }
  };

  const openHistory = () => {
    fetchPastConversations();
    setShowHistoryModal(true);
  };

  const closeHistory = () => {
    setShowHistoryModal(false);
    setSelectedPastConv(null);
    setPastMessages([]);
    setHistoryError(null);
  };

  // M7: Clean connect callback, completely eliminating parameter overloading
  const connect = useCallback(async (roomName = null, isInitial = false) => {
    setIsConnecting(true);
    setError(null);
    
    if (isInitial) {
      setInitialLoading(true);
    }

    try {
      const targetRoom = roomName || `voice-agent-${Date.now()}`;
      const participantName = `user-${Math.random().toString(36).slice(2, 8)}`;

      // M8: Use voice ref instead of voice state dependency to prevent unintended loops
      const currentVoice = selectedVoiceRef.current;
      const res = await fetch(
        `${TOKEN_SERVER_URL}/token?room=${targetRoom}&identity=${participantName}&voice=${currentVoice}`
      );

      if (!res.ok) {
        throw new Error(`Failed to retrieve secure LiveKit token (HTTP status ${res.status})`);
      }

      const data = await res.json();
      setToken(data.token);
      setInitialLoading(false);
    } catch (err) {
      setError(err.message);
      setInitialLoading(false);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  // H9: Clean separation of disconnect (hang up) and reconnect flow
  const handleHangUp = useCallback(() => {
    setToken(null);
    setInitialLoading(false);
  }, []);

  const handleReconnect = useCallback((targetRoomName) => {
    setToken(null);
    setInitialLoading(true);
    
    // Clear any active reconnect timer
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    
    reconnectTimeoutRef.current = setTimeout(() => {
      connect(targetRoomName, false);
    }, 500);
  }, [connect]);

  // Auto connect on component mount (connect(null, true) is clear and non-overloaded - M7)
  useEffect(() => {
    connect(null, true);
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
        onDisconnected={handleHangUp} // Explicitly passes zero-argument callback to prevent string-enum matching - H9
      >
        <RoomAudioRenderer />
        <div className="app">
          {/* Explicit callbacks to manage state robustly */}
          <DashboardContent onHangUp={handleHangUp} onReconnect={handleReconnect} />
        </div>
      </LiveKitRoom>
    );
  }

  if (initialLoading) {
    return (
      <div className="app">
        <div className="ambient-bg" />
        <div className="connect-screen">
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
            <div className="connect-icon-wrapper" style={{ width: '80px', height: '80px', borderRadius: '24px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Sparkles size={32} className="animate-pulse text-violet-400" />
            </div>
            <div style={{ fontSize: '0.85rem', fontWeight: '500', color: 'rgba(255,255,255,0.35)', letterSpacing: '2px', textTransform: 'uppercase' }}>
              Connecting to KAY...
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Animated Background Mesh Glow */}
      <div className="ambient-bg" />

      <div className="connect-screen">
        <div className="connect-container" style={{ maxWidth: '380px', padding: '30px 25px', gap: '20px' }}>
          <div className="connect-icon-wrapper" style={{ width: '54px', height: '54px', borderRadius: '16px', marginBottom: '0px' }}>
            <Sparkles size={26} className="animate-pulse" />
          </div>
          <h1 style={{ fontSize: '1.8rem', letterSpacing: '1px', marginBottom: '0px' }}>KAY</h1>

          {/* Premium Glassmorphic Voice Selector Dropdown (Item 4) */}
          <div className="voice-select-wrapper" style={{ width: '100%', marginTop: '5px', marginBottom: '5px' }}>
            <label id="voice-select-label" style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '2px', color: 'rgba(255,255,255,0.35)', display: 'block', marginBottom: '8px', textAlign: 'left', fontWeight: '600' }}>
              Assistant Voice
            </label>
            <select
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              className="voice-select"
              aria-labelledby="voice-select-label"
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
              <option value="alloy" style={{ background: '#0d0822', color: '#fff' }}>Kay (Default Female - Aria)</option>
              <option value="nova" style={{ background: '#0d0822', color: '#fff' }}>Jenny (Soft Female - Jenny)</option>
              <option value="shimmer" style={{ background: '#0d0822', color: '#fff' }}>Amber (Warm Female - Amber)</option>
              <option value="echo" style={{ background: '#0d0822', color: '#fff' }}>Guy (Smooth Male - Guy)</option>
              <option value="onyx" style={{ background: '#0d0822', color: '#fff' }}>Davis (Deep Male - Davis)</option>
              <option value="fable" style={{ background: '#0d0822', color: '#fff' }}>Sonia (British Female - Sonia)</option>
            </select>
          </div>

          <div style={{ display: 'flex', gap: '12px', marginTop: '5px', width: '100%', justifyContent: 'center' }}>
            <button
              className="btn-circle btn-accent"
              onClick={() => connect(null, false)}
              disabled={isConnecting}
              aria-label={isConnecting ? 'Establishing connection to assistant' : 'Connect to assistant'}
              style={{ width: 'auto', flex: 1, borderRadius: '50px', padding: '0 30px', display: 'flex', gap: '8px', fontSize: '0.9rem', height: '48px' }}
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

            {/* Past History Button */}
            <button
              className="btn-circle"
              onClick={openHistory}
              aria-label="View saved conversation sessions log"
              title="Saved Conversation History"
              style={{ background: 'rgba(255,255,255,0.05)', width: '48px', height: '48px' }}
            >
              <History size={20} />
            </button>
          </div>

          {error && <p className="error" style={{ fontSize: '0.85rem', marginTop: '10px' }}>{error}</p>}
        </div>
      </div>

      {/* DISCONNECTED STATE HISTORY MODAL - H17: dialog role, focusable close button, & aria-modal added */}
      {showHistoryModal && (
        <div className="modal-overlay" onClick={closeHistory}>
          <div className="modal-content glass-panel" role="dialog" aria-modal="true" aria-label="Saved Conversation Sessions" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                <History size={20} className="text-violet-400" />
                <span>Saved Conversation Sessions</span>
              </h3>
              <button className="close-modal-btn" aria-label="Close history modal" onClick={closeHistory}>&times;</button>
            </div>
            
            <div className="modal-body">
              {selectedPastConv ? (
                /* Saved Messages view */
                <div className="history-chat-view">
                  <div style={{ display: 'flex', justifyItems: 'center', justifyContent: 'space-between', padding: '15px', borderBottom: '1px solid var(--glass-border)', background: 'rgba(0,0,0,0.1)' }}>
                    <button className="back-btn" onClick={() => setSelectedPastConv(null)} style={{ margin: 0, width: 'auto', background: 'transparent', border: 'none' }}>
                      <ArrowLeft size={16} />
                      <span>Back to Sessions</span>
                    </button>
                    <button 
                      className="btn-circle btn-accent" 
                      onClick={() => { closeHistory(); handleReconnect(selectedPastConv); }}
                      style={{ width: 'auto', borderRadius: '50px', padding: '0 20px', height: '36px', fontSize: '0.85rem', display: 'flex', gap: '6px', margin: 0 }}
                    >
                      <Play size={14} fill="white" />
                      <span>Continue Session</span>
                    </button>
                  </div>
                  
                  {isHistoryLoading ? (
                    <div className="history-empty" style={{ height: '300px' }}>
                      <RotateCw size={32} className="animate-spin text-violet-400" />
                      <p>Loading session messages...</p>
                    </div>
                  ) : historyError ? (
                    <div className="history-empty text-red-500" style={{ height: '300px' }}>
                      <AlertCircle size={32} />
                      <p>{historyError}</p>
                    </div>
                  ) : (
                    <div className="chat-scroll" style={{ maxHeight: '400px' }}>
                      {pastMessages.length === 0 ? (
                        <p className="no-msgs">No messages found in this session.</p>
                      ) : (
                        pastMessages.map((msg, idx) => {
                          const isUser = msg.role === 'user';
                          return (
                            <div key={`past-modal-${idx}`} className={`chat-bubble-wrapper ${isUser ? 'user' : 'agent'}`}>
                              <div className="bubble">{msg.content}</div>
                              <div className="bubble-meta">
                                {isUser ? 'You' : 'Agent'}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              ) : (
                /* Session List view */
                <div className="session-list" style={{ maxHeight: '400px', overflowY: 'auto', padding: '24px' }}>
                  {isHistoryLoading ? (
                    <div className="history-empty">
                      <RotateCw size={32} className="animate-spin text-violet-400" />
                      <p>Loading saved sessions...</p>
                    </div>
                  ) : historyError ? (
                    <div className="history-empty text-red-500">
                      <AlertCircle size={32} />
                      <p>{historyError}</p>
                    </div>
                  ) : pastConversations.length === 0 ? (
                    <div className="history-empty">
                      <p>No saved conversation logs found yet.</p>
                    </div>
                  ) : (
                    pastConversations.map((conv) => (
                      <button
                        key={conv.id}
                        className="session-card"
                        onClick={() => loadPastSession(conv.room_name)}
                        style={{ width: '100%', background: 'transparent', textAlign: 'left', border: '1px solid var(--glass-border)', display: 'block', marginBottom: '10px' }}
                        aria-label={`View conversation from ${formatDateHelper(conv.created_at)}`}
                      >
                        <div className="session-card-header">
                          <span className="session-title">{conv.title || `Session #${conv.id}`}</span>
                          <Calendar size={14} className="text-gray-500" />
                        </div>
                        <span className="session-date">{formatDateHelper(conv.created_at)}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
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
