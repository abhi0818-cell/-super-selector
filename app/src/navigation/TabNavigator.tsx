import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import { RootTabParamList } from '../types';
import HomeScreen from '../screens/HomeScreen';
import MyXIScreen from '../screens/MyXIScreen';
import LeaderboardScreen from '../screens/LeaderboardScreen';
import RulesScreen        from '../screens/RulesScreen';
import { colors, fontSize } from '../theme';
import { useTeamStore } from '../store/teamStore';

const Tab = createBottomTabNavigator<RootTabParamList>();

function TabIcon({ icon, focused }: { icon: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{icon}</Text>;
}

export default function TabNavigator() {
  const { selected, validation } = useTeamStore();

  return (
    <Tab.Navigator
      initialRouteName="Home"
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#F5F0E0',
          borderTopColor:  '#D6CFA8',
          borderTopWidth:  1,
          height:          64,
          paddingBottom:   8,
          paddingTop:      6,
        },
        tabBarActiveTintColor:   '#C9A84C',
        tabBarInactiveTintColor: '#7A7060',
        tabBarLabelStyle: {
          fontSize:      fontSize.xs,
          fontWeight:    '600',
          letterSpacing: 0.3,
          textTransform: 'uppercase',
          marginTop:     2,
        },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarLabel: 'Home',
          tabBarIcon:  ({ focused }) => <TabIcon icon="🏠" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="MyXI"
        component={MyXIScreen}
        options={{
          tabBarLabel:      'My XI',
          tabBarIcon:       ({ focused }) => <TabIcon icon="📋" focused={focused} />,
          tabBarBadge:      selected.length > 0 ? selected.length : undefined,
          tabBarBadgeStyle: {
            backgroundColor: validation.valid ? colors.good : colors.accent,
            color:           '#1C1F26',
            fontSize:        10,
            fontWeight:      '700',
          },
        }}
      />
      <Tab.Screen
        name="Leaderboard"
        component={LeaderboardScreen}
        options={{
          tabBarLabel: 'Leaderboard',
          tabBarIcon:  ({ focused }) => <TabIcon icon="🏆" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Rules"
        component={RulesScreen}
        options={{
          tabBarLabel: 'Rules',
          tabBarIcon:  ({ focused }) => <TabIcon icon="📖" focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}
