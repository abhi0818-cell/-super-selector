import 'react-native-url-polyfill/auto';
import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts, PlayfairDisplay_700Bold } from '@expo-google-fonts/playfair-display';
import { supabase }           from './src/lib/supabase';
import { useAuthStore }       from './src/store/authStore';
import { useLeaderboardStore } from './src/store/leaderboardStore';
import RootNavigator          from './src/navigation/RootNavigator';
import AuthScreen             from './src/screens/AuthScreen';
import { colors }             from './src/theme';

export default function App() {
  const { session, setSession, setInitialized, initialized } = useAuthStore();
  const setCurrentUser = useLeaderboardStore(s => s.setCurrentUser);
  const [fontsLoaded] = useFonts({ PlayfairDisplay_700Bold });

  useEffect(() => {
    // Restore existing session on launch
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setInitialized();
      if (session?.user) setCurrentUser(session.user.id);
    });

    // Listen for auth changes (sign in, sign out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
        if (session?.user) {
          setCurrentUser(session.user.id);
        } else {
          setCurrentUser(null);
        }
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  // Spinner while session check or font load completes
  if (!initialized || !fontsLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" backgroundColor={colors.bg} />
      {session ? (
        // RootNavigator handles tournament selection → tab nav
        <NavigationContainer>
          <View style={styles.container}>
            <RootNavigator />
          </View>
        </NavigationContainer>
      ) : (
        <AuthScreen />
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    flex:            1,
    backgroundColor: colors.bg,
    alignItems:      'center',
    justifyContent:  'center',
  },
});
