// SOS Emergency Screen - Critical emergency feature
import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  Animated,
  Alert,
  Vibration,
  Linking,
  Platform,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LargeButton } from '../../components/common';
import { colors, typography, spacing, borderRadius, shadows } from '../../theme';
import { BACKEND_URL as API_BASE } from '../../config/backend';

const SOSScreen = ({ navigation }) => {
  const { t } = useTranslation();

  const [isActivated, setIsActivated] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const [isSent, setIsSent] = useState(false);
  const [userProfile, setUserProfile] = useState(null);
  const [emergencyContacts, setEmergencyContacts] = useState([]);

  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    loadUserData();

    // Continuous pulse animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
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
  }, []);

  const loadUserData = async () => {
    try {
      const profileJson = await AsyncStorage.getItem('userProfile');
      if (profileJson) {
        const profile = JSON.parse(profileJson);
        setUserProfile(profile);

        // Load emergency contacts
        const contactsJson = await AsyncStorage.getItem('emergencyContacts');
        if (contactsJson) {
          setEmergencyContacts(JSON.parse(contactsJson));
        } else {
          // Default emergency contact
          setEmergencyContacts([
            { name: 'Emergency Services', phone: '112', relationship: 'Emergency' }
          ]);
        }
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  };

  const getEmergencyPhones = () => {
    const phones = (emergencyContacts || [])
      .map((c) => String(c?.phone || '').trim())
      .filter(Boolean);
    // Always include emergency services as fallback
    phones.push('112');
    return Array.from(new Set(phones));
  };

  const sendSmsFallback = async () => {
    try {
      if (Platform.OS === 'web') return;
      const phones = getEmergencyPhones();
      if (!phones.length) return;

      const body = encodeURIComponent('SOS! I need help immediately. Please call me back.');
      // Note: platform-specific sms url formats
      const recipient = phones.join(',');
      const url = Platform.OS === 'ios' ? `sms:${recipient}&body=${body}` : `sms:${recipient}?body=${body}`;

      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      }
    } catch {
      // ignore
    }
  };

  const sendSOSAlert = async () => {
    try {
      const token = await AsyncStorage.getItem('userToken');
      if (!token) return { ok: false };

      const phones = getEmergencyPhones();
      const resp = await fetch(`${API_BASE}/sos-alerts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Emergency SOS triggered', type: 'panic', emergencyPhones: phones }),
      });
      if (!resp.ok) return { ok: false };
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };

  const callEmergencyContact = async () => {
    // Try to call first emergency contact or 112
    const primaryContact = emergencyContacts.find(c => c.isPrimary) || emergencyContacts[0];
    const phoneNumber = primaryContact?.phone || '112';

    const url = `tel:${phoneNumber}`;
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.open(url, '_self');
      return;
    }

    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      } else {
        Alert.alert('Cannot make call', `Please dial ${phoneNumber} manually`);
      }
    } catch (error) {
      console.error('Error making call:', error);
      Alert.alert('Call Failed', `Please dial ${phoneNumber} manually`);
    }
  };

  useEffect(() => {
    if (isActivated && countdown > 0) {
      const timer = setInterval(() => {
        setCountdown((prev) => prev - 1);
        if (Platform.OS !== 'web') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => { });
        }
        Vibration.vibrate(500);
      }, 1000);

      return () => clearInterval(timer);
    } else if (isActivated && countdown === 0) {
      // Send SOS
      setIsSent(true);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => { });
      }

      // Actually send the SOS alert
      (async () => {
        const result = await sendSOSAlert();
        if (!result?.ok) {
          // No internet / backend failed: fallback channels still work
          try {
            await callEmergencyContact();
          } catch { }
          try {
            await sendSmsFallback();
          } catch { }
        }
      })();

      // Try to call emergency contact
      setTimeout(() => {
        Alert.alert(
          '📞 Call Emergency Contact?',
          'Would you like to call your emergency contact now?',
          [
            { text: 'No', style: 'cancel' },
            {
              text: 'Yes, Call Now',
              onPress: callEmergencyContact,
              style: 'default',
            },
          ]
        );
      }, 1000);
    }
  }, [isActivated, countdown]);

  const handleSOSPress = () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => { });
    }
    setIsActivated(true);
  };

  const handleCancel = () => {
    Alert.alert(
      t('sos.confirmCancel'),
      '',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes',
          style: 'destructive',
          onPress: () => {
            setIsActivated(false);
            setCountdown(5);
            setIsSent(false);
          },
        },
      ]
    );
  };

  const handleGoBack = () => {
    navigation.goBack();
  };

  // SOS Sent Confirmation
  if (isSent) {
    return (
      <View style={styles.sentContainer}>
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.sentContent}>
            <View style={styles.sentIconContainer}>
              <MaterialCommunityIcons
                name="check-circle"
                size={100}
                color={colors.neutral.white}
              />
            </View>

            <Text style={styles.sentTitle}>{t('sos.alertSent')}</Text>
            <Text style={styles.sentSubtitle}>
              {t('sos.alertSentDesc')}
            </Text>

            <View style={styles.contactsCard}>
              <Text style={styles.contactsTitle}>{t('sos.quickCall')}</Text>

              {/* Emergency Services */}
              <TouchableOpacity
                style={styles.contactItem}
                onPress={() => Linking.openURL('tel:112')}
              >
                <MaterialCommunityIcons name="phone-alert" size={24} color={colors.neutral.white} />
                <Text style={styles.contactText}>{t('sos.emergency')} - 112</Text>
                <MaterialCommunityIcons name="phone" size={20} color={colors.accent.yellow} />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.contactItem}
                onPress={() => Linking.openURL('tel:108')}
              >
                <MaterialCommunityIcons name="ambulance" size={24} color={colors.neutral.white} />
                <Text style={styles.contactText}>{t('sos.ambulance')} - 108</Text>
                <MaterialCommunityIcons name="phone" size={20} color={colors.accent.yellow} />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.contactItem}
                onPress={() => Linking.openURL('tel:100')}
              >
                <MaterialCommunityIcons name="police-badge" size={24} color={colors.neutral.white} />
                <Text style={styles.contactText}>{t('sos.police')} - 100</Text>
                <MaterialCommunityIcons name="phone" size={20} color={colors.accent.yellow} />
              </TouchableOpacity>

              {emergencyContacts.length > 0 && emergencyContacts[0].phone && (
                <TouchableOpacity
                  style={styles.contactItem}
                  onPress={() => Linking.openURL(`tel:${emergencyContacts[0].phone}`)}
                >
                  <MaterialCommunityIcons name="account-heart" size={24} color={colors.neutral.white} />
                  <Text style={styles.contactText}>
                    {emergencyContacts[0].name || 'Emergency Contact'}
                  </Text>
                  <MaterialCommunityIcons name="phone" size={20} color={colors.accent.yellow} />
                </TouchableOpacity>
              )}
            </View>

            <Text style={styles.stayCalm}>
              {t('sos.stayCalm')}
            </Text>

            <LargeButton
              title={t('sos.returnHome')}
              onPress={() => navigation.reset({ index: 0, routes: [{ name: 'ElderlyApp' }] })}
              variant="outline"
              size="lg"
              style={styles.homeButton}
              textStyle={{ color: colors.neutral.white }}
            />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={handleGoBack}
            style={styles.backButton}
          >
            <MaterialCommunityIcons
              name="close"
              size={32}
              color={colors.neutral.white}
            />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('sos.title')}</Text>
          <View style={{ width: 48 }} />
        </View>

        {/* Main Content */}
        <View style={styles.content}>
          {/* SOS Button */}
          <Animated.View
            style={[
              styles.sosButtonOuter,
              { transform: [{ scale: pulseAnim }] },
            ]}
          >
            <TouchableOpacity
              style={[
                styles.sosButton,
                isActivated && styles.sosButtonActivated,
              ]}
              onPress={handleSOSPress}
              disabled={isActivated}
              activeOpacity={0.8}
            >
              {isActivated ? (
                <Text style={styles.countdownText}>{countdown}</Text>
              ) : (
                <>
                  <MaterialCommunityIcons
                    name="alert-circle"
                    size={60}
                    color={colors.neutral.white}
                  />
                  <Text style={styles.sosText}>{t('sos.buttonText')}</Text>
                </>
              )}
            </TouchableOpacity>
          </Animated.View>

          {/* Status Text */}
          <Text style={styles.statusText}>
            {isActivated
              ? t('sos.sendingStatus', { count: countdown })
              : t('sos.pressHold')
            }
          </Text>

          {/* Voice Hint */}
          <View style={styles.voiceHint}>
            <MaterialCommunityIcons
              name="microphone"
              size={24}
              color={colors.neutral.white}
            />
            <Text style={styles.voiceHintText}>{t('sos.voiceHint')}</Text>
          </View>

          {/* Escalation Info */}
          <View style={styles.infoCard}>
            <MaterialCommunityIcons
              name="information"
              size={24}
              color={colors.accent.yellow}
            />
            <Text style={styles.infoText}>{t('sos.escalationInfo')}</Text>
          </View>

          {/* Cancel Button */}
          {isActivated && (
            <LargeButton
              title={t('sos.cancel')}
              onPress={handleCancel}
              variant="outline"
              size="lg"
              style={styles.cancelButton}
              textStyle={{ color: colors.neutral.white }}
            />
          )}
        </View>

        {/* Emergency Numbers */}
        <View style={styles.emergencyNumbers}>
          <Text style={styles.emergencyTitle}>{t('sos.emergencyNumbers')}</Text>
          <View style={styles.numberRow}>
            <TouchableOpacity
              style={styles.numberItem}
              onPress={() => Linking.openURL('tel:100')}
            >
              <Text style={styles.numberLabel}>{t('sos.police')}</Text>
              <Text style={styles.number}>100</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.numberItem}
              onPress={() => Linking.openURL('tel:108')}
            >
              <Text style={styles.numberLabel}>{t('sos.ambulance')}</Text>
              <Text style={styles.number}>108</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.numberItem}
              onPress={() => Linking.openURL('tel:112')}
            >
              <Text style={styles.numberLabel}>{t('sos.emergency')}</Text>
              <Text style={styles.number}>112</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.accent.red,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  backButton: {
    padding: spacing.sm,
  },
  headerTitle: {
    fontSize: typography.sizes.xl,
    fontWeight: typography.weights.bold,
    color: colors.neutral.white,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  sosButtonOuter: {
    marginBottom: spacing.xl,
  },
  sosButton: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: colors.neutral.white,
  },
  sosButtonActivated: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  sosText: {
    fontSize: typography.sizes.xxl,
    fontWeight: typography.weights.bold,
    color: colors.neutral.white,
    marginTop: spacing.sm,
  },
  countdownText: {
    fontSize: 80,
    fontWeight: typography.weights.bold,
    color: colors.neutral.white,
  },
  statusText: {
    fontSize: typography.sizes.lg,
    color: colors.neutral.white,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  voiceHint: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.md,
  },
  voiceHintText: {
    fontSize: typography.sizes.md,
    color: colors.neutral.white,
    marginLeft: spacing.sm,
  },
  infoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
    marginBottom: spacing.lg,
  },
  infoText: {
    fontSize: typography.sizes.sm,
    color: colors.neutral.white,
    marginLeft: spacing.sm,
    flex: 1,
  },
  cancelButton: {
    borderColor: colors.neutral.white,
    backgroundColor: 'transparent',
    marginTop: spacing.md,
  },
  emergencyNumbers: {
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  emergencyTitle: {
    fontSize: typography.sizes.md,
    fontWeight: typography.weights.semiBold,
    color: colors.neutral.white,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  numberRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  numberItem: {
    alignItems: 'center',
    padding: spacing.sm,
  },
  numberLabel: {
    fontSize: typography.sizes.sm,
    color: colors.neutral.white,
    opacity: 0.8,
  },
  number: {
    fontSize: typography.sizes.xl,
    fontWeight: typography.weights.bold,
    color: colors.neutral.white,
  },
  // Sent Screen Styles
  sentContainer: {
    flex: 1,
    backgroundColor: colors.secondary.green,
  },
  sentContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  sentIconContainer: {
    marginBottom: spacing.lg,
  },
  sentTitle: {
    fontSize: typography.sizes.xxxl,
    fontWeight: typography.weights.bold,
    color: colors.neutral.white,
    marginBottom: spacing.sm,
  },
  sentSubtitle: {
    fontSize: typography.sizes.lg,
    color: colors.neutral.white,
    textAlign: 'center',
    marginBottom: spacing.xl,
    opacity: 0.9,
  },
  contactsCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    width: '100%',
    marginBottom: spacing.lg,
  },
  contactsTitle: {
    fontSize: typography.sizes.lg,
    fontWeight: typography.weights.bold,
    color: colors.neutral.white,
    marginBottom: spacing.md,
  },
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.2)',
  },
  contactText: {
    fontSize: typography.sizes.md,
    color: colors.neutral.white,
    marginLeft: spacing.md,
    flex: 1,
  },
  stayCalm: {
    fontSize: typography.sizes.lg,
    color: colors.neutral.white,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  homeButton: {
    borderColor: colors.neutral.white,
    backgroundColor: 'transparent',
  },
});

export default SOSScreen;
