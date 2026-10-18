import React, { useState, useEffect } from 'react';
import { StatusBar, LogBox, View, Text, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import './src/i18n'; // Initialize i18n

import { AuthNavigator, ElderlyNavigator, CaregiverNavigator, AdminNavigator, NGONavigator, SuperAdminNavigator } from './src/navigation';
import { SplashScreen } from './src/screens/auth';
import { subscribeToAuthChanges, checkAuth, logout } from './src/services/authService';
import { ChatProvider } from './src/context/ChatContext';
import { registerPushToken, getSocket, identify } from './src/services/socketService';

import { colors } from './src/theme';

LogBox.ignoreLogs([
  'Non-serializable values were found in the navigation state',
  'AsyncStorage has been extracted from react-native core',
]);

const RootStack = createNativeStackNavigator();

const App = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userRole, setUserRole] = useState(null);
  const [isFirstTime, setIsFirstTime] = useState(true);

  useEffect(() => {
    async function checkInitialAuth() {
      try {
        const { isAuthenticated: authStatus, userRole: role } = await checkAuth();
        setIsAuthenticated(authStatus);
        setUserRole(role);

        const firstTime = await AsyncStorage.getItem('isFirstTime');
        setIsFirstTime(firstTime === null);
      } catch (e) {
        console.warn('Error checking auth:', e);
      }
    }

    checkInitialAuth();

    const unsubscribeAuth = subscribeToAuthChanges((authStatus, role) => {
      setIsAuthenticated(authStatus);
      setUserRole(role);
    });

    return () => {
      unsubscribeAuth();
    };
  }, []);

  // After auth state is known, register push token and identify socket role
  useEffect(() => {
    (async () => {
      try {
        if (isAuthenticated && userRole) {
          await registerPushToken();
          // Optionally pre-identify; most screens identify as needed
          try {
            const profileJson = await AsyncStorage.getItem('userProfile');
            const profile = profileJson ? JSON.parse(profileJson) : null;
            const userId = profile?.id || profile?.uid || profile?.userId;
            if (userId) identify({ userId, role: userRole.toUpperCase() });
          } catch { }
        }
      } catch { }
    })();
  }, [isAuthenticated, userRole]);

  return (
    <ChatProvider>
      <View style={styles.outerContainer}>
        <View style={styles.webContainer}>
          <StatusBar
            barStyle="dark-content"
            backgroundColor={colors.neutral.white}
          />
          <NavigationContainer>
            <RootStack.Navigator
              initialRouteName="Auth"
              screenOptions={{
                headerShown: false,
                animation: 'fade',
              }}
            >
              <RootStack.Screen name="Splash" component={SplashScreen} />

              <RootStack.Screen
                name="Auth"
                component={AuthNavigator}
                initialParams={{ screen: 'Login' }}
              />

              {/* Dashboard routes */}
              <RootStack.Screen name="AdminApp" component={AdminNavigator} />
              <RootStack.Screen name="SuperAdminApp" component={SuperAdminNavigator} />
              <RootStack.Screen name="CaregiverApp" component={CaregiverNavigator} />
              <RootStack.Screen name="ElderlyApp" component={ElderlyNavigator} />
              <RootStack.Screen name="NGOApp" component={NGONavigator} />
            </RootStack.Navigator>
          </NavigationContainer>
        </View>
      </View>
    </ChatProvider>
  );
};

const styles = StyleSheet.create({
  outerContainer: {
    flex: 1,
    backgroundColor: '#F1F5F9',
    ...(Platform.OS === 'web'
      ? {
          width: '100%',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
        }
      : {}),
  },
  webContainer: {
    flex: 1,
    width: '100%',
    ...(Platform.OS === 'web'
      ? {
          maxWidth: 820,
          minHeight: '100vh',
          boxShadow: '0 8px 30px rgba(0, 0, 0, 0.08)',
          backgroundColor: colors.neutral.white,
        }
      : {}),
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.neutral.white,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 18,
    color: colors.primary.main,
    fontWeight: '500',
  },
});

export default App;
