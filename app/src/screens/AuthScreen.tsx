/**
 * AuthScreen — gradient-first redesign (Pass 1)
 * Requires: expo-linear-gradient  →  npx expo install expo-linear-gradient
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '../store/authStore';
import { fontSize, radius, spacing } from '../theme';

type Mode = 'login' | 'register';

// ─── Gradient palette ─────────────────────────────────────────────────────────

const G = {
  bg:    ['#F5F0E0', '#EDE8D5', '#E8E2CE'] as const,
  dot:   ['#C9A84C', '#92650A'] as const,
  btn:   ['#1C1F26', '#2A2E38', '#3E4451'] as const,
  card:  ['rgba(201,168,76,0.1)', 'rgba(255,255,255,0.92)'] as const,
  tabOn: ['#1C1F26', '#2A2E38'] as const,
} as const;

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  good:    '#2D6A35',
  bad:     '#C0392B',
  border:  'rgba(201,168,76,0.3)',
  surface: 'rgba(0,0,0,0.04)',
} as const;

export default function AuthScreen() {
  const { signIn, signUp, loading } = useAuthStore();

  const [mode, setMode]       = useState<Mode>('login');
  const [email, setEmail]     = useState('');
  const [password, setPass]   = useState('');
  const [error, setError]     = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setSuccess(null);

    if (!email.trim() || !password.trim()) {
      setError('Please enter your email and password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    if (mode === 'login') {
      const err = await signIn(email.trim(), password);
      if (err) setError(err);
    } else {
      const err = await signUp(email.trim(), password);
      if (err) {
        setError(err);
      } else {
        setSuccess('Account created! You can now sign in.');
        setMode('login');
        setPass('');
      }
    }
  };

  return (
    <View style={styles.root}>
      {/* Full-screen gradient background */}
      <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />

      {/* Subtle radial glow behind the card area */}
      <View style={styles.glowBlob} pointerEvents="none" />

      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.kav}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            {/* ── Brand ───────────────────────────────────────────────────── */}
            <View style={styles.brand}>
              <LinearGradient colors={G.dot} style={styles.dotGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
                <View style={styles.dotInner} />
              </LinearGradient>
              <View style={styles.brandWords}>
                <Text style={styles.brandSuper}>Super</Text>
                <Text style={styles.brandSelector}>Selector</Text>
              </View>
            </View>
            <Text style={styles.tagline}>Fantasy Cricket · IPL 2026</Text>

            {/* ── Card ────────────────────────────────────────────────────── */}
            <LinearGradient
              colors={G.card}
              style={styles.card}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
            >
              {/* Mode toggle */}
              <View style={styles.modeRow}>
                {(['login', 'register'] as Mode[]).map(m => (
                  m === mode ? (
                    <LinearGradient key={m} colors={G.tabOn} style={styles.modeBtn} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                      <Text style={[styles.modeBtnText, styles.modeBtnTextActive]}>
                        {m === 'login' ? 'Sign In' : 'Register'}
                      </Text>
                    </LinearGradient>
                  ) : (
                    <Pressable
                      key={m}
                      style={styles.modeBtn}
                      onPress={() => { setMode(m); setError(null); setSuccess(null); }}
                    >
                      <Text style={styles.modeBtnText}>
                        {m === 'login' ? 'Sign In' : 'Register'}
                      </Text>
                    </Pressable>
                  )
                ))}
              </View>

              {/* Fields */}
              <View style={styles.fields}>
                <View style={styles.field}>
                  <Text style={styles.label}>Email</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="you@example.com"
                    placeholderTextColor={C.muted}
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                  />
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Password</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Min. 6 characters"
                    placeholderTextColor={C.muted}
                    value={password}
                    onChangeText={setPass}
                    secureTextEntry
                    autoCapitalize="none"
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  />
                </View>
              </View>

              {/* Error / success */}
              {error && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorIcon}>⚠</Text>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}
              {success && (
                <View style={styles.successBox}>
                  <Text style={styles.successIcon}>✓</Text>
                  <Text style={styles.successText}>{success}</Text>
                </View>
              )}

              {/* Submit */}
              <Pressable
                onPress={handleSubmit}
                disabled={loading}
                style={({ pressed }) => [styles.submitWrap, pressed && styles.submitPressed]}
              >
                <LinearGradient
                  colors={G.btn}
                  style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                >
                  {loading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.submitBtnText}>
                      {mode === 'login' ? 'Sign In  →' : 'Create Account  →'}
                    </Text>
                  )}
                </LinearGradient>
              </Pressable>
            </LinearGradient>

            {/* Footer */}
            <Text style={styles.footer}>
              {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
              <Text
                style={styles.footerLink}
                onPress={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); setSuccess(null); }}
              >
                {mode === 'login' ? 'Register' : 'Sign In'}
              </Text>
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F5F0E0',
  },
  safe: {
    flex: 1,
  },
  kav: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },

  // Glow blob behind card
  glowBlob: {
    position:        'absolute',
    width:           340,
    height:          340,
    borderRadius:    170,
    backgroundColor: 'rgba(201,168,76,0.12)',
    alignSelf:       'center',
    top:             '28%',
  },

  // Brand
  brand: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            spacing.sm,
    marginBottom:   spacing.xs,
  },
  dotGrad: {
    width:        18,
    height:       18,
    borderRadius: 9,
    alignItems:   'center',
    justifyContent: 'center',
    shadowColor:  '#C9A84C',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 10,
  },
  dotInner: {
    width:           7,
    height:          7,
    borderRadius:    4,
    backgroundColor: 'rgba(255,255,255,0.8)',
  },
  brandWords: {
    flexDirection: 'row',
    gap:           5,
  },
  brandSuper: {
    color:       '#1C1F26',
    fontSize:    fontSize.xxl + 2,
    fontWeight:  '800',
    letterSpacing: 0.2,
  },
  brandSelector: {
    color:       '#C9A84C',
    fontSize:    fontSize.xxl + 2,
    fontWeight:  '800',
    letterSpacing: 0.2,
  },
  tagline: {
    color:         'rgba(122,112,96,0.9)',
    fontSize:      fontSize.sm,
    textAlign:     'center',
    marginBottom:  spacing.xxl + spacing.lg,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },

  // Card
  card: {
    borderWidth:   1,
    borderColor:   'rgba(201,168,76,0.3)',
    borderRadius:  radius.xl + 4,
    padding:       spacing.xl,
    gap:           spacing.lg,
    overflow:      'hidden',
  },

  // Mode toggle
  modeRow: {
    flexDirection:  'row',
    backgroundColor: 'rgba(0,0,0,0.04)',
    borderRadius:   radius.md,
    padding:        3,
    gap:            3,
  },
  modeBtn: {
    flex:            1,
    paddingVertical: spacing.sm,
    alignItems:      'center',
    borderRadius:    radius.sm,
  },
  modeBtnText: {
    color:      C.muted,
    fontSize:   fontSize.base,
    fontWeight: '600',
  },
  modeBtnTextActive: {
    color: '#fff',
  },

  // Fields
  fields: {
    gap: spacing.md,
  },
  field: {
    gap: spacing.xs,
  },
  label: {
    color:         C.muted,
    fontSize:      fontSize.xs + 1,
    fontWeight:    '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  input: {
    backgroundColor: 'rgba(0,0,0,0.04)',
    borderWidth:     1,
    borderColor:     'rgba(201,168,76,0.3)',
    borderRadius:    radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm + 2,
    color:           C.text,
    fontSize:        fontSize.base,
  },

  // Error / success
  errorBox: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.sm,
    backgroundColor: 'rgba(192,57,43,0.08)',
    borderLeftWidth: 3,
    borderLeftColor: C.bad,
    borderRadius:    radius.sm,
    padding:         spacing.md,
  },
  errorIcon: { fontSize: 14, color: C.bad },
  errorText: { color: C.bad, fontSize: fontSize.sm, flex: 1 },
  successBox: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.sm,
    backgroundColor: 'rgba(45,106,53,0.08)',
    borderLeftWidth: 3,
    borderLeftColor: C.good,
    borderRadius:    radius.sm,
    padding:         spacing.md,
  },
  successIcon: { fontSize: 14, color: C.good },
  successText: { color: C.good, fontSize: fontSize.sm, flex: 1 },

  // Submit
  submitWrap: {},
  submitPressed: { opacity: 0.85 },
  submitBtn: {
    borderRadius:    radius.md,
    paddingVertical: spacing.md,
    alignItems:      'center',
    justifyContent:  'center',
    minHeight:       50,
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  submitBtnText: {
    color:       '#fff',
    fontSize:    fontSize.base,
    fontWeight:  '700',
    letterSpacing: 0.4,
  },

  // Footer
  footer: {
    color:     C.muted,
    fontSize:  fontSize.sm,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  footerLink: {
    color:      C.accent,
    fontWeight: '700',
  },
});
