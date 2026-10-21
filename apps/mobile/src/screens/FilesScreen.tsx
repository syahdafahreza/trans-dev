import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, EmptyHint, SectionLabel } from '../components/ui';
import { SHARED_FOLDERS, type LocalHost } from '../server/localHost';
import { colors, radius, spacing } from '../theme';
import { formatBytes, relativeTime, type FileEntry, type StorageSummary } from '../types';

const KIND_TINT: Record<string, { bg: string; fg: string; label: string }> = {
  folder: { bg: '#eef0ff', fg: '#4f46e5', label: 'DIR' },
  image: { bg: '#e8f4fe', fg: '#0284c7', label: 'IMG' },
  video: { bg: '#f2ecfe', fg: '#7c3aed', label: 'VID' },
  audio: { bg: '#ffedf3', fg: '#e11d48', label: 'AUD' },
  pdf: { bg: '#feeceb', fg: '#dc2626', label: 'PDF' },
  document: { bg: '#eaf1ff', fg: '#2563eb', label: 'DOC' },
  spreadsheet: { bg: '#e6f7ef', fg: '#059669', label: 'CSV' },
  archive: { bg: '#fdf3e2', fg: '#a16207', label: 'ZIP' },
  text: { bg: '#f1f3f9', fg: '#5b6478', label: 'TXT' },
  code: { bg: '#e6f6f5', fg: '#0f766e', label: 'DEV' },
};

interface FilesScreenProps {
  host: LocalHost;
  storage: StorageSummary;
  refreshKey: number;
}

export function FilesScreen({ host, storage, refreshKey }: FilesScreenProps) {
  const [path, setPath] = useState('/Inbox');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const listing = (await host.browse(target)) as unknown as FileEntry[];
        setEntries(listing);
      } catch (exception) {
        setEntries([]);
        setError(exception instanceof Error ? exception.message : 'Could not read this folder');
      } finally {
        setLoading(false);
      }
    },
    [host],
  );

  useEffect(() => {
    void load(path);
  }, [load, path, refreshKey]);

  const activeFolder = SHARED_FOLDERS.find((folder) => path === `/${folder.name}` || path.startsWith(`/${folder.name}/`));

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.summary}>
        <Text style={styles.summaryValue}>{formatBytes(storage.sharedBytes)}</Text>
        <Text style={styles.summaryLabel}>shared with paired computers · {formatBytes(storage.free)} free</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {SHARED_FOLDERS.map((folder) => {
          const active = activeFolder?.id === folder.id;
          return (
            <Pressable
              key={folder.id}
              onPress={() => setPath(`/${folder.name}`)}
              style={[styles.chip, active && styles.chipActive]}
              accessibilityRole="button"
            >
              <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{folder.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.pathRow}>
        <Text style={styles.path} numberOfLines={1}>
          {path}
        </Text>
        {path !== '/' && (
          <Pressable
            onPress={() => setPath(path.replace(/\/[^/]+$/, '') || '/')}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={styles.up}>Up one level</Text>
          </Pressable>
        )}
      </View>

      <Card style={styles.listCard}>
        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : error ? (
          <EmptyHint title="Can’t read this folder" message={error} />
        ) : entries.length === 0 ? (
          <EmptyHint
            title="Nothing here yet"
            message="Files uploaded from a paired computer land in this folder."
          />
        ) : (
          entries.map((entry, index) => {
            const tint = KIND_TINT[entry.kind] ?? { bg: '#f1f3f9', fg: '#5b6478', label: 'FILE' };
            return (
              <Pressable
                key={entry.path}
                onPress={() => entry.type === 'dir' && setPath(entry.path)}
                style={({ pressed }) => [
                  styles.row,
                  index === entries.length - 1 && { borderBottomWidth: 0 },
                  pressed && entry.type === 'dir' && { backgroundColor: colors.surfaceAlt },
                ]}
                accessibilityRole={entry.type === 'dir' ? 'button' : 'text'}
              >
                <View style={[styles.glyph, { backgroundColor: tint.bg }]}>
                  <Text style={[styles.glyphLabel, { color: tint.fg }]}>{tint.label}</Text>
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {entry.name}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {entry.type === 'dir' ? 'Folder' : formatBytes(entry.size)} · {relativeTime(entry.mtime)}
                  </Text>
                </View>
                {entry.type === 'dir' && <Text style={styles.chevron}>›</Text>}
              </Pressable>
            );
          })
        )}
      </Card>

      <SectionLabel>About these folders</SectionLabel>
      <Card>
        <Text style={styles.note}>
          Inbox collects uploads from paired computers. Photos, Documents and Downloads expose the app’s documents
          folder; on a device build the native bridge can point them at the camera roll and system file picker.
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
  summary: {
    gap: 2,
    paddingHorizontal: spacing(1),
  },
  summaryValue: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.6,
  },
  summaryLabel: {
    fontSize: 12.5,
    color: colors.muted,
  },
  chips: {
    gap: spacing(2),
    paddingVertical: spacing(2),
  },
  chip: {
    paddingHorizontal: spacing(3.5),
    paddingVertical: spacing(2),
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.accentSoft,
    borderColor: '#d6d4ff',
  },
  chipLabel: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.muted,
  },
  chipLabelActive: {
    color: colors.accentStrong,
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing(3),
    paddingHorizontal: spacing(1),
  },
  path: {
    fontSize: 12,
    color: colors.mutedLight,
    flex: 1,
  },
  up: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent,
  },
  listCard: {
    padding: 0,
    overflow: 'hidden',
  },
  loading: {
    paddingVertical: spacing(8),
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(3),
    paddingHorizontal: spacing(3.5),
    paddingVertical: spacing(2.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  glyph: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphLabel: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  rowText: {
    flex: 1,
    gap: 1,
  },
  rowName: {
    fontSize: 13.5,
    fontWeight: '500',
    color: colors.text,
  },
  rowMeta: {
    fontSize: 11.5,
    color: colors.muted,
    fontVariant: ['tabular-nums'],
  },
  chevron: {
    fontSize: 20,
    color: colors.mutedLight,
    marginTop: -2,
  },
  note: {
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.muted,
  },
});
