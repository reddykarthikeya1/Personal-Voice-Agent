import { useState, useEffect, useRef, useCallback } from 'react';
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
} from 'lucide-react';
import '@livekit/components-styles';

// In Docker, token-server is on the same host but port 8081
const getTokenServerUrl = () => {
  if (import.meta.env.VITE_TOKEN_SERVER_URL) {
    return import.meta.env.VITE_TOKEN_SERVER_URL;
  }
  // Use same host with port 8081
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:8081`;
};

const TOKEN_SERVER_URL = getTokenServerUrl();

// Component to handle individual session layout & voice visualization
function DashboardContent({ onDisconnect }) {
  const { state: agentState, audioTrack } = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();
  const { chatMessages } = useChat();
  const [showTranscript, setShowTranscript] = useState(true);
  const [activeTab, setActiveTab] = useState('active'); // 'active' or 'history'
  const [pastConversations, setPastConversations] = useState([]);
  const [selectedPastConv, setSelectedPastConv] = useState(null);
  const [pastMessages, setPastMessages] = useState([]);
  const chatEndRef = useRef(null);

  // Scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, activeTab, selectedPastConv]);

  // Handle mic toggle
  const isMuted = localParticipant ? !localParticipant.isMicrophoneEnabled : false;
  const toggleMic = useCallback(() => {
    if (localParticipant) {
      localParticipant.setMicrophoneEnabled(isMuted);
    }
  }, [localParticipant, isMuted]);

  // Fetch past conversations
  const fetchPastConversations = async () => {
    try {
      const res = await fetch(`${TOKEN_SERVER_URL}/conversations`);
      if (res.ok) {
        const data = await res.json();
        setPastConversations(data);
      }
    } catch (e) {
      console.error('Error fetching past sessions:', e);
    }
  };

  // Fetch specific past session messages
  const loadPastSession = async (roomName) => {
    try {
      const res = await fetch(`${TOKEN_SERVER_URL}/conversations/${roomName}/messages`);
      if (res.ok) {
        const data = await res.json();
        setPastMessages(data);
        setSelectedPastConv(roomName);
      }
    } catch (e) {
      console.error('Error loading session messages:', e);
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
        return { label: 'Listening', desc: 'Go ahead, I\'m listening closely...' };
      case 'thinking':
        return { label: 'Thinking', desc: 'Formulating a smart response...' };
      case 'speaking':
        return { label: 'Speaking', desc: 'Synthesizing voice...' };
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

  // Format date helper
  const formatDate = (dateStr) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return dateStr;
    }
  };

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
            <h2>PERSONAL VOICE AGENT</h2>
          </div>
          
          <div className="status-badge">
            <div className={`badge-dot ${getOrbStateClass()}`} />
            <span>AGENT ONLINE</span>
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
            <div className="status-desc">{status.desc}</div>
          </div>

          {/* Live Neon Frequency Audio Wave Bars (Glow visualizer) */}
          <div className={`bar-visualizer-container ${agentState === 'speaking' ? 'speaking' : agentState === 'listening' ? 'listening' : ''}`}>
            <BarVisualizer barCount={9} options={{ minHeight: 6, maxHeight: 80 }} track={audioTrack} state={agentState} />
          </div>
        </div>

        {/* Dashboard Control Buttons */}
        <div className="controls-container">
          {/* Mute/Unmute Microphone */}
          <button
            className={`btn-circle ${isMuted ? 'btn-red' : 'active'}`}
            onClick={toggleMic}
            title={isMuted ? 'Unmute Mic' : 'Mute Mic'}
          >
            {isMuted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>

          {/* Slide-out Chat Transcript Toggle */}
          <button
            className={`btn-circle ${showTranscript ? 'active' : ''}`}
            onClick={() => setShowTranscript(!showTranscript)}
            title="Toggle Transcript Panel"
          >
            <MessageSquare size={22} />
          </button>

          {/* Terminate Connection */}
          <button
            className="btn-circle btn-red"
            onClick={onDisconnect}
            title="Disconnect"
          >
            <PhoneOff size={22} />
          </button>
        </div>
      </div>

      {/* RIGHT STAGE: Glassmorphism Live Transcript & History */}
      <div className="transcript-panel">
        
        {/* Navigation Tabs */}
        <div className="tab-header">
          <button
            className={`tab-btn ${activeTab === 'active' ? 'active' : ''}`}
            onClick={() => { setActiveTab('active'); setSelectedPastConv(null); }}
          >
            <MessageCircle size={16} />
            <span>Active Session</span>
          </button>
          <button
            className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            <History size={16} />
            <span>Saved History</span>
          </button>
        </div>

        {activeTab === 'active' ? (
          /* ACTIVE SESSION VIEW */
          <div className="chat-scroll">
            {chatMessages.length === 0 ? (
              <div className="chat-empty">
                <Cpu size={48} className="text-gray-700 animate-pulse" />
                <p>Say hello to your personal voice assistant to start the conversation!</p>
              </div>
            ) : (
              chatMessages.map((msg, idx) => {
                const isUser = msg.from?.identity !== 'agent' && !msg.from?.identity?.includes('agent');
                return (
                  <div key={idx} className={`chat-bubble-wrapper ${isUser ? 'user' : 'agent'}`}>
                    <div className="bubble">{msg.message}</div>
                    <div className="bubble-meta">
                      {isUser ? 'You' : 'Agent'}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={chatEndRef} />
          </div>
        ) : (
          /* SAVED HISTORY VIEW */
          <div className="history-container">
            {selectedPastConv ? (
              /* INDIVIDUAL PAST SESSION MESSAGES */
              <div className="history-chat-view">
                <button className="back-btn" onClick={() => setSelectedPastConv(null)}>
                  <ArrowLeft size={16} />
                  <span>Back to Sessions</span>
                </button>
                <div className="chat-scroll">
                  {pastMessages.length === 0 ? (
                    <p className="no-msgs">No messages found in this session.</p>
                  ) : (
                    pastMessages.map((msg, idx) => {
                      const isUser = msg.role === 'user';
                      return (
                        <div key={idx} className={`chat-bubble-wrapper ${isUser ? 'user' : 'agent'}`}>
                          <div className="bubble">{msg.content}</div>
                          <div className="bubble-meta">
                            {isUser ? 'You' : 'Agent'}
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={chatEndRef} />
                </div>
              </div>
            ) : (
              /* LIST OF SAVED SESSIONS */
              <div className="history-list-view">
                {pastConversations.length === 0 ? (
                  <div className="history-empty">
                    <History size={40} className="text-gray-700" />
                    <p>No saved conversation logs found yet.</p>
                  </div>
                ) : (
                  <div className="session-list">
                    {pastConversations.map((conv) => (
                      <div key={conv.id} className="session-card" onClick={() => loadPastSession(conv.room_name)}>
                        <div className="session-card-header">
                          <span className="session-title">Session #{conv.id}</span>
                          <Calendar size={14} className="text-gray-500" />
                        </div>
                        <span className="session-date">{formatDate(conv.created_at)}</span>
                      </div>
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

  // Fetch past conversations for connect screen history
  const fetchPastConversations = async () => {
    try {
      const res = await fetch(`${TOKEN_SERVER_URL}/conversations`);
      if (res.ok) {
        const data = await res.json();
        setPastConversations(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Fetch past messages
  const loadPastSession = async (roomName) => {
    try {
      const res = await fetch(`${TOKEN_SERVER_URL}/conversations/${roomName}/messages`);
      if (res.ok) {
        const data = await res.json();
        setPastMessages(data);
        setSelectedPastConv(roomName);
      }
    } catch (e) {
      console.error(e);
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
  };

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);

    try {
      const roomName = `voice-agent-${Date.now()}`;
      const participantName = `user-${Math.random().toString(36).slice(2, 8)}`;

      const res = await fetch(
        `${TOKEN_SERVER_URL}/token?room=${roomName}&identity=${participantName}`
      );

      if (!res.ok) {
        throw new Error('Failed to get token');
      }

      const data = await res.json();
      setToken(data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setToken(null);
  }, []);

  // Format date helper
  const formatDate = (dateStr) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return dateStr;
    }
  };

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
        onDisconnected={disconnect}
      >
        <RoomAudioRenderer />
        <div className="app">
          <DashboardContent onDisconnect={disconnect} />
        </div>
      </LiveKitRoom>
    );
  }

  return (
    <div className="app">
      {/* Animated Background Mesh Glow */}
      <div className="ambient-bg" />

      <div className="connect-screen">
        <div className="connect-container">
          <div className="connect-icon-wrapper">
            <Sparkles size={38} className="animate-pulse" />
          </div>
          <h1>Personal Voice Agent</h1>
          <p>
            Experience dynamic, real-time voice interactions driven by local Whisper STT, 
            Edge-TTS, and a powerful DGX-hosted Qwen LLM.
          </p>

          <div style={{ display: 'flex', gap: '16px', marginTop: '10px' }}>
            <button
              className="btn-circle btn-accent"
              onClick={connect}
              disabled={isConnecting}
              style={{ width: 'auto', borderRadius: '50px', padding: '0 40px', display: 'flex', gap: '10px' }}
            >
              {isConnecting ? (
                <>
                  <RotateCw size={18} className="animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <Play size={18} fill="white" />
                  <span>Start Conversation</span>
                </>
              )}
            </button>

            {/* Past History Button */}
            <button
              className="btn-circle"
              onClick={openHistory}
              title="Saved Conversation History"
              style={{ background: 'rgba(255,255,255,0.05)' }}
            >
              <History size={22} />
            </button>
          </div>

          {error && <p className="error">{error}</p>}
        </div>
      </div>

      {/* DISCONNECTED STATE HISTORY MODAL */}
      {showHistoryModal && (
        <div className="modal-overlay" onClick={closeHistory}>
          <div className="modal-content glass-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                <History size={20} className="text-violet-400" />
                <span>Saved Conversation Sessions</span>
              </h3>
              <button className="close-modal-btn" onClick={closeHistory}>&times;</button>
            </div>
            
            <div className="modal-body">
              {selectedPastConv ? (
                /* Saved Messages view */
                <div className="history-chat-view">
                  <button className="back-btn" onClick={() => setSelectedPastConv(null)}>
                    <ArrowLeft size={16} />
                    <span>Back to Sessions</span>
                  </button>
                  <div className="chat-scroll" style={{ maxHeight: '400px' }}>
                    {pastMessages.length === 0 ? (
                      <p className="no-msgs">No messages found in this session.</p>
                    ) : (
                      pastMessages.map((msg, idx) => {
                        const isUser = msg.role === 'user';
                        return (
                          <div key={idx} className={`chat-bubble-wrapper ${isUser ? 'user' : 'agent'}`}>
                            <div className="bubble">{msg.content}</div>
                            <div className="bubble-meta">
                              {isUser ? 'You' : 'Agent'}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : (
                /* Session List view */
                <div className="session-list" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                  {pastConversations.length === 0 ? (
                    <div className="history-empty">
                      <p>No saved conversation logs found yet.</p>
                    </div>
                  ) : (
                    pastConversations.map((conv) => (
                      <div key={conv.id} className="session-card" onClick={() => loadPastSession(conv.room_name)}>
                        <div className="session-card-header">
                          <span className="session-title">Session #{conv.id}</span>
                          <Calendar size={14} className="text-gray-500" />
                        </div>
                        <span className="session-date">{formatDate(conv.created_at)}</span>
                      </div>
                    ))}
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

export default App;
