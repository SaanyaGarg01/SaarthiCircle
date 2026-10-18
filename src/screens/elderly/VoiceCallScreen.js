// Voice Call Screen - Full-screen call interface with WebRTC audio implementation
import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  AppState,
  Platform,
  Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { KeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colors, typography, spacing, borderRadius, shadows } from '../../theme';
import { getTranslation } from '../../i18n/translations';
import socketService, {
  getSocket,
  endVoiceCall,
  sendWebRTCOffer,
  sendWebRTCAnswer,
  sendICECandidate,
} from '../../services/socketService';
import webrtcService from '../../services/webrtcService';
import { useChat } from '../../context/ChatContext';

const VoiceCallScreen = ({ navigation, route }) => {
  const { conversationId, companion, callerId, calleeId, isIncoming = false } = route.params || {};
  const { voiceCallState, updateCallDuration, endVoiceCall: endCall } = useChat();

  const { t } = useTranslation();

  const [currentUserId, setCurrentUserId] = useState(null);
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [callStatus, setCallStatus] = useState(isIncoming ? 'active' : 'initiating');
  const [errorMessage, setErrorMessage] = useState(null);
  const [isConnecting, setIsConnecting] = useState(true);
  const [appState, setAppState] = useState(AppState.currentState);

  // Debug log
  useEffect(() => {
    console.log('[VOICE_CALL] Screen initialized with:', {
      isIncoming,
      callStatus,
      conversationId,
      companion: companion?.name,
      callerId,
      calleeId,
    });
  }, []);

  const callTimerRef = useRef(null);
  const appStateSubscriptionRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Get current user ID
  useEffect(() => {
    const loadUserId = async () => {
      try {
        const profileJson = await AsyncStorage.getItem('userProfile');
        const profile = profileJson ? JSON.parse(profileJson) : null;
        const uid = profile?.id || profile?.uid || profile?.userId;
        setCurrentUserId(uid);
      } catch (e) {
        console.error('Error loading user profile:', e);
      }
    };
    loadUserId();
  }, []);

  // Keep screen awake during call
  useEffect(() => {
    KeepAwake.activate();
    return () => {
      KeepAwake.deactivate();
    };
  }, []);

  // Handle app state changes (background/foreground)
  useEffect(() => {
    appStateSubscriptionRef.current = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      appStateSubscriptionRef.current?.remove();
    };
  }, [callStatus]);

  const handleAppStateChange = (nextAppState) => {
    console.log('[CALL] App state changed to:', nextAppState);
    setAppState(nextAppState);

    if (nextAppState === 'background' && callStatus === 'active') {
      console.log('[CALL] App in background, call continues');
    } else if (nextAppState === 'active' && callStatus === 'active') {
      console.log('[CALL] App returned to foreground');
    }
  };

  // Initialize WebRTC when call is active
  useEffect(() => {
    if (callStatus === 'active' && isConnecting) {
      initializeWebRTC();
    }
  }, [callStatus, isConnecting]);

  // Initialize WebRTC connection
  const initializeWebRTC = async () => {
    try {
      setIsConnecting(true);
      console.log('[WEBRTC] Initializing WebRTC...');

      // Get local audio stream
      const localStream = await webrtcService.initializeAudio();
      console.log('[WEBRTC] Local audio stream obtained');

      // Create peer connection
      const onRemoteStreamReady = (remoteStream) => {
        console.log('[WEBRTC] Remote stream ready');
        setIsConnecting(false);
      };

      const onIceCandidate = (candidate) => {
        console.log('[WEBRTC] Sending ICE candidate');
        sendICECandidate({
          conversationId,
          candidate: candidate.toJSON(),
        });
      };

      await webrtcService.createPeerConnection(onRemoteStreamReady, onIceCandidate);

      // Determine if we should send offer (caller) or wait for offer (receiver)
      if (!isIncoming) {
        // We're the caller, send offer
        const offer = await webrtcService.createOffer();
        sendWebRTCOffer({
          conversationId,
          sdp: offer.sdp,
        });
      }

      console.log('[WEBRTC] WebRTC initialized');
      setIsConnecting(false);
    } catch (error) {
      console.error('[WEBRTC] Error initializing WebRTC:', error);
      setErrorMessage('Failed to initialize audio. Please try again.');
      setIsConnecting(false);
    }
  };

  // Socket event listeners
  useEffect(() => {
    const socket = getSocket();

    // When call becomes active
    socket.off('call:active');
    socket.on('call:active', ({ conversationId: cid, acceptedAt }) => {
      console.log('[CALL] Call is now active');
      setCallStatus('active');
      setErrorMessage(null);

      // Start call duration timer
      if (callTimerRef.current) clearInterval(callTimerRef.current);
      callTimerRef.current = setInterval(() => {
        setCallDuration((prev) => {
          const newDuration = prev + 1;
          updateCallDuration(newDuration);
          return newDuration;
        });
      }, 1000);
    });

    // Handle incoming WebRTC offer (for receiver)
    socket.off('webrtc:offer');
    socket.on('webrtc:offer', async ({ sdp }) => {
      try {
        console.log('[WEBRTC] Received offer');
        const offer = { type: 'offer', sdp };
        const answer = await webrtcService.createAnswer(offer);
        sendWebRTCAnswer({
          conversationId,
          sdp: answer.sdp,
        });
      } catch (error) {
        console.error('[WEBRTC] Error handling offer:', error);
      }
    });

    // Handle incoming WebRTC answer (for caller)
    socket.off('webrtc:answer');
    socket.on('webrtc:answer', async ({ sdp }) => {
      try {
        console.log('[WEBRTC] Received answer');
        const answer = { type: 'answer', sdp };
        await webrtcService.handleAnswer(answer);
      } catch (error) {
        console.error('[WEBRTC] Error handling answer:', error);
      }
    });

    // Handle ICE candidates
    socket.off('webrtc:ice-candidate');
    socket.on('webrtc:ice-candidate', async ({ candidate }) => {
      try {
        if (candidate) {
          console.log('[WEBRTC] Received ICE candidate');
          await webrtcService.addIceCandidate(candidate);
        }
      } catch (error) {
        console.error('[WEBRTC] Error handling ICE candidate:', error);
      }
    });

    // When call is ready for WebRTC
    socket.off('call:ready-for-webrtc');
    socket.on('call:ready-for-webrtc', ({ conversationId: cid }) => {
      console.log('[CALL] Ready to establish WebRTC connection');
    });

    // When call is rejected
    socket.off('call:rejected');
    socket.on('call:rejected', ({ rejectedBy, reason }) => {
      console.log('[CALL] Call was rejected:', reason);
      setCallStatus('rejected');
      setErrorMessage('The volunteer rejected your call. Please try again later.');
      cleanup();
      setTimeout(() => {
        navigation.goBack();
      }, 2000);
    });

    // When call ends
    socket.off('call:ended');
    socket.on('call:ended', ({ endedBy, endedAt }) => {
      console.log('[CALL] Call ended by:', endedBy);
      setCallStatus('ended');
      cleanup();
      setTimeout(() => {
        endCall();
        navigation.goBack();
      }, 1500);
    });

    // When call fails
    socket.off('call:failed');
    socket.on('call:failed', ({ reason, message }) => {
      console.log('[CALL] Call failed:', reason);
      setCallStatus('failed');
      setErrorMessage(message || reason || 'Call could not be established');
      cleanup();
      setTimeout(() => {
        navigation.goBack();
      }, 2000);
    });

    // Ringing state
    socket.off('call:ringing');
    socket.on('call:ringing', ({ conversationId: cid }) => {
      console.log('[CALL] Call is ringing');
      setCallStatus('ringing');

      // Start pulsing animation
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      ).start();
    });

    return () => {
      socket.off('call:active');
      socket.off('call:ready-for-webrtc');
      socket.off('call:rejected');
      socket.off('call:ended');
      socket.off('call:failed');
      socket.off('call:ringing');
      socket.off('webrtc:offer');
      socket.off('webrtc:answer');
      socket.off('webrtc:ice-candidate');
      if (callTimerRef.current) clearInterval(callTimerRef.current);
    };
  }, [navigation, updateCallDuration, endCall, conversationId, isIncoming]);

  // Format duration
  const formatDuration = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // Handle mute toggle
  const handleToggleMute = () => {
    try {
      const newMuteState = webrtcService.toggleMute();
      setIsMuted(newMuteState);
      console.log('[CALL] Mute toggled:', newMuteState ? 'ON' : 'OFF');
    } catch (error) {
      console.error('Error toggling mute:', error);
    }
  };

  // Handle speaker toggle
  const handleToggleSpeaker = async () => {
    try {
      const newSpeakerState = await webrtcService.toggleSpeaker();
      setIsSpeakerOn(newSpeakerState);
      console.log('[CALL] Speaker toggled:', newSpeakerState ? 'ON' : 'OFF');
    } catch (error) {
      console.error('Error toggling speaker:', error);
    }
  };

  // Cleanup WebRTC resources
  const cleanup = () => {
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    webrtcService.closeConnection();
  };

  // Handle end call
  const handleEndCall = () => {
    cleanup();

    endVoiceCall({
      conversationId,
      callerId: isIncoming ? calleeId : callerId,
      calleeId: isIncoming ? callerId : calleeId,
      userId: currentUserId,
    });

    setCallStatus('ended');
    setTimeout(() => {
      endCall();
      navigation.goBack();
    }, 500);
  };

  // Handle reject call (for incoming calls)
  const handleRejectCall = () => {
    const socket = getSocket();
    socket.emit('call:reject', {
      conversationId,
      callerId: isIncoming ? calleeId : callerId,
      calleeId: isIncoming ? callerId : calleeId,
    });
    navigation.goBack();
  };

  const getStatusText = () => {
    switch (callStatus) {
      case 'initiating':
        return 'Initiating call...';
      case 'ringing':
        return 'Calling...';
      case 'incoming':
        return 'Incoming call';
      case 'active':
        return 'Call active';
      case 'rejected':
        return 'Call rejected';
      case 'ended':
        return 'Call ended';
      case 'failed':
        return 'Call failed';
      default:
        return 'Connecting...';
    }
  };

  return (
    <LinearGradient
      colors={[colors.primary.light, colors.secondary.cream]}
      style={styles.container}
    >
      {/* Keep screen awake */}
      <KeepAwake />

      <SafeAreaView style={styles.safeArea}>
        <View style={styles.content}>
          {/* Status Section */}
          <View style={styles.statusSection}>
            {/* Companion Avatar or Icon */}
            <View style={styles.avatarContainer}>
              <View style={[
                styles.avatar,
                callStatus === 'ringing' && { transform: [{ scale: pulseAnim }] }
              ]}>
                <MaterialCommunityIcons
                  name="account-circle"
                  size={100}
                  color={colors.primary.main}
                />
              </View>
            </View>

            {/* Companion Name */}
            <Text style={styles.companionName}>
              {companion?.fullName || companion?.name || 'Companion'}
            </Text>

            {/* Call Status */}
            <Text style={[
              styles.statusText,
              callStatus === 'active' && styles.statusTextActive,
              ['rejected', 'ended', 'failed'].includes(callStatus) && styles.statusTextError,
            ]}>
              {getStatusText()}
            </Text>

            {/* Duration Timer - Show when call is active */}
            {callStatus === 'active' && (
              <Text style={styles.durationTimer}>
                {formatDuration(callDuration)}
              </Text>
            )}

            {/* Connecting indicator */}
            {callStatus === 'active' && isConnecting && (
              <View style={styles.connectingContainer}>
                <ActivityIndicator
                  size="small"
                  color={colors.primary.main}
                />
                <Text style={styles.connectingText}>Connecting audio...</Text>
              </View>
            )}

            {/* Error Message */}
            {errorMessage && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorMessage}>{errorMessage}</Text>
              </View>
            )}
          </View>

          {/* Control Buttons */}
          <View style={styles.controlsSection}>
            {/* Mute Button - Show when call is active */}
            {callStatus === 'active' && (
              <TouchableOpacity
                style={[
                  styles.controlButton,
                  isMuted && styles.controlButtonActive,
                ]}
                onPress={handleToggleMute}
                activeOpacity={0.7}
              >
                <MaterialCommunityIcons
                  name={isMuted ? 'microphone-off' : 'microphone'}
                  size={32}
                  color={colors.neutral.white}
                />
                <Text style={styles.controlLabel}>
                  {isMuted ? 'Unmute' : 'Mute'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Speaker Button - Show when call is active */}
            {callStatus === 'active' && (
              <TouchableOpacity
                style={[
                  styles.controlButton,
                  isSpeakerOn && styles.controlButtonActive,
                ]}
                onPress={handleToggleSpeaker}
                activeOpacity={0.7}
              >
                <MaterialCommunityIcons
                  name={isSpeakerOn ? 'volume-high' : 'volume-off'}
                  size={32}
                  color={colors.neutral.white}
                />
                <Text style={styles.controlLabel}>
                  {isSpeakerOn ? 'Speaker' : 'Earpiece'}
                </Text>
              </TouchableOpacity>
            )}

            {/* For incoming calls - Accept/Reject buttons */}
            {callStatus === 'incoming' && (
              <>
                <TouchableOpacity
                  style={[styles.controlButton, styles.acceptButton]}
                  onPress={() => setCallStatus('active')}
                  activeOpacity={0.7}
                >
                  <MaterialCommunityIcons
                    name="phone"
                    size={36}
                    color={colors.neutral.white}
                  />
                  <Text style={styles.controlLabel}>Answer</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.controlButton, styles.rejectButton]}
                  onPress={handleRejectCall}
                  activeOpacity={0.7}
                >
                  <MaterialCommunityIcons
                    name="phone-hangup"
                    size={36}
                    color={colors.neutral.white}
                  />
                  <Text style={styles.controlLabel}>Reject</Text>
                </TouchableOpacity>
              </>
            )}
          </View>

          {/* End Call Button - Always visible for active/ringing calls */}
          {['active', 'ringing', 'initiating'].includes(callStatus) && (
            <TouchableOpacity
              style={styles.endCallButton}
              onPress={handleEndCall}
              activeOpacity={0.8}
            >
              <MaterialCommunityIcons
                name="phone-hangup"
                size={36}
                color={colors.neutral.white}
              />
              <Text style={styles.endCallButtonText}>End Call</Text>
            </TouchableOpacity>
          )}

          {/* Loading indicator for initiating/ringing */}
          {['initiating', 'ringing'].includes(callStatus) && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator
                size="large"
                color={colors.primary.main}
              />
            </View>
          )}
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  statusSection: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  avatarContainer: {
    marginBottom: spacing.lg,
  },
  avatar: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: colors.neutral.white,
    justifyContent: 'center',
    alignItems: 'center',
    ...shadows.lg,
  },
  companionName: {
    fontSize: typography.sizes.xxl,
    fontWeight: typography.weights.bold,
    color: colors.neutral.darkGray,
    marginBottom: spacing.md,
  },
  statusText: {
    fontSize: typography.sizes.lg,
    color: colors.neutral.darkGray,
    fontWeight: typography.weights.medium,
    marginBottom: spacing.md,
  },
  statusTextActive: {
    color: colors.secondary.green,
  },
  statusTextError: {
    color: colors.danger.main,
  },
  durationTimer: {
    fontSize: typography.sizes.xxxl,
    fontWeight: typography.weights.bold,
    color: colors.primary.main,
    marginTop: spacing.lg,
  },
  errorContainer: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.danger.light,
    borderRadius: borderRadius.md,
    maxWidth: '85%',
  },
  errorMessage: {
    color: colors.danger.main,
    fontSize: typography.sizes.md,
    fontWeight: typography.weights.medium,
    textAlign: 'center',
  },
  controlsSection: {
    flexDirection: 'row',
    gap: spacing.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
    flexWrap: 'wrap',
  },
  controlButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.primary.main,
    justifyContent: 'center',
    alignItems: 'center',
    ...shadows.md,
  },
  controlButtonActive: {
    backgroundColor: colors.danger.main,
  },
  acceptButton: {
    backgroundColor: colors.secondary.green,
  },
  rejectButton: {
    backgroundColor: colors.danger.main,
  },
  connectingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  connectingText: {
    fontSize: typography.sizes.md,
    color: colors.neutral.darkGray,
    marginLeft: spacing.md,
    fontWeight: typography.weights.medium,
  },
  controlLabel: {
    color: colors.neutral.white,
    fontSize: typography.sizes.xs,
    fontWeight: typography.weights.bold,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  endCallButton: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: colors.danger.main,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
    ...shadows.lg,
  },
  endCallButtonText: {
    color: colors.neutral.white,
    fontSize: typography.sizes.sm,
    fontWeight: typography.weights.bold,
    marginTop: spacing.xs,
  },
  loadingContainer: {
    position: 'absolute',
    bottom: spacing.xl,
    justifyContent: 'center',
    alignItems: 'center',
  },
  webNotAvailableContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.secondary.cream,
  },
  webNotAvailableText: {
    fontSize: typography.sizes.lg,
    fontWeight: typography.weights.bold,
    color: colors.neutral.darkGray,
    textAlign: 'center',
  },
  webContainer: {
    flex: 1,
  },
  webSafeArea: {
    flex: 1,
  },
  webContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  webTitle: {
    fontSize: typography.sizes.xxl,
    fontWeight: typography.weights.bold,
    color: colors.neutral.darkGray,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
  webDescription: {
    fontSize: typography.sizes.lg,
    color: colors.neutral.darkGray,
    marginTop: spacing.md,
    textAlign: 'center',
    lineHeight: 24,
  },
  webHint: {
    fontSize: typography.sizes.md,
    color: colors.primary.main,
    marginTop: spacing.lg,
    textAlign: 'center',
    lineHeight: 20,
  },
  webBackButton: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.primary.main,
    borderRadius: borderRadius.lg,
  },
  webBackButtonText: {
    color: colors.neutral.white,
    fontSize: typography.sizes.lg,
    fontWeight: typography.weights.bold,
  },
});

export default VoiceCallScreen;
