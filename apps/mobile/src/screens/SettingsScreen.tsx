import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Badge, Button, Card, SectionLabel } from '../components/ui';
import type { HostSnapshot } from '../types';
import { colors, radius, spacing } from '../theme';

interface SettingsScreenProps {
  snapshot: HostSnapshot;
  onRename: (name: string) => void;
  onRotatePin: () => void;
  onOpenSessions: () => void;
}

export function SettingsScreen({ snapshot, onRename, onRotatePin, onOpenSessions }: SettingsScreenProps) {
  const [name, setName] = useState(snapshot.deviceName);

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <SectionLabel>Device</SectionLabel>
      <Card style={styles.card}>
        <Text style={styles.label}>Name shown on the computer</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="My phone"
          placeholderTextColor={colors.mutedLight}
          style={styles.input}
          autoCapitalize="words"
          returnKeyType="done"
        />
        <Button
          label="Save name"
          variant="secondary"
          onPress={() => onRename(name.trim() || 'My phone')}
          disabled={!name.trim() || name.trim() === snapshot.deviceName}
        />
      </Card>

      <SectionLabel>Connection</SectionLabel>
      <Card style={styles.card}>
        <View style={styles.row}>
          <View>
            <Text style={styles.rowTitle}>Address</Text>
            <Text style={styles.rowMeta}>Assigned by your Wi-Fi network</Text>
          </View>
          <Text style={styles.rowValue}>
            {snapshot.ip}:{snapshot.port}
          </Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <View>
            <Text style={styles.rowTitle}>Server</Text>
            <Text style={styles.rowMeta}>{snapshot.connections} open connections</Text>
          </View>
          <Badge label={snapshot.running ? 'Running' : 'Stopped'} tone={snapshot.running ? 'success' : 'neutral'} />
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>Verification PIN</Text>
            <Text style={styles.rowMeta}>Rotate if someone else can see this screen</Text>
          </View>
          <Text style={styles.pin}>{snapshot.pin}</Text>
        </View>
        <Button label="Generate a new PIN" variant="secondary" onPress={onRotatePin} style={{ marginTop: spacing(3) }} />
      </Card>

      <SectionLabel>Access</SectionLabel>
      <Card style={styles.card}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>Paired devices</Text>
            <Text style={styles.rowMeta}>Every session can read, upload and delete files</Text>
          </View>
          <Text style={styles.rowValue}>{snapshot.sessions.length}</Text>
        </View>
        <Button label="Manage devices" variant="secondary" onPress={onOpenSessions} style={{ marginTop: spacing(3) }} />
      </Card>

      <SectionLabel>About</SectionLabel>
      <Card style={styles.card}>
        <Text style={styles.rowTitle}>TransDev · 0.1.0</Text>
        <Text style={styles.about}>
          A local-only bridge between this phone and a desktop browser. The server listens on your LAN, every request
          needs a paired session, and file bytes are streamed so memory stays flat.
        </Text>
        <Text style={styles.aboutMuted}>
          Pairing attempts are limited to 5 per minute per device, sessions expire after 12 hours, and stopping the
          server immediately invalidates the address.
        </Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing(4),
    paddingBottom: spacing(12),
    gap: spacing(2),
  },
  card: {
    gap: spacing(3),
  },
  label: {
    fontSize: 11.5,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.mutedLight,
  },
  input: {
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#d8dce9',
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing(3),
    fontSize: 14,
    color: colors.text,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing(3),
  },
  rowTitle: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.text,
  },
  rowMeta: {
    fontSize: 11.5,
    color: colors.muted,
    marginTop: 1,
  },
  rowValue: {
    fontSize: 13,
    color: colors.textSoft,
    fontVariant: ['tabular-nums'],
  },
  pin: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.accentStrong,
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  about: {
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.muted,
  },
  aboutMuted: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.mutedLight,
  },
});
