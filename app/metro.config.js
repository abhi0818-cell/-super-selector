const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// By default Metro skips transpiling node_modules.
// @supabase/realtime-js (and its ws dependency) use private class fields (#field)
// that Hermes in Expo Go can't parse natively — force Babel to transpile them.
config.transformer.transformIgnorePatterns = [
  'node_modules/(?!(' + [
    'react-native',
    '@react-native',
    '@react-navigation',
    'expo',
    '@expo',
    '@supabase',
    'zustand',
    'react-native-url-polyfill',
    '@react-native-async-storage',
  ].join('|') + ')/)',
];

// Supabase v2 pulls in @opentelemetry/api for server-side tracing.
// It's not needed in React Native — stub it out so the bundler doesn't choke.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@opentelemetry/api') {
    return { type: 'empty' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
