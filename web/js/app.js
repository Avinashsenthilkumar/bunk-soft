import React, { useState } from 'react';
import {
  StatusBar, SafeAreaView, ScrollView, View, Text,
  TextInput, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';

/* ---------------- SAMPLE DATA (matches your database) ---------------- */
const MEMBERS = [
  { id: 'JKS-0101', name: 'Arjun Menon', plan: 'Yearly', status: 'active' },
  { id: 'JKS-0102', name: 'Priya Ramesh', plan: 'Half-Yearly', status: 'expiring' },
  { id: 'JKS-0103', name: 'Karthik Subramani', plan: 'Quarterly', status: 'expiring' },
  { id: 'JKS-0104', name: 'Deepa Nair', plan: 'Monthly', status: 'expired' },
  { id: 'JKS-0105', name: 'Vignesh Anand', plan: 'Yearly', status: 'active' },
  { id: 'JKS-0106', name: 'Sneha Iyer', plan: 'Half-Yearly', status: 'active' },
];

const STATUS = {
  active: { label: 'ACTIVE', bg: 'rgba(55,211,153,0.15)', fg: '#37D399' },
  expiring: { label: 'EXPIRING', bg: 'rgba(245,166,35,0.15)', fg: '#F5A623' },
  expired: { label: 'EXPIRED', bg: 'rgba(242,109,109,0.16)', fg: '#F26D6D' },
};

function initials(name) {
  return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

/* ================================================================= */
export default function App() {
  const [screen, setScreen] = useState('login'); // 'login' | 'app'
  const [tab, setTab] = useState('dashboard');

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#08080A" />
      {screen === 'login'
        ? <Login onLogin={() => setScreen('app')} />
        : <Home tab={tab} setTab={setTab} onLogout={() => setScreen('login')} />}
    </SafeAreaView>
  );
}

/* ---------------- LOGIN ---------------- */
function Login({ onLogin }) {
  return (
    <View style={styles.loginWrap}>
      <View style={styles.logoCircle}>
        <Text style={styles.logoText}>JKS</Text>
      </View>
      <Text style={styles.brand}>JKS <Text style={{ color: '#E7B64E' }}>POWER</Text> GYM</Text>
      <Text style={styles.tagline}>STRENGTH · DISCIPLINE · PROGRESS</Text>

      <Text style={styles.h1}>Welcome back, Coach.</Text>

      <Text style={styles.label}>EMAIL</Text>
      <TextInput
        style={styles.input}
        defaultValue="admin@jkspowergym.in"
        placeholderTextColor="#6C6C78"
        autoCapitalize="none"
      />

      <Text style={styles.label}>PASSWORD</Text>
      <TextInput
        style={styles.input}
        defaultValue="powergym"
        secureTextEntry
        placeholderTextColor="#6C6C78"
      />

      <TouchableOpacity style={styles.primaryBtn} onPress={onLogin} activeOpacity={0.85}>
        <Text style={styles.primaryBtnText}>Sign in</Text>
      </TouchableOpacity>
      <Text style={styles.demoNote}>Demo build · tap Sign in</Text>
    </View>
  );
}

/* ---------------- HOME (dashboard + members) ---------------- */
function Home({ tab, setTab, onLogout }) {
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <View>
          <Text style={styles.greetSmall}>Good morning</Text>
          <Text style={styles.greetBig}>JKS Power Gym</Text>
        </View>
        <TouchableOpacity style={styles.headerIcon} onPress={onLogout}>
          <Text style={{ color: '#E7B64E', fontWeight: '700', fontSize: 12 }}>Exit</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 90 }} showsVerticalScrollIndicator={false}>
        {tab === 'dashboard' ? <Dashboard /> : <Members />}
      </ScrollView>

      <View style={styles.nav}>
        <NavBtn label="Dashboard" active={tab === 'dashboard'} onPress={() => setTab('dashboard')} />
        <NavBtn label="Members" active={tab === 'members'} onPress={() => setTab('members')} />
      </View>
    </View>
  );
}

function Dashboard() {
  return (
    <View style={{ paddingHorizontal: 18 }}>
      <View style={styles.hero}>
        <Text style={styles.heroLabel}>TODAY'S COLLECTION</Text>
        <Text style={styles.heroBig}>₹18,400</Text>
        <Text style={styles.heroSub}>▲ 12% vs yesterday · 9 payments</Text>
      </View>

      <View style={styles.statGrid}>
        <Stat num="248" label="Total Members" fg="#E7B64E" />
        <Stat num="191" label="Active" fg="#37D399" />
        <Stat num="14" label="Expiring Soon" fg="#F5A623" />
        <Stat num="43" label="Expired" fg="#F26D6D" />
      </View>

      <Text style={styles.sectionH}>MONTHLY REVENUE</Text>
      <View style={styles.card}>
        <Text style={styles.revBig}>₹3.42L</Text>
        <Text style={styles.revSub}>Aug 2026 · +7% from July</Text>
        <View style={styles.barRow}>
          {[40, 52, 48, 66, 72, 90].map((h, i) => (
            <View key={i} style={[styles.bar, { height: h }]} />
          ))}
        </View>
        <View style={styles.barLabels}>
          {['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'].map((m) => (
            <Text key={m} style={styles.barLabel}>{m}</Text>
          ))}
        </View>
      </View>

      <Text style={styles.sectionH}>UPCOMING RENEWALS</Text>
      {MEMBERS.filter((m) => m.status === 'expiring').map((m) => (
        <MemberRow key={m.id} m={m} />
      ))}
    </View>
  );
}

function Members() {
  return (
    <View style={{ paddingHorizontal: 18 }}>
      <Text style={[styles.sectionH, { marginTop: 8 }]}>ALL MEMBERS · {MEMBERS.length}</Text>
      {MEMBERS.map((m) => <MemberRow key={m.id} m={m} />)}
    </View>
  );
}

