import { io } from 'socket.io-client';
import { BACKEND_URL } from '../config/backend';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

let socket;

export const getSocket = () => {
  if (!socket) {
    socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });
  }
  return socket;
};

export const identify = ({ userId, role }) => {
  getSocket().emit('identify', { userId, role });
};

export const requestCompanion = ({ seniorId, requestType = 'chat', note = '' }) => {
  getSocket().emit('seeker:request', { seniorId, requestType, note });
};

export const joinSession = ({ conversationId }) => {
  getSocket().emit('session:join', { conversationId });
};

// Register Expo push token with backend over socket
export const registerPushToken = async () => {
  try {
    // Skip on web to avoid bundling issues and unsupported APIs
    if (Platform.OS === 'web') return;

    // Dynamically import to avoid bundling error if not installed
    let Notifications;
    try {
      // Prefer default export if present
      const mod = await import('expo-notifications');
      Notifications = mod?.default ?? mod;
    } catch (e) {
      // Module not installed; safely bail out
      return;
    }

    const profileJson = await AsyncStorage.getItem('userProfile');
    const profile = profileJson ? JSON.parse(profileJson) : null;
    const userId = profile?.id || profile?.uid || profile?.userId;
    if (!userId) return;

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return;

    const tokenData = await Notifications.getExpoPushTokenAsync();
    const token = tokenData?.data;
    if (!token) return;

    getSocket().emit('push:register', { userId, token });
  } catch (e) {
    // ignore
  }
};

export const sendMessage = ({ conversationId, senderId, content, type = 'text' }) => {
  getSocket().emit('message:send', { conversationId, senderId, content, type });
};

// Voice call methods
export const initiateVoiceCall = ({ conversationId, callerId, calleeId, callerName }) => {
  getSocket().emit('call:initiate', { conversationId, callerId, calleeId, callerName });
};

export const acceptVoiceCall = ({ conversationId, callerId, calleeId }) => {
  getSocket().emit('call:accept', { conversationId, callerId, calleeId });
};

export const rejectVoiceCall = ({ conversationId, callerId, calleeId }) => {
  getSocket().emit('call:reject', { conversationId, callerId, calleeId });
};

export const endVoiceCall = ({ conversationId, callerId, calleeId, userId }) => {
  getSocket().emit('call:end', { conversationId, callerId, calleeId, userId });
};

// WebRTC signaling
export const sendWebRTCOffer = ({ conversationId, sdp }) => {
  getSocket().emit('webrtc:offer', { conversationId, sdp });
};

export const sendWebRTCAnswer = ({ conversationId, sdp }) => {
  getSocket().emit('webrtc:answer', { conversationId, sdp });
};

export const sendICECandidate = ({ conversationId, candidate }) => {
  getSocket().emit('webrtc:ice-candidate', { conversationId, candidate });
};

// Help request methods
export const sendHelpRequest = ({ seniorId, category, description, language, priority }) => {
  getSocket().emit('help:request', { 
    seniorId, 
    category, 
    description, 
    language,
    priority,
    timestamp: new Date().toISOString(),
  });
};

export const acceptHelpRequest = ({ requestId, volunteerId }) => {
  getSocket().emit('help:accept', { requestId, volunteerId });
};

export const rejectHelpRequest = ({ requestId, reason }) => {
  getSocket().emit('help:reject', { requestId, reason });
};

export const closeHelpRequest = ({ requestId, resolution }) => {
  getSocket().emit('help:close', { requestId, resolution });
};

// Request handling methods
export const cancelChatRequest = ({ seniorId }) => {
  getSocket().emit('request:cancel', { seniorId });
};

export const getSeniorRequestStatus = ({ seniorId }, callback) => {
  const socket = getSocket();
  socket.emit('request:status', { seniorId });
  socket.off('request:status:response');
  socket.on('request:status:response', callback);
};

export default {
  getSocket,
  identify,
  requestCompanion,
  joinSession,
  registerPushToken,
  sendMessage,
  initiateVoiceCall,
  acceptVoiceCall,
  rejectVoiceCall,
  endVoiceCall,
  sendWebRTCOffer,
  sendWebRTCAnswer,
  sendICECandidate,
  sendHelpRequest,
  acceptHelpRequest,
  rejectHelpRequest,
  closeHelpRequest,
  cancelChatRequest,
  getSeniorRequestStatus,
};
