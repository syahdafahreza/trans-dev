import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { FilesScreen } from './src/screens/FilesScreen';
import { ServerScreen } from './src/screens/ServerScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { LocalHost } from './src/server/localHost';
import { colors, spacing } from './src/theme';
import type { HostSnapshot } from './src/types';

type Tab = 'server' | 'files' | 'settings';

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'server', label: 'Server', glyph: '◉' },
  { id: 'files', label: 'Files', glyph: '▤' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
];

export default function App() {
  const hostRef = useRef<LocalHost | null>(null);
  if (!hostRef.current) hostRef.current = new LocalHost({ deviceName: 'My phone' });
  const host = hostRef.current;

  const [tab, setTab] = useState<Tab>('server');
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [snapshot, setSnapshot] = useState<HostSnapshot>({
    running: host.isRunning,
    ip: host.ip,
    port: host.port,
    pin: host.pairing.pin,
    deviceName: host.deviceName,
    connections: 0,
    sessions: host.pairing.list(),
    lastError: null,
    storage: { total: null, free: null, used: null, sharedBytes: 0 },
  });

  const refresh = useCallback(async () => {
    const storage = await host.storage();
    setSnapshot({
      running: host.isRunning,
      ip: host.ip,
      port: host.port,
      pin: host.pairing.pin,
      deviceName: host.deviceName,
      connections: host.connectionCount,
      sessions: host.pairing.list(),
      lastError: host.lastError,
      storage,
    });
  }, [host]);

  useEffect(() => {
    void refresh();
    const unsubscribe = host.onChange(() => {
      void refresh();
    });
    return unsubscribe;
  }, [host, refresh]);

  useEffect(() => {
    if (tab === 'files') setRefreshKey((key) => key + 1);
  }, [tab]);

  const toggleServer = useCallback(async () => {
    setBusy(true);
    try {
      await host.toggle();
      await refresh();
      if (host.isRunning) {
        Alert.alert('Server running', `Open ${host.pairingUrl.replace(/\?.*$/, '')} on a computer connected to the same Wi-Fi.`);
      }
    } catch (error) {
      Alert.alert(
        'Could not start the server',
        `${error instanceof Error ? error.message : String(error)}\n\nMake sure the app has local network permission and port ${host.port} is free.`,
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [host, refresh]);

  const rotatePin = useCallback(async () => {
    host.pairing.rotatePin();
    await refresh();
    Alert.alert('New PIN', 'Computers that were already paired stay connected.');
  }, [host, refresh]);

  const rename = useCallback(
    async (name: string) => {
      host.deviceName = name;
      await refresh();
    },
    [host, refresh],
  );

  const revoke = useCallback(
    async (id: string) => {
      host.pairing.revokeById(id);
      await refresh();
    },
    [host, refresh],
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
      <View style={styles.header}>
        <View style={styles.brand}>
          <View style={styles.mark}>
            <Text style={styles.markGlyph}>⚡</Text>
          </View>
          <View>
            <Text style={styles.brandName}>TransDev</Text>
            <Text style={styles.brandMeta}>{snapshot.running ? 'Sharing over Wi-Fi' : 'Not sharing'}</Text>
          </View>
        </View>
        <View style={[styles.statusPill, { backgroundColor: snapshot.running ? colors.successSoft : colors.surfaceAlt }]}>
          <View style={[styles.statusDot, { backgroundColor: snapshot.running ? '#12b76a' : colors.mutedLight }]} />
          <Text style={[styles.statusLabel, { color: snapshot.running ? '#067a5b' : colors.muted }]}>
            {snapshot.running ? 'Online' : 'Offline'}
          </Text>
        </View>
      </View>

      <View style={styles.body}>
        {tab === 'server' && (
          <ServerScreen
            host={host}
            snapshot={snapshot}
            busy={busy}
            onToggle={() => void toggleServer()}
            onRotatePin={() => void rotatePin()}
            onRevoke={(id) => void revoke(id)}
          />
        )}
        {tab === 'files' && <FilesScreen host={host} storage={snapshot.storage} refreshKey={refreshKey} />}
        {tab === 'settings' && (
          <SettingsScreen
            snapshot={snapshot}
            onRename={(name) => void rename(name)}
            onRotatePin={() => void rotatePin()}
            onOpenSessions={() => setTab('server')}
          />
        )}
      </View>

      <View style={styles.tabbar}>
        {TABS.map((item) => {
          const active = tab === item.id;
          return (
            <Pressable
              key={item.id}
              onPress={() => setTab(item.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={styles.tab}
            >
              <Text style={[styles.tabGlyph, active && styles.tabGlyphActive]}>{item.glyph}</Text>
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(2.5),
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2.5),
  },
  mark: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markGlyph: {
    fontSize: 16,
    color: '#fff',
  },
  brandName: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.3,
    color: colors.text,
  },
  brandMeta: {
    fontSize: 11.5,
    color: colors.muted,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(1.5),
    paddingHorizontal: spacing(2.5),
    paddingVertical: spacing(1.5),
    borderRadius: 999,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusLabel: {
    fontSize: 11.5,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  body: {
    flex: 1,
  },
  tabbar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingTop: spacing(1.5),
    paddingBottom: spacing(2),
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  tabGlyph: {
    fontSize: 17,
    color: colors.mutedLight,
  },
  tabGlyphActive: {
    color: colors.accent,
  },
  tabLabel: {
    fontSize: 10.5,
    fontWeight: '600',
    letterSpacing: 0.2,
    color: colors.mutedLight,
  },
  tabLabelActive: {
    color: colors.accentStrong,
  },
});