/* ---------------- small pieces ---------------- */
function Stat({ num, label, fg }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statNum, { color: fg }]}>{num}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function MemberRow({ m }) {
  const s = STATUS[m.status];
  return (
    <View style={styles.row}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initials(m.name)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName}>{m.name}</Text>
        <Text style={styles.rowMeta}>{m.id} · {m.plan}</Text>
      </View>
      <View style={[styles.pill, { backgroundColor: s.bg }]}>
        <Text style={[styles.pillText, { color: s.fg }]}>{s.label}</Text>
      </View>
    </View>
  );
}

function NavBtn({ label, active, onPress }) {
  return (
    <TouchableOpacity style={styles.navBtn} onPress={onPress}>
      <Text style={[styles.navText, active && { color: '#E7B64E' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/* ---------------- styles ---------------- */
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#08080A', paddingTop: Platform.OS === 'android' ? 28 : 0 },

  /* login */
  loginWrap: { flex: 1, paddingHorizontal: 26, justifyContent: 'center' },
  logoCircle: {
    width: 84, height: 84, borderRadius: 42, alignSelf: 'center',
    backgroundColor: '#E7B64E', alignItems: 'center', justifyContent: 'center',
  },
  logoText: { color: '#1A1508', fontSize: 26, fontWeight: '800', letterSpacing: 1 },
  brand: { color: '#F5F6F8', fontSize: 24, fontWeight: '800', letterSpacing: 3, textAlign: 'center', marginTop: 18 },
  tagline: { color: '#6C6C78', fontSize: 10, letterSpacing: 2, textAlign: 'center', marginTop: 8 },
  h1: { color: '#F5F6F8', fontSize: 22, fontWeight: '700', marginTop: 34, marginBottom: 20 },
  label: { color: '#6C6C78', fontSize: 11, letterSpacing: 1.5, fontWeight: '700', marginBottom: 8, marginTop: 6 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.05)', borderColor: 'rgba(255,255,255,0.09)', borderWidth: 1,
    borderRadius: 14, paddingHorizontal: 15, paddingVertical: 14, color: '#F5F6F8', fontSize: 15,
  },
  primaryBtn: { backgroundColor: '#E7B64E', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 26 },
  primaryBtnText: { color: '#1A1508', fontWeight: '800', fontSize: 15, letterSpacing: 0.3 },
  demoNote: { color: '#6C6C78', fontSize: 12, textAlign: 'center', marginTop: 18 },

  /* header */
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 },
  greetSmall: { color: '#9C9CA8', fontSize: 12 },
  greetBig: { color: '#F5F6F8', fontSize: 20, fontWeight: '800', letterSpacing: 0.5, marginTop: 2 },
  headerIcon: {
    width: 54, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderColor: 'rgba(255,255,255,0.09)', borderWidth: 1,
  },

  /* hero */
  hero: {
    backgroundColor: '#1B160B', borderColor: 'rgba(231,182,78,0.25)', borderWidth: 1,
    borderRadius: 22, padding: 20, marginTop: 6,
  },
  heroLabel: { color: '#E7B64E', fontSize: 11, letterSpacing: 2, fontWeight: '700' },
  heroBig: { color: '#F5F6F8', fontSize: 38, fontWeight: '800', letterSpacing: 1, marginTop: 8 },
  heroSub: { color: '#9C9CA8', fontSize: 12.5, marginTop: 8 },

  /* stat grid */
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 12 },
  stat: {
    width: '48.5%', backgroundColor: 'rgba(255,255,255,0.045)', borderColor: 'rgba(255,255,255,0.075)',
    borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 12,
  },
  statNum: { fontSize: 26, fontWeight: '800' },
  statLabel: { color: '#9C9CA8', fontSize: 12, marginTop: 5 },

  /* card + chart */
  sectionH: { color: '#F5F6F8', fontSize: 13, fontWeight: '800', letterSpacing: 1.2, marginTop: 20, marginBottom: 12 },
  card: {
    backgroundColor: 'rgba(255,255,255,0.045)', borderColor: 'rgba(255,255,255,0.075)', borderWidth: 1,
    borderRadius: 20, padding: 18,
  },
  revBig: { color: '#E7B64E', fontSize: 28, fontWeight: '800' },
  revSub: { color: '#9C9CA8', fontSize: 12, marginTop: 4 },
  barRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 96, marginTop: 18 },
  bar: { width: '13%', backgroundColor: '#E7B64E', borderRadius: 6, opacity: 0.9 },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  barLabel: { color: '#6C6C78', fontSize: 10, width: '13%', textAlign: 'center' },

  /* member row */
  row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.045)',
    borderColor: 'rgba(255,255,255,0.075)', borderWidth: 1, borderRadius: 16, padding: 13, marginBottom: 10,
  },
  avatar: {
    width: 46, height: 46, borderRadius: 14, backgroundColor: '#E7B64E',
    alignItems: 'center', justifyContent: 'center', marginRight: 13,
  },
  avatarText: { color: '#1A1508', fontWeight: '800', fontSize: 16 },
  rowName: { color: '#F5F6F8', fontSize: 15, fontWeight: '700' },
  rowMeta: { color: '#6C6C78', fontSize: 12, marginTop: 3 },
  pill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20 },
  pillText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },

  /* bottom nav */
  nav: {
    flexDirection: 'row', borderTopColor: 'rgba(255,255,255,0.09)', borderTopWidth: 1,
    backgroundColor: '#0A0A0C', paddingVertical: 14,
  },
  navBtn: { flex: 1, alignItems: 'center' },
  navText: { color: '#6C6C78', fontSize: 13, fontWeight: '700' },
});
