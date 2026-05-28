import { useState, useEffect, useRef, useCallback } from 'react';
import {
  LiveKitRoom,
  useVoiceAssistant,
  BarVisualizer,
  RoomAudioRenderer,
  useParticipants,
  useLocalParticipant,
} from '@livekit/components-react';
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

function AgentVisualizer() {
  const { state: agentState } = useVoiceAssistant();
  const isSpeaking = agentState === 'speaking';
  const isListening = agentState === 'listening';

  return (
    <div className="visualizer-container">
      <div className={`circle ${isSpeaking ? 'speaking' : ''} ${isListening ? 'listening' : ''}`}>
        <div className="circle-inner" />
        <div className="pulse-ring" />
        <div className="pulse-ring delay-1" />
        <div className="pulse-ring delay-2" />
      </div>
      <div className="status-text">
        {isSpeaking && 'Speaking...'}
        {isListening && 'Listening...'}
        {!isSpeaking && !isListening && 'Ready'}
      </div>
    </div>
  );
}

function AudioVisualizer() {
  const { state: agentState, audioTrack } = useVoiceAssistant();
  return (
    <div className="bar-visualizer-container">
      <BarVisualizer state={agentState} track={audioTrack} barCount={5} options={{ minHeight: 10, maxHeight: 60 }} />
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
          <AgentVisualizer />
          <AudioVisualizer />
          <button className="disconnect-btn" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </LiveKitRoom>
    );
  }

  return (
    <div className="app">
      <div className="connect-screen">
        <h1>Voice Agent</h1>
        <p>Click below to start a conversation</p>
        <button
          className="connect-btn"
          onClick={connect}
          disabled={isConnecting}
        >
          {isConnecting ? 'Connecting...' : 'Start Conversation'}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

export default App;
