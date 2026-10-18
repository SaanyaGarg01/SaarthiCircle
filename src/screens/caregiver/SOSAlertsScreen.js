// SOS Alerts Screen for Caregivers
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  Animated,
  Vibration,
  Alert,
  Linking,
  Platform,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LargeButton } from '../../components/common';
import { colors, typography, spacing, borderRadius, shadows } from '../../theme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BACKEND_URL as API_BASE } from '../../config/backend';
import { logout } from '../../services/authService';
import { getSocket, identify } from '../../services/socketService';

const SOSAlertsScreen = ({ navigation }) => {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processingIds, setProcessingIds] = useState(() => new Set());

  const pulseAnim = useRef(new Animated.Value(1)).current;

  const formatTimeAgo = (date) => {
    if (!date) return '—';
    const now = new Date();
    const past = date instanceof Date ? date : new Date(date);
    const diff = now - past;
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} mins ago`;
    if (hours < 24) return `${hours} hours ago`;
    return `${days} days ago`;
  };

  const getTokenOrLogout = async () => {
    const token = await AsyncStorage.getItem('userToken');
    if (!token) {
      navigation.replace('Login');
      return null;
    }
    return token;
  };

  const mapAlert = (row) => {
    const senior = row?.senior || null;
    const seniorName = senior?.name || senior?.full_name || 'Senior';
    const phone = senior?.phone || senior?.phoneNumber || senior?.mobile || '';
    const createdAt = row?.created_at || row?.createdAt;
    const statusRaw = String(row?.status || 'active').toLowerCase();
    const uiStatus = statusRaw === 'accepted' || statusRaw === 'in_progress' || statusRaw === 'acknowledged' ? 'acknowledged' : statusRaw;
    const typeText = row?.type ? String(row.type) : 'SOS Emergency';

    const lat = row?.latitude;
    const lng = row?.longitude;
    const locText = (lat !== undefined && lng !== undefined)
      ? `Lat ${Number(lat).toFixed(5)}, Lng ${Number(lng).toFixed(5)}`
      : 'Location not available';

    return {
      id: row?.id,
      seniorId: senior?.id || row?.senior_id || row?.user_id || row?.seniorId,
      seniorName,
      type: typeText === 'panic' ? 'SOS Emergency' : typeText,
      time: formatTimeAgo(createdAt),
      location: locText,
      phone,
      status: uiStatus,
      backendStatus: statusRaw,
      medicalInfo: senior?.medical_info || senior?.medicalInfo || '—',
      raw: row,
    };
  };

  const loadAlerts = async () => {
    try {
      setLoading(true);
      const token = await getTokenOrLogout();
      if (!token) return;
      const resp = await fetch(`${API_BASE}/volunteer/sos-alerts?status=all`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.status === 401) {
        await logout();
        navigation.replace('Login');
        return;
      }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Failed to load SOS alerts');
      const rows = Array.isArray(data?.alerts) ? data.alerts : [];
      setAlerts(rows.map(mapAlert));
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Pulse animation for active alerts
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.1,
          duration: 500,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 500,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ])
    ).start();

    // Quick connectivity check so UI doesn't fail silently
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/health`);
        if (!resp.ok) {
          Alert.alert('Backend issue', `Backend not reachable (status ${resp.status}).\n\nBackend: ${API_BASE}`);
        }
      } catch (e) {
        Alert.alert('Backend issue', `Cannot reach backend.\n\nBackend: ${API_BASE}`);
      }
    })();

    loadAlerts();

    const initRealtime = async () => {
      try {
        const profileJson = await AsyncStorage.getItem('userProfile');
        const profile = profileJson ? JSON.parse(profileJson) : null;
        const userId = profile?.id || profile?.uid || profile?.userId;
        if (userId) {
          identify({ userId, role: 'VOLUNTEER' });
        }

        const socket = getSocket();
        const onNew = (payload) => {
          try {
            const incoming = mapAlert(payload?.alert || payload);
            setAlerts((prev) => {
              const exists = prev.some((a) => String(a.id) === String(incoming.id));
              if (exists) return prev;
              return [incoming, ...prev];
            });
            Vibration.vibrate([300, 200, 300]);
          } catch { }
        };
        const onAssigned = (payload) => {
          try {
            const incoming = mapAlert(payload?.alert || payload);
            setAlerts((prev) => {
              const idx = prev.findIndex((a) => String(a.id) === String(incoming.id));
              if (idx === -1) return [incoming, ...prev];
              const next = [...prev];
              next[idx] = { ...next[idx], ...incoming };
              return next;
            });
            Vibration.vibrate([300, 200, 300]);
          } catch { }
        };

        socket.off('sos:new');
        socket.off('sos:assigned');
        socket.on('sos:new', onNew);
        socket.on('sos:assigned', onAssigned);

        // Re-identify on reconnect (fixes issue where server restart wipes online list)
        socket.on('connect', () => {
          console.log('[SOS] Socket reconnected, re-identifying...');
          identify({ userId, role: 'VOLUNTEER' });
        });
      } catch (e) {
        // ignore
      }
    };

    initRealtime();

    return () => {
      try {
        const socket = getSocket();
        socket.off('sos:new');
        socket.off('sos:assigned');
      } catch { }
    };
  }, []);

  useEffect(() => {
    // Vibrate for active SOS alerts
    const activeAlerts = alerts.filter(a => String(a.backendStatus || a.status) === 'active');
    if (activeAlerts.length > 0) {
      Vibration.vibrate([500, 500, 500]);
    }
  }, [alerts]);

  const withProcessing = async (alertId, fn) => {
    setProcessingIds((prev) => {
      const next = new Set(prev);
      next.add(String(alertId));
      return next;
    });
    try {
      return await fn();
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(String(alertId));
        return next;
      });
    }
  };

  const acceptIfNeeded = async ({ alert, token }) => {
    const st = String(alert?.backendStatus || alert?.status || '').toLowerCase();
    if (st !== 'active') return { accepted: true, already: true };

    const resp = await fetch(`${API_BASE}/sos-alerts/${alert.id}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return { accepted: true, alert: data?.alert || null };
    if (resp.status === 409) return { accepted: true, already: true };
    if (resp.status === 401) return { accepted: false, auth: true, error: 'Unauthorized' };
    return { accepted: false, error: data?.error || 'Failed to accept SOS' };
  };

  const updateStatus = async ({ alertId, token, status }) => {
    const resp = await fetch(`${API_BASE}/sos-alerts/${alertId}/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return { ok: true, alert: data?.alert || null };
    if (resp.status === 401) return { ok: false, auth: true, error: 'Unauthorized' };
    return { ok: false, error: data?.error || 'Failed to update SOS' };
  };

  const handleAcknowledge = async (alert) => {
    await withProcessing(alert.id, async () => {
      const token = await getTokenOrLogout();
      if (!token) return;
      const accepted = await acceptIfNeeded({ alert, token });
      if (!accepted.accepted) throw new Error(accepted.error || 'Failed to accept SOS');

      // UI acknowledge only (server state remains accepted/acknowledged)
      setAlerts((prev) => prev.map((a) => (a.id === alert.id ? { ...a, status: 'acknowledged', backendStatus: 'acknowledged' } : a)));
      await loadAlerts();
    }).catch((e) => {
      const msg = String(e?.message || 'Failed');
      Alert.alert('Error', msg.includes('Network') ? `${msg}\n\nBackend: ${API_BASE}` : msg);
    });
  };

  const handleRespond = async (alert) => {
    await withProcessing(alert.id, async () => {
      const token = await getTokenOrLogout();
      if (!token) return;

      const accepted = await acceptIfNeeded({ alert, token });
      if (!accepted.accepted) throw new Error(accepted.error || 'Failed to accept SOS');

      // Mark in progress for better tracking
      const st = await updateStatus({ alertId: alert.id, token, status: 'in_progress' });
      if (!st.ok && !String(st?.error || '').includes('must be accepted')) {
        // Don't hard-fail navigation if status update fails; accepting is the critical part.
      }

      await loadAlerts();

      navigation.navigate('CaregiverInteraction', {
        requestId: alert.id,
        request: {
          id: alert.id,
          seniorName: alert.seniorName,
          message: alert.raw?.message || 'SOS Emergency',
          helpType: 'SOS',
          description: alert.raw?.message || 'SOS Emergency',
          senior: {
            id: alert.seniorId,
            name: alert.seniorName,
            phone: alert.phone,
            address: alert.location,
            medicalInfo: alert.medicalInfo,
          },
          raw: alert.raw,
        },
        seniorId: alert.seniorId,
      });
    }).catch((e) => {
      const msg = String(e?.message || 'Failed');
      Alert.alert('Error', msg.includes('Network') ? `${msg}\n\nBackend: ${API_BASE}` : msg);
    });
  };

  const handleEscalate = async (alert) => {
    await withProcessing(alert.id, async () => {
      const token = await getTokenOrLogout();
      if (!token) return;

      // Ensure it's accepted (required by backend to move to in_progress)
      const accepted = await acceptIfNeeded({ alert, token });
      if (!accepted.accepted) throw new Error(accepted.error || 'Failed to accept SOS');

      const resp = await fetch(`${API_BASE}/sos-alerts/${alert.id}/escalate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Escalated by Volunteer' }),
      });

      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to escalate SOS');
      }

      await loadAlerts();
      Alert.alert('Escalated', 'SOS Alert has been escalated to Admins.');
    }).catch((e) => {
      const msg = String(e?.message || 'Failed');
      Alert.alert('Error', msg.includes('Network') ? `${msg}\n\nBackend: ${API_BASE}` : msg);
    });
  };

  const handleCall = async (phone) => {
    const p = String(phone || '').trim();
    if (!p) {
      Alert.alert('Missing phone', 'Senior phone number is not available.');
      return;
    }
    const url = `tel:${p}`;
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.open(url, '_self');
      return;
    }
    try {
      const ok = await Linking.canOpenURL(url);
      if (!ok) {
        Alert.alert('Cannot call', `Please dial ${p} manually.`);
        return;
      }
      await Linking.openURL(url);
    } catch (e) {
      Alert.alert('Call failed', e?.message || `Please dial ${p} manually.`);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'active':
        return colors.accent.red;
      case 'pending':
        return colors.accent.orange;
      case 'acknowledged':
        return colors.primary.main;
      case 'escalated':
        return colors.secondary.green;
      default:
        return colors.neutral.gray;
    }
  };

  const getAlertIcon = (type) => {
    switch (type) {
      case 'SOS Emergency':
        return 'alert-octagon';
      case 'Wellness Check':
        return 'heart-pulse';
      case 'Low Mood Alert':
        return 'emoticon-sad';
      default:
        return 'alert-circle';
    }
  };

  const activeCount = alerts.filter(a => a.status === 'active' || a.status === 'acknowledged').length;

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
            color={colors.neutral.white}
          />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>SOS Alerts</Text>
        {activeCount > 0 && (
          <Animated.View
            style={[
              styles.activeBadge,
              { transform: [{ scale: pulseAnim }] }
            ]}
          >
            <Text style={styles.activeBadgeText}>{activeCount}</Text>
          </Animated.View>
        )}
      </View>

      {/* Alert Summary */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryNumber}>{alerts.filter(a => a.status === 'active').length}</Text>
          <Text style={styles.summaryLabel}>Active</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={styles.summaryNumber}>{alerts.filter(a => a.status === 'pending').length}</Text>
          <Text style={styles.summaryLabel}>Pending</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={styles.summaryNumber}>{alerts.filter(a => a.status === 'acknowledged').length}</Text>
          <Text style={styles.summaryLabel}>Acknowledged</Text>
        </View>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Active SOS Alerts */}
        {alerts.filter(a => a.status === 'active' || a.status === 'acknowledged').length > 0 && (
          <>
            <Text style={styles.sectionHeader}>⚠️ ACTIVE EMERGENCIES</Text>
            {alerts
              .filter(a => a.status === 'active' || a.status === 'acknowledged')
              .map(alert => (
                <Animated.View
                  key={alert.id}
                  style={[
                    styles.alertCard,
                    styles.activeAlertCard,
                    shadows.md,
                  ]}
                >
                  <View style={styles.alertHeader}>
                    <View style={[
                      styles.alertIconContainer,
                      { backgroundColor: getStatusColor(alert.status) }
                    ]}>
                      <MaterialCommunityIcons
                        name={getAlertIcon(alert.type)}
                        size={32}
                        color={colors.neutral.white}
                      />
                    </View>
                    <View style={styles.alertInfo}>
                      <Text style={styles.alertSeniorName}>{alert.seniorName}</Text>
                      <Text style={styles.alertType}>{alert.type}</Text>
                      <Text style={styles.alertTime}>{alert.time}</Text>
                    </View>
                    <TouchableOpacity
                      style={styles.callButton}
                      onPress={() => handleCall(alert.phone)}
                    >
                      <MaterialCommunityIcons
                        name="phone"
                        size={28}
                        color={colors.neutral.white}
                      />
                    </TouchableOpacity>
                  </View>

                  <View style={styles.alertDetails}>
                    <View style={styles.detailRow}>
                      <MaterialCommunityIcons
                        name="map-marker"
                        size={20}
                        color={colors.accent.red}
                      />
                      <Text style={styles.detailText}>{alert.location}</Text>
                    </View>
                    <View style={styles.detailRow}>
                      <MaterialCommunityIcons
                        name="medical-bag"
                        size={20}
                        color={colors.accent.red}
                      />
                      <Text style={styles.detailText}>{alert.medicalInfo}</Text>
                    </View>
                  </View>

                  <View style={styles.alertActions}>
                    {alert.status !== 'acknowledged' && (
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.acknowledgeBtn]}
                        disabled={processingIds.has(String(alert.id))}
                        onPress={() => handleAcknowledge(alert)}
                      >
                        <MaterialCommunityIcons
                          name="check"
                          size={20}
                          color={colors.neutral.white}
                        />
                        <Text style={styles.actionBtnText}>Acknowledge</Text>
                      </TouchableOpacity>
                    )}

                    <TouchableOpacity
                      style={[styles.actionBtn, styles.respondBtn]}
                      disabled={processingIds.has(String(alert.id))}
                      onPress={() => handleRespond(alert)}
                    >
                      <MaterialCommunityIcons
                        name="run-fast"
                        size={20}
                        color={colors.neutral.white}
                      />
                      <Text style={styles.actionBtnText}>Respond</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.actionBtn, styles.escalateBtn]}
                      disabled={processingIds.has(String(alert.id))}
                      onPress={() => handleEscalate(alert)}
                    >
                      <MaterialCommunityIcons
                        name="arrow-up"
                        size={20}
                        color={colors.accent.red}
                      />
                      <Text style={[styles.actionBtnText, styles.escalateBtnText]}>
                        Escalate
                      </Text>
                    </TouchableOpacity>
                  </View>
                </Animated.View>
              ))}
          </>
        )}

        {/* Other Alerts */}
        {alerts.filter(a => a.status !== 'active' && a.status !== 'acknowledged').length > 0 && (
          <>
            <Text style={styles.sectionHeader}>Other Alerts</Text>
            {alerts
              .filter(a => a.status !== 'active' && a.status !== 'acknowledged')
              .map(alert => (
                <View
                  key={alert.id}
                  style={[styles.alertCard, shadows.sm]}
                >
                  <View style={styles.alertHeader}>
                    <View style={[
                      styles.alertIconContainer,
                      { backgroundColor: getStatusColor(alert.status) }
                    ]}>
                      <MaterialCommunityIcons
                        name={getAlertIcon(alert.type)}
                        size={28}
                        color={colors.neutral.white}
                      />
                    </View>
                    <View style={styles.alertInfo}>
                      <Text style={styles.alertSeniorName}>{alert.seniorName}</Text>
                      <Text style={styles.alertType}>{alert.type}</Text>
                      <Text style={styles.alertTime}>{alert.time}</Text>
                    </View>
                    <View style={[
                      styles.statusIndicator,
                      { backgroundColor: getStatusColor(alert.status) }
                    ]}>
                      <Text style={styles.statusText}>
                        {alert.status.charAt(0).toUpperCase() + alert.status.slice(1)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.alertDetails}>
                    <View style={styles.detailRow}>
                      <MaterialCommunityIcons
                        name="map-marker"
                        size={18}
                        color={colors.neutral.darkGray}
                      />
                      <Text style={[styles.detailText, styles.detailTextMuted]}>
                        {alert.location}
                      </Text>
                    </View>
                  </View>

                  <TouchableOpacity
                    style={styles.viewDetailsBtn}
                    onPress={() => handleRespond(alert)}
                  >
                    <Text style={styles.viewDetailsText}>View Details</Text>
                    <MaterialCommunityIcons
                      name="chevron-right"
                      size={20}
                      color={colors.primary.main}
                    />
                  </TouchableOpacity>
                </View>
              ))}
          </>
        )}

        {/* Empty State */}
        {alerts.length === 0 && (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons
              name="check-circle"
              size={80}
              color={colors.secondary.green}
            />
            <Text style={styles.emptyTitle}>All Clear!</Text>
            <Text style={styles.emptySubtitle}>
              No active alerts at the moment
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.accent.red,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    backgroundColor: colors.accent.red,
  },
  backButton: {
    padding: spacing.sm,
  },
  headerTitle: {
    flex: 1,
    fontSize: typography.sizes.xl,
    fontWeight: typography.weights.bold,
    color: colors.neutral.white,
    marginLeft: spacing.sm,
  },
  activeBadge: {
    backgroundColor: colors.neutral.white,
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  activeBadgeText: {
    fontSize: typography.sizes.lg,
    fontWeight: typography.weights.bold,
    color: colors.accent.red,
  },
  summaryBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    justifyContent: 'space-around',
  },
  summaryItem: {
    alignItems: 'center',
  },
  summaryNumber: {
    fontSize: typography.sizes.xl,
    fontWeight: typography.weights.bold,
    color: colors.neutral.white,
  },
  summaryLabel: {
    fontSize: typography.sizes.sm,
    color: 'rgba(255,255,255,0.9)',
  },
  summaryDivider: {
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  scrollView: {
    flex: 1,
    backgroundColor: colors.neutral.lightGray,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
  },
  scrollContent: {
    padding: spacing.md,
    paddingBottom: spacing.xxl,
  },
  sectionHeader: {
    fontSize: typography.sizes.md,
    fontWeight: typography.weights.bold,
    color: colors.accent.red,
    marginBottom: spacing.md,
    marginTop: spacing.md,
  },
  alertCard: {
    backgroundColor: colors.neutral.white,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  activeAlertCard: {
    borderWidth: 2,
    borderColor: colors.accent.red,
  },
  alertHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  alertIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  alertInfo: {
    flex: 1,
    marginLeft: spacing.md,
  },
  alertSeniorName: {
    fontSize: typography.sizes.lg,
    fontWeight: typography.weights.bold,
    color: colors.neutral.black,
  },
  alertType: {
    fontSize: typography.sizes.md,
    color: colors.neutral.darkGray,
    marginTop: spacing.xs,
  },
  alertTime: {
    fontSize: typography.sizes.sm,
    color: colors.neutral.gray,
    marginTop: spacing.xs,
  },
  callButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.secondary.green,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusIndicator: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
  },
  statusText: {
    fontSize: typography.sizes.xs,
    fontWeight: typography.weights.semiBold,
    color: colors.neutral.white,
  },
  alertDetails: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.neutral.lightGray,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  detailText: {
    fontSize: typography.sizes.md,
    color: colors.neutral.black,
    marginLeft: spacing.sm,
    flex: 1,
  },
  detailTextMuted: {
    color: colors.neutral.darkGray,
  },
  alertActions: {
    flexDirection: 'row',
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
    gap: spacing.xs,
  },
  acknowledgeBtn: {
    backgroundColor: colors.primary.main,
  },
  respondBtn: {
    backgroundColor: colors.secondary.green,
  },
  escalateBtn: {
    backgroundColor: colors.neutral.white,
    borderWidth: 1,
    borderColor: colors.accent.red,
  },
  actionBtnText: {
    fontSize: typography.sizes.sm,
    fontWeight: typography.weights.semiBold,
    color: colors.neutral.white,
  },
  escalateBtnText: {
    color: colors.accent.red,
  },
  viewDetailsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.neutral.lightGray,
  },
  viewDetailsText: {
    fontSize: typography.sizes.md,
    color: colors.primary.main,
    fontWeight: typography.weights.medium,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl * 2,
  },
  emptyTitle: {
    fontSize: typography.sizes.xl,
    fontWeight: typography.weights.bold,
    color: colors.secondary.green,
    marginTop: spacing.lg,
  },
  emptySubtitle: {
    fontSize: typography.sizes.md,
    color: colors.neutral.darkGray,
    marginTop: spacing.sm,
  },
});

export default SOSAlertsScreen;
