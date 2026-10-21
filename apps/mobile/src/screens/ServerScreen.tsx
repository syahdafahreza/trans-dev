import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import type { LocalHost } from '../server/localHost';
import { colors, radius, spacing } from '../theme';
import { formatBytes, type HostSnapshot } from '../types';
import { Badge, Button, Card, EmptyHint, SectionLabel, Stat, StatusDot } from '../components/ui';

interface ServerScreenProps {
  host: LocalHost;
  snapshot: HostSnapshot;
  busy: boolean;
  onToggle: () => void;
  onRotatePin: () => void;
  onRevoke: (id: string) => void;
}

export function ServerScreen({ snapshot, busy, onToggle, onRotatePin, onRevoke }: ServerScreenProps) {
  const { running, pin, ip, port, sessions, storage } = snapshot;
  const url = `http://${ip}:${port}`;
  const usedPercent = storage.total ? Math.min(100, Math.round(((storage.used ?? 0) / storage.total) * 100)) : 0;

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.statusRow}>
            <StatusDot on={running} />
            <Text style={styles.statusText}>{running ? 'Server running' : 'Server offline'}</Text>
          </View>
          <Badge label={running ? 'On Wi-Fi' : 'Stopped'} tone={running ? 'success' : 'neutral'} />
        </View>

        <Text style={styles.heroTitle}>{snapshot.deviceName}</Text>
        <Text style={styles.heroUrl}>{running ? url : 'Start the server to get an address'}</Text>

        {running ? (
          <View style={styles.pinRow}>
            {pin.split('').map((digit, index) => (
              <View style={styles.pinBox} key={`${digit}-${index}`}>
                <Text style={styles.pinDigit}>{digit}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.heroHint}>
            Pairing turns this phone into a small web server. Nothing leaves your Wi-Fi.
          </Text>
        )}

        <Pressable
          onPress={onToggle}
          disabled={busy}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.heroButton,
            running ? styles.heroButtonStop : styles.heroButtonStart,
            pressed && { opacity: 0.85 },
            busy && { opacity: 0.6 },
          ]}
        >
          {busy ? (
            <ActivityIndicator color={running ? colors.text : '#fff'} />
          ) : (
            <Text style={[styles.heroButtonLabel, running && { color: colors.text }]}>
              {running ? 'Disconnect server' : 'Connect · start server'}
            </Text>
          )}
        </Pressable>

        {snapshot.lastError ? <Text style={styles.heroError}>{snapshot.lastError}</Text> : null}
      </View>

      {running && (
        <>
          <Card style={styles.qrCard}>
            <View style={styles.qrText}>
              <Text style={styles.cardTitle}>Pair a computer</Text>
              <Text style={styles.cardBody}>
                Open <Text style={styles.mono}>{url}</Text> in any browser on the same Wi-Fi, then enter the 4-digit
                code shown above.
              </Text>
              <View style={styles.qrActions}>
                <Button label="New PIN" variant="secondary" onPress={onRotatePin} style={styles.smallButton} />
                <Badge label={`${snapshot.connections} open connection${snapshot.connections === 1 ? '' : 's'}`} tone="accent" />
              </View>
            </View>
            <View style={styles.qrBox}>
              <QRCode value={`${url}/?pin=${pin}`} size={116} color="#111827" backgroundColor="#ffffff" />
            </View>
          </Card>

          <SectionLabel>Connected devices</SectionLabel>
          <Card style={styles.devicesCard}>
            {sessions.length === 0 ? (
              <EmptyHint title="No devices yet" message="The first computer that pairs with this PIN will appear here." />
            ) : (
              sessions.map((session) => (
                <View style={styles.deviceRow} key={session.id}>
                  <View style={styles.deviceIcon}>
                    <Text style={styles.deviceIconLabel}>PC</Text>
                  </View>
                  <View style={styles.deviceText}>
                    <Text style={styles.deviceName}>{session.clientName}</Text>
                    <Text style={styles.deviceMeta}>
                      via {session.method.toUpperCase()} · seen {new Date(session.lastSeenAt).toLocaleTimeString()}
                    </Text>
                  </View>
                  <Pressable onPress={() => onRevoke(session.id)} accessibilityRole="button" hitSlop={8}>
                    <Text style={styles.revoke}>Remove</Text>
                  </Pressable>
                </View>
              ))
            )}
          </Card>
        </>
      )}

      <SectionLabel>Device storage</SectionLabel>
      <Card>
        <View style={styles.storageHead}>
          <Text style={styles.cardTitle}>{formatBytes(storage.free)} free</Text>
          <Text style={styles.cardMeta}>{usedPercent}% used</Text>
        </View>
        <View style={styles.storageBar}>
          <View style={[styles.storageFill, { width: `${usedPercent}%` }]} />
        </View>
        <View style={styles.statsRow}>
          <Stat label="Total" value={formatBytes(storage.total)} />
          <Stat label="Free" value={formatBytes(storage.free)} />
          <Stat label="Shared" value={formatBytes(storage.sharedBytes)} />
        </View>
      </Card>

      <SectionLabel>How it works</SectionLabel>
      <Card style={styles.stepsCard}>
        {[
          ['1', 'Join the same Wi-Fi', 'This phone and the computer must be on the same network.'],
          ['2', 'Open the address', `Type ${url} into the browser on your computer.`],
          ['3', 'Approve the session', 'Enter the PIN above. You can remove the device at any time.'],
        ].map(([step, title, body]) => (
          <View style={styles.step} key={step}>
            <View style={styles.stepBadge}>
              <Text style={styles.stepBadgeLabel}>{step}</Text>
            </View>
            <View style={styles.stepText}>
              <Text style={styles.stepTitle}>{title}</Text>
              <Text style={styles.stepBody}>{body}</Text>
            </View>
          </View>
        ))}
      </Card>

      <Text style={styles.footnote}>
        TransDev never uploads file contents anywhere. The token created here only unlocks this phone while the server
        runs.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing(4),
    paddingBottom: spacing(12),
    gap: spacing(2),
  },
  hero: {
    backgroundColor: colors.hero,
    borderRadius: radius.xl,
    padding: spacing(5),
    gap: spacing(3),
    marginBottom: spacing(2),
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
  },
  statusText: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 12.5,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  heroTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.4,
    marginTop: spacing(2),
  },
  heroUrl: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  heroHint: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    lineHeight: 19,
  },
  pinRow: {
    flexDirection: 'row',
    gap: spacing(2.5),
    marginTop: spacing(1),
  },
  pinBox: {
    width: 58,
    height: 72,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinDigit: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  heroButton: {
    height: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing(1),
  },
  heroButtonStart: {
    backgroundColor: colors.accent,
  },
  heroButtonStop: {
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  heroButtonLabel: {
    fontSize: 14.5,
    fontWeight: '600',
    color: '#fff',
  },
  heroError: {
    color: '#fca5a5',
    fontSize: 12,
  },
  qrCard: {
    flexDirection: 'row',
    gap: spacing(3),
    alignItems: 'center',
  },
  qrText: {
    flex: 1,
    gap: spacing(2),
  },
  qrActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    marginTop: spacing(1),
  },
  qrBox: {
    padding: spacing(2),
    backgroundColor: '#fff',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  smallButton: {
    height: 34,
    paddingHorizontal: spacing(3),
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: -0.2,
  },
  cardBody: {
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.muted,
  },
  cardMeta: {
    fontSize: 12,
    color: colors.muted,
    fontVariant: ['tabular-nums'],
  },
  mono: {
    fontFamily: 'Courier',
    fontSize: 12,
    color: colors.textSoft,
    fontWeight: '600',
  },
  devicesCard: {
    gap: spacing(1),
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(3),
    paddingVertical: spacing(2.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  deviceIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceIconLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accentStrong,
  },
  deviceText: {
    flex: 1,
    gap: 2,
  },
  deviceName: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.text,
  },
  deviceMeta: {
    fontSize: 11.5,
    color: colors.muted,
  },
  revoke: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.danger,
  },
  storageHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing(2),
  },
  storageBar: {
    height: 7,
    borderRadius: 999,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  storageFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  statsRow: {
    flexDirection: 'row',
    marginTop: spacing(3),
    gap: spacing(2),
  },
  stepsCard: {
    gap: spacing(3),
  },
  step: {
    flexDirection: 'row',
    gap: spacing(3),
    alignItems: 'flex-start',
  },
  stepBadge: {
    width: 26,
    height: 26,
    borderRadius: 9,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.accentStrong,
  },
  stepText: {
    flex: 1,
    gap: 1,
  },
  stepTitle: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.text,
  },
  stepBody: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
  footnote: {
    fontSize: 11.5,
    lineHeight: 17,
    color: colors.mutedLight,
    paddingHorizontal: spacing(1),
    marginTop: spacing(2),
  },
});
