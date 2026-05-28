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
  Trash2,
  Volume2,
  Play,
  RotateCw,
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
  const { chatMessages, send } = useChat();
  const [showTranscript, setShowTranscript] = useState(true);
  const chatEndRef = useRef(null);

  // Scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Handle mic toggle
  const isMuted = localParticipant ? !localParticipant.isMicrophoneEnabled : false;
  const toggleMic = useCallback(() => {
    if (localParticipant) {
      localParticipant.setMicrophoneEnabled(isMuted);
    }
  }, [localParticipant, isMuted]);

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

  return (
    <div className={`dashboard-grid ${showTranscript ? '' : 'minimal'}`}>
      
      {/* LEFT STAGE: Main Visuals & Control */}
      <div className="main-stage">
        
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
                  <Volume2 size={32} className="text-red-500 animate-pulse" />
                ) : agentState === 'thinking' ? (
                  <Sparkles size={32} className="text-violet-500" />
                ) : (
                  <Cpu size={32} className="text-cyan-500" />
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

          {/* Live Neon Frequency Audio Wave Bars */}
          <div className={`bar-visualizer-container ${agentState === 'speaking' ? 'speaking' : agentState === 'listening' ? 'listening' : ''}`}>
            <BarVisualizer barCount={7} options={{ minHeight: 4, maxHeight: 40 }} track={audioTrack} state={agentState} />
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

      {/* RIGHT STAGE: Glassmorphism Live Transcript */}
      <div className="transcript-panel">
        <div className="transcript-header">
          <h3>
            <Sparkles size={18} className="text-violet-400" />
            Conversation Log
          </h3>
        </div>

        <div className="chat-scroll">
          {chatMessages.length === 0 ? (
            <div className="chat-empty">
              <Cpu size={48} className="text-gray-600 animate-pulse" />
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
      </div>
      
    </div>
  );
}

function App() {
  const [token, setToken] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState(null);

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
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    </div>
  );
}

export default App;
