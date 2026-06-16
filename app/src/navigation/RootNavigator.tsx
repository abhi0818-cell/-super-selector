/**
 * RootNavigator
 *
 * Top-level stack (outside the tab bar):
 *   TournamentLobby → Main (TabNavigator)
 *
 * On sign-in we load tournaments, then:
 *   • 1 active tournament  → auto-select it, skip lobby, go straight to Main
 *   • 2+ active tournaments → show TournamentLobby so user can choose
 *   • 0 active tournaments  → show TournamentLobby with "no active tournaments" state
 *
 * The user can always navigate back to the lobby via the Home screen header.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { createStackNavigator } from '@react-navigation/stack';
import { RootStackParamList } from '../types';
import TournamentLobbyScreen from '../screens/TournamentLobbyScreen';
import TabNavigator           from './TabNavigator';
import { useTournamentStore } from '../store/tournamentStore';
import { useTeamStore }       from '../store/teamStore';
import { useContestStore }    from '../store/contestStore';
import { colors }             from '../theme';

const Stack = createStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  const [resolving, setResolving] = useState(true);
  const [initialRoute, setInitialRoute] =
    useState<keyof RootStackParamList>('TournamentLobby');

  const { loadTournaments, tournaments, selectedTournamentId, selectTournament } =
    useTournamentStore();
  const loadTournamentContext = useTeamStore(s => s.loadTournamentContext);
  const loadContests          = useContestStore(s => s.loadContests);

  useEffect(() => {
    (async () => {
      await loadTournaments();

      const { tournaments: loaded, selectedTournamentId: storedId } =
        useTournamentStore.getState();

      let resolvedId = storedId;

      // Auto-select if exactly one active tournament
      if (!resolvedId && loaded.length === 1) {
        await selectTournament(loaded[0].id);
        resolvedId = loaded[0].id;
      }

      if (resolvedId) {
        // Pre-load team + contests so Main tabs are ready immediately
        await loadTournamentContext();
        const { tournamentId } = useTeamStore.getState();
        if (tournamentId) await loadContests(tournamentId);
        setInitialRoute('Main');
      } else {
        setInitialRoute('TournamentLobby');
      }

      setResolving(false);
    })();
  }, []);

  if (resolving) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <Stack.Navigator
      initialRouteName={initialRoute}
      screenOptions={{ headerShown: false, animationEnabled: true }}
    >
      <Stack.Screen name="TournamentLobby" component={TournamentLobbyScreen} />
      <Stack.Screen name="Main"            component={TabNavigator} />
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex:            1,
    backgroundColor: colors.bg,
    alignItems:      'center',
    justifyContent:  'center',
  },
});
