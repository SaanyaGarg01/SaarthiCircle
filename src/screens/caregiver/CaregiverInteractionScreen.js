// Caregiver Interaction Screen
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Linking,
  Alert,
  Platform,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LargeButton, AccessibleInput } from '../../components/common';
import { colors, typography, spacing, borderRadius, shadows } from '../../theme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { BACKEND_URL as API_BASE } from '../../config/backend';
import { useChat } from '../../context/ChatContext';
import { getSocket } from '../../services/socketService';

const CaregiverInteractionScreen = ({ navigation, route }) => {
  const { t } = useTranslation();
  const { requestId, request, conversationId, seniorId } = route.params || {};

  const { removeActiveChat } = useChat();

  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState('in_progress');
  const [sound, setSound] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Audio Playback
  const playVoiceMessage = async (uri) => {
    try {
      if (sound) {
        await sound.unloadAsync();
      }

      console.log('[AUDIO] Playing voice message:', uri);
      setIsPlaying(true);

      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true }
      );

      setSound(newSound);

      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          setIsPlaying(false);
          newSound.unloadAsync();
        }
      });
    } catch (error) {
      console.error('[AUDIO-ERROR] Failed to play sound:', error);
      setIsPlaying(false);
      Alert.alert('Playback Error', 'Could not play the voice message.');
    }
  };

  // Cleanup sound on unmount
  React.useEffect(() => {
    return () => {
      if (sound) {
        sound.unloadAsync();
      }
    };
  }, [sound]);

  // Use actual request data if available, otherwise use default
  const seniorDetails = request ? {
    name: request.seniorName || request.senior?.name || 'Senior',
    age: request.senior?.age || 'N/A',
    phone: request.senior?.phone || '+91 98765 43210',
    address: request.senior?.address || request.address || '123, Green Park, New Delhi',
    emergencyContact: request.senior?.emergencyContact || '+91 87654 32109',
    helpType: request.helpType || request.category || 'Help Request',
    description: request.description || request.message || 'Needs assistance',
    medicalInfo: request.senior?.medicalInfo || 'Not provided',
    hasAudio: request.hasAudio || request.raw?.has_audio || !!(request.audioUri || request.audio_uri || request.raw?.audio_uri),
    audioUri: request.audioUri || request.audio_uri || request.raw?.audio_uri,
  } : {
    name: 'Sharma Ji',
    age: 72,
    phone: '+91 98765 43210',
    address: '123, Green Park, New Delhi',
    emergencyContact: '+91 87654 32109',
    helpType: 'Daily Assistance',
    description: 'Needs help with medicine pickup from nearby pharmacy',
    medicalInfo: 'Diabetes, Blood Pressure',
    hasAudio: false,
  };

  const handleInAppCall = async () => {
    if (!conversationId || !seniorId) {
      Alert.alert('Notice', 'In-app calling requires an active conversation session. Please use Normal Phone Call if this is urgent.');
      return;
    }

    try {
      const profileJson = await AsyncStorage.getItem('userProfile');
      const profile = profileJson ? JSON.parse(profileJson) : null;
      const userId = profile?.id || profile?.uid || profile?.userId;

      if (!userId) {
        Alert.alert('Error', 'User profile not found. Please log in again.');
        return;
      }

      console.log('[CALL] Initiating in-app call:', {
        conversationId,
        callerId: userId,
        calleeId: seniorId,
      });

      // 1. Initiate call via socket
      const socket = getSocket();
      if (socket) {
        socket.emit('call:initiate', {
          conversationId,
          callerId: userId,
          calleeId: seniorId,
          callerName: profile?.fullName || profile?.name || 'Volunteer',
        });
      }

      // 2. Navigate to VoiceCall screen
      navigation.navigate('VoiceCall', {
        conversationId,
        companion: { id: seniorId, name: seniorDetails.name },
        callerId: userId,
        calleeId: seniorId,
        isIncoming: false,
      });
    } catch (error) {
      console.error('[CALL-ERROR] Failed to start in-app call:', error);
      Alert.alert('Error', 'Could not initiate in-app call. Please try again or use Normal Phone Call.');
    }
  };

  const handleCall = () => {
    const phoneNumber = seniorDetails.phone.replace(/\s/g, '');

    Alert.alert(
      t('caregiver.interaction.call'),
      'Select how you want to call:',
      [
        {
          text: 'Live In-App Call',
          onPress: handleInAppCall,
        },
        {
          text: 'Normal Phone Call',
          onPress: () => {
            const phoneUrl = `tel:${phoneNumber}`;
            if (Platform.OS === 'web') {
              if (typeof window !== 'undefined') window.open(phoneUrl, '_self');
              return;
            }
            Linking.canOpenURL(phoneUrl)
              .then(supported => {
                if (supported) {
                  return Linking.openURL(phoneUrl);
                } else {
                  Alert.alert('Error', 'Phone calls are not supported on this device');
                }
              })
              .catch(err => {
                console.error('Call error:', err);
                Alert.alert('Error', 'Could not initiate call');
              });
          }
        },
        { text: 'Cancel', style: 'cancel' }
      ]
    );
  };

  const handleChat = () => {
    // Open WhatsApp or SMS
    const phoneNumber = seniorDetails.phone.replace(/\s/g, '').replace('+', '');

    Alert.alert(
      'Chat with Senior',
      'Choose how you want to message:',
      [
        {
          text: 'In-App Chat',
          onPress: () => {
            if (conversationId) {
              navigation.navigate('Chat', {
                mode: 'text',
                companion: { id: seniorId, name: seniorDetails.name },
                conversationId
              });
            } else {
              Alert.alert('Error', 'Conversation not yet initialized. Please try again.');
            }
          }
        },
        {
          text: 'WhatsApp',
          onPress: () => {
            const encodedText = encodeURIComponent('Hello, I am your volunteer from SaathiCircle. How can I help you?');
            const whatsappWebUrl = `https://wa.me/${phoneNumber}?text=${encodedText}`;
            if (Platform.OS === 'web') {
              if (typeof window !== 'undefined') window.open(whatsappWebUrl, '_blank');
              return;
            }
            const whatsappAppUrl = `whatsapp://send?phone=${phoneNumber}&text=${encodedText}`;
            Linking.canOpenURL(whatsappAppUrl)
              .then(supported => {
                if (supported) {
                  return Linking.openURL(whatsappAppUrl);
                } else {
                  return Linking.openURL(whatsappWebUrl);
                }
              })
              .catch(() => Linking.openURL(whatsappWebUrl));
          }
        },
        {
          text: 'SMS',
          onPress: () => {
            const smsUrl = Platform.OS === 'ios'
              ? `sms:${seniorDetails.phone}`
              : `sms:${seniorDetails.phone}?body=Hello from SaathiCircle volunteer`;
            Linking.openURL(smsUrl).catch(err =>
              Alert.alert('Error', 'Could not open messaging app')
            );
          }
        },
        { text: 'Cancel', style: 'cancel' }
      ]
    );
  };

  const handleLocation = () => {
    const address = encodeURIComponent(seniorDetails.address);
    const webMapsUrl = `https://www.google.com/maps/search/?api=1&query=${address}`;

    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.open(webMapsUrl, '_blank');
      return;
    }

    Alert.alert(
      'Open Location',
      'Choose maps app:',
      [
        {
          text: 'Google Maps',
          onPress: () => {
            const googleMapsUrl = Platform.OS === 'ios'
              ? `comgooglemaps://?q=${address}`
              : `geo:0,0?q=${address}`;

            Linking.canOpenURL(googleMapsUrl)
              .then(supported => {
                if (supported) {
                  return Linking.openURL(googleMapsUrl);
                } else {
                  return Linking.openURL(webMapsUrl);
                }
              })
              .catch(() => {
                Linking.openURL(webMapsUrl);
              });
          }
        },
        {
          text: 'Apple Maps',
          onPress: () => {
            const appleMapsUrl = `maps:0,0?q=${address}`;
            Linking.openURL(appleMapsUrl).catch(err => {
              // Fallback to web
              Linking.openURL(`https://maps.apple.com/?q=${address}`);
            });
          }
        },
        { text: 'Cancel', style: 'cancel' }
      ]
    );
  };

  const handleMarkResolved = async () => {
    const doResolve = async () => {
      const resolvedRequestId =
        requestId ||
        request?.id ||
        request?.raw?.id ||
        request?.raw?.request_id ||
        request?.request_id;

      if (!resolvedRequestId) {
        throw new Error('Missing request id');
      }

      if (resolvedRequestId && !resolvedRequestId.toString().startsWith('dummy')) {
        const token = await AsyncStorage.getItem('userToken');
        const isSOS = request?.helpType === 'SOS' || request?.type === 'SOS';
        const endpoint = isSOS
          ? `${API_BASE}/sos-alerts/${resolvedRequestId}/resolve`
          : `${API_BASE}/help-requests/${resolvedRequestId}/complete`;

        const method = isSOS ? 'POST' : 'PUT';

        const resp = await fetch(endpoint, {
          method,
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: isSOS ? JSON.stringify({ notes: notes || 'Resolved by volunteer' }) : undefined
        });
        if (!resp.ok) {
          let message = 'Failed to resolve request';
          try {
            const errJson = await resp.json();
            if (errJson?.error) message = errJson.error;
          } catch { }
          throw new Error(message);
        }
      }

      const resolvedConversationId =
        conversationId ||
        request?.conversationId ||
        request?.conversation_id ||
        request?.raw?.conversationId ||
        request?.raw?.conversation_id;

      if (resolvedConversationId && !String(resolvedConversationId).startsWith('local-')) {
        try {
          const profileJson = await AsyncStorage.getItem('userProfile');
          const profile = profileJson ? JSON.parse(profileJson) : null;
          const userId = profile?.id || profile?.uid || profile?.userId;
          await fetch(`${API_BASE}/conversations/${resolvedConversationId}/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userId || 'USER' }),
          });
          removeActiveChat?.(resolvedConversationId);
          const socket = getSocket();
          socket?.emit('chat:end', { conversationId: resolvedConversationId, userId: userId || 'USER' });
        } catch (e) {
          // ignore
        }
      }

      try {
        if (String(resolvedRequestId).startsWith('dummy')) {
          const existing = await AsyncStorage.getItem('dummyResolvedIds');
          const parsed = existing ? JSON.parse(existing) : [];
          const next = Array.from(new Set([...(Array.isArray(parsed) ? parsed : []), String(resolvedRequestId)]));
          await AsyncStorage.setItem('dummyResolvedIds', JSON.stringify(next));
        } else {
          await AsyncStorage.setItem('lastResolvedRequestId', String(resolvedRequestId));
        }
      } catch { }
    };

    try {
      if (Platform.OS === 'web') {
        const ok = globalThis?.confirm ? globalThis.confirm('Mark this request as resolved?') : true;
        if (!ok) return;
        await doResolve();
        globalThis?.alert && globalThis.alert('Request marked as resolved!');
        navigation.goBack();
        return;
      }

      Alert.alert(
        'Mark as Resolved',
        'Are you sure you want to mark this request as resolved?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Yes, Resolve',
            onPress: async () => {
              try {
                await doResolve();
                Alert.alert('Success', 'Request marked as resolved!');
                navigation.goBack();
              } catch (error) {
                console.error('Resolve error:', error);
                Alert.alert('Error', error?.message || 'Failed to resolve request. Please try again.');
              }
            }
          }
        ]
      );
    } catch (error) {
      console.error('Resolve error:', error);
      if (Platform.OS === 'web') {
        globalThis?.alert && globalThis.alert(error?.message || 'Failed to resolve request.');
      } else {
        Alert.alert('Error', error?.message || 'Failed to resolve request. Please try again.');
      }
    }
  };

  const handleEscalate = () => {
    if (Platform.OS === 'web') {
      const reason = globalThis?.prompt ? globalThis.prompt('Enter escalation reason (optional):', '') : '';
      confirmEscalation(reason || 'Escalated');
      return;
    }

    Alert.alert(
      'Escalate to Admin',
      'Please select a reason for escalation:',
      [
        {
          text: 'Medical Emergency',
          onPress: () => confirmEscalation('Medical Emergency')
        },
        {
          text: 'Senior Not Responding',
          onPress: () => confirmEscalation('Senior Not Responding')
        },
        {
          text: 'Need Additional Help',
          onPress: () => confirmEscalation('Need Additional Help')
        },
        {
          text: 'Safety Concern',
          onPress: () => confirmEscalation('Safety Concern')
        },
        { text: 'Cancel', style: 'cancel' }
      ]
    );
  };

  const confirmEscalation = (reason) => {
    const doEscalate = async () => {
      const resolvedRequestId =
        requestId ||
        request?.id ||
        request?.raw?.id ||
        request?.raw?.request_id ||
        request?.request_id;
      if (!resolvedRequestId) throw new Error('Missing request id');
      if (String(resolvedRequestId).startsWith('dummy')) {
        try {
          const existing = await AsyncStorage.getItem('dummyResolvedIds');
          const parsed = existing ? JSON.parse(existing) : [];
          const next = Array.from(new Set([...(Array.isArray(parsed) ? parsed : []), String(resolvedRequestId)]));
          await AsyncStorage.setItem('dummyResolvedIds', JSON.stringify(next));
        } catch { }
        return;
      }

      const token = await AsyncStorage.getItem('userToken');
      const isSOS = request?.helpType === 'SOS' || request?.type === 'SOS';
      const endpoint = isSOS
        ? `${API_BASE}/sos-alerts/${resolvedRequestId}/escalate`
        : `${API_BASE}/help-requests/${resolvedRequestId}/escalate`;

      const method = isSOS ? 'POST' : 'PUT';

      const resp = await fetch(endpoint, {
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || '' })
      });
      if (!resp.ok) {
        let message = 'Failed to escalate request';
        try {
          const errJson = await resp.json();
          if (errJson?.error) message = errJson.error;
        } catch { }
        throw new Error(message);
      }
    };

    if (Platform.OS === 'web') {
      const ok = globalThis?.confirm ? globalThis.confirm(`Escalate this request?\n\nReason: ${reason || 'N/A'}`) : true;
      if (!ok) return;
      doEscalate()
        .then(() => {
          globalThis?.alert && globalThis.alert('Request escalated to NGO/Admin.');
          navigation.goBack();
        })
        .catch((e) => {
          globalThis?.alert && globalThis.alert(e?.message || 'Failed to escalate request.');
        });
      return;
    }

    Alert.alert(
      'Confirm Escalation',
      `This request will be escalated to admin with reason: "${reason}"\n\nAn admin will be notified immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Escalate Now',
          style: 'destructive',
          onPress: async () => {
            try {
              await doEscalate();
              Alert.alert(
                'Escalated',
                'This request has been escalated to the admin team. They will contact you shortly.',
                [{ text: 'OK', onPress: () => navigation.goBack() }]
              );
            } catch (e) {
              Alert.alert('Error', e?.message || 'Failed to escalate request.');
            }
          }
        }
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <MaterialCommunityIcons
            name="arrow-left"
            size={28}
            color={colors.neutral.black}
          />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('caregiver.interaction.seniorDetails')}</Text>
        <TouchableOpacity style={styles.moreButton}>
          <MaterialCommunityIcons
            name="dots-vertical"
            size={28}
            color={colors.neutral.black}
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Senior Profile Card */}
        <View style={[styles.profileCard, shadows.md]}>
          <View style={styles.profileHeader}>
            <View style={styles.avatar}>
              <MaterialCommunityIcons
                name="account"
                size={48}
                color={colors.primary.main}
              />
            </View>
            <View style={styles.profileInfo}>
              <Text style={styles.seniorName}>{seniorDetails.name}</Text>
              <Text style={styles.seniorAge}>Age: {seniorDetails.age} years</Text>
            </View>
            <View style={styles.statusBadge}>
              <Text style={styles.statusText}>In Progress</Text>
            </View>
          </View>

          {/* Quick Actions */}
          <View style={styles.quickActions}>
            <TouchableOpacity
              style={[styles.actionButton, styles.callAction]}
              onPress={handleCall}
            >
              <MaterialCommunityIcons
                name="phone"
                size={24}
                color={colors.neutral.white}
              />
              <Text style={styles.actionText}>{t('caregiver.interaction.call')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionButton, styles.chatAction]}
              onPress={handleChat}
            >
              <MaterialCommunityIcons
                name="message-text"
                size={24}
                color={colors.neutral.white}
              />
              <Text style={styles.actionText}>{t('caregiver.interaction.chat')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionButton, styles.mapAction]}
              onPress={handleLocation}
            >
              <MaterialCommunityIcons
                name="map-marker"
                size={24}
                color={colors.neutral.white}
              />
              <Text style={styles.actionText}>{t('caregiver.interaction.location')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Help Request Details */}
        <View style={[styles.detailsCard, shadows.sm]}>
          <Text style={styles.sectionTitle}>{t('caregiver.interaction.helpRequest')}</Text>

          <View style={styles.detailRow}>
            <MaterialCommunityIcons
              name="help-circle"
              size={24}
              color={colors.primary.main}
            />
            <View style={styles.detailContent}>
              <Text style={styles.detailLabel}>{t('caregiver.interaction.type')}</Text>
              <Text style={styles.detailValue}>{seniorDetails.helpType}</Text>
            </View>
          </View>

          <View style={styles.detailRow}>
            <MaterialCommunityIcons
              name="text"
              size={24}
              color={colors.primary.main}
            />
            <View style={styles.detailContent}>
              <Text style={styles.detailLabel}>{t('caregiver.interaction.description')}</Text>
              <Text style={styles.detailValue}>{seniorDetails.description}</Text>
            </View>
          </View>

          {/* Voice Preview Section for Volunteers */}
          {seniorDetails.hasAudio && seniorDetails.audioUri && (
            <View style={styles.voiceSection}>
              <Text style={styles.detailLabel}>Voice Message</Text>
              <TouchableOpacity
                style={styles.playButton}
                onPress={() => playVoiceMessage(seniorDetails.audioUri)}
              >
                <MaterialCommunityIcons
                  name={isPlaying ? "stop-circle" : "play-circle"}
                  size={32}
                  color={colors.primary.main}
                />
                <Text style={styles.playText}>
                  {isPlaying ? "Playing..." : "Listen to Request"}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Contact Information */}
        <View style={[styles.detailsCard, shadows.sm]}>
          <Text style={styles.sectionTitle}>{t('caregiver.interaction.contactInfo')}</Text>

          <View style={styles.detailRow}>
            <MaterialCommunityIcons
              name="phone"
              size={24}
              color={colors.secondary.green}
            />
            <View style={styles.detailContent}>
              <Text style={styles.detailLabel}>{t('caregiver.interaction.phone')}</Text>
              <Text style={styles.detailValue}>{seniorDetails.phone}</Text>
            </View>
          </View>

          <View style={styles.detailRow}>
            <MaterialCommunityIcons
              name="map-marker"
              size={24}
              color={colors.accent.orange}
            />
            <View style={styles.detailContent}>
              <Text style={styles.detailLabel}>{t('caregiver.interaction.address')}</Text>
              <Text style={styles.detailValue}>{seniorDetails.address}</Text>
            </View>
          </View>

          <View style={styles.detailRow}>
            <MaterialCommunityIcons
              name="phone-alert"
              size={24}
              color={colors.accent.red}
            />
            <View style={styles.detailContent}>
              <Text style={styles.detailLabel}>{t('caregiver.interaction.emergencyContact')}</Text>
              <Text style={styles.detailValue}>{seniorDetails.emergencyContact}</Text>
            </View>
          </View>
        </View>

        {/* Medical Information */}
        <View style={[styles.medicalCard, shadows.sm]}>
          <View style={styles.medicalHeader}>
            <MaterialCommunityIcons
              name="medical-bag"
              size={24}
              color={colors.accent.red}
            />
            <Text style={styles.medicalTitle}>{t('caregiver.interaction.medicalInfo')}</Text>
          </View>
          <Text style={styles.medicalText}>{seniorDetails.medicalInfo}</Text>
        </View>

        {/* Notes Section */}
        <View style={[styles.notesCard, shadows.sm]}>
          <Text style={styles.sectionTitle}>{t('caregiver.interaction.notes')}</Text>
          <TextInput
            style={styles.notesInput}
            value={notes}
            onChangeText={setNotes}
            placeholder={t('caregiver.interaction.notesPlaceholder')}
            placeholderTextColor={colors.neutral.darkGray}
            multiline
            numberOfLines={4}
          />
        </View>

        {/* Action Buttons */}
        <View style={styles.actionButtons}>
          <LargeButton
            title={t('caregiver.interaction.startChat')}
            onPress={() => {
              if (conversationId && seniorId) {
                navigation.navigate('Chat', {
                  mode: 'text',
                  companion: { id: seniorId, name: seniorDetails.name },
                  conversationId
                });
              } else {
                Alert.alert('Error', 'Conversation not yet initialized. Please try again.');
              }
            }}
            icon="message-text"
            variant="primary"
            size="xl"
            style={styles.chatButton}
          />

          <LargeButton
            title={t('caregiver.interaction.markResolved')}
            onPress={handleMarkResolved}
            icon="check-circle"
            variant="secondary"
            size="xl"
            style={styles.resolveButton}
          />

          <TouchableOpacity
            style={styles.escalateButton}
            onPress={handleEscalate}
          >
            <MaterialCommunityIcons
              name="arrow-up-circle"
              size={24}
              color={colors.accent.red}
            />
            <Text style={styles.escalateText}>{t('caregiver.interaction.escalate')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.neutral.lightGray,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.neutral.white,
    padding: spacing.md,
    ...shadows.sm,
  },
  backButton: {
    padding: spacing.sm,
  },
  headerTitle: {
    fontSize: typography.sizes.lg,
    fontWeight: typography.weights.semiBold,
    color: colors.neutral.black,
  },
  moreButton: {
    padding: spacing.sm,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.md,
    paddingBottom: spacing.xxl,
  },
  profileCard: {
    backgroundColor: colors.neutral.white,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primary.light,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileInfo: {
    flex: 1,
    marginLeft: spacing.md,
  },
  seniorName: {
    fontSize: typography.sizes.xl,
    fontWeight: typography.weights.bold,
    color: colors.neutral.black,
  },
  seniorAge: {
    fontSize: typography.sizes.md,
    color: colors.neutral.darkGray,
    marginTop: spacing.xs,
  },
  statusBadge: {
    backgroundColor: colors.accent.orange,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
  },
  statusText: {
    fontSize: typography.sizes.xs,
    fontWeight: typography.weights.semiBold,
    color: colors.neutral.white,
  },
  quickActions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  actionButton: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.md,
    minWidth: 90,
  },
  callAction: {
    backgroundColor: colors.secondary.green,
  },
  chatAction: {
    backgroundColor: colors.primary.main,
  },
  mapAction: {
    backgroundColor: colors.accent.orange,
  },
  actionText: {
    fontSize: typography.sizes.sm,
    fontWeight: typography.weights.medium,
    color: colors.neutral.white,
    marginTop: spacing.xs,
  },
  detailsCard: {
    backgroundColor: colors.neutral.white,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: typography.sizes.lg,
    fontWeight: typography.weights.semiBold,
    color: colors.neutral.black,
    marginBottom: spacing.md,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  detailContent: {
    flex: 1,
    marginLeft: spacing.md,
  },
  detailLabel: {
    fontSize: typography.sizes.sm,
    color: colors.neutral.darkGray,
  },
  detailValue: {
    fontSize: typography.sizes.md,
    color: colors.neutral.black,
    marginTop: spacing.xs,
  },
  medicalCard: {
    backgroundColor: '#FFF5F5',
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: '#FFCDD2',
  },
  medicalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  medicalTitle: {
    fontSize: typography.sizes.lg,
    fontWeight: typography.weights.semiBold,
    color: colors.accent.red,
    marginLeft: spacing.sm,
  },
  medicalText: {
    fontSize: typography.sizes.md,
    color: colors.neutral.black,
  },
  notesCard: {
    backgroundColor: colors.neutral.white,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  notesInput: {
    backgroundColor: colors.neutral.lightGray,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    fontSize: typography.sizes.md,
    color: colors.neutral.black,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  actionButtons: {
    marginTop: spacing.md,
  },
  resolveButton: {
    marginBottom: spacing.md,
  },
  escalateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  escalateText: {
    fontSize: typography.sizes.md,
    color: colors.accent.red,
    fontWeight: typography.weights.medium,
    marginLeft: spacing.sm,
  },
  voiceSection: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.neutral.lightGray,
  },
  playButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary.light + '40',
    padding: spacing.sm,
    borderRadius: borderRadius.md,
    marginTop: spacing.xs,
  },
  playText: {
    marginLeft: spacing.sm,
    fontSize: typography.sizes.md,
    fontWeight: typography.weights.semiBold,
    color: colors.primary.main,
  },
});

export default CaregiverInteractionScreen;
