import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Divider,
  Drawer,
  Input,
  InputNumber,
  List,
  Select,
  Space,
  Switch,
  Tag,
  Typography
} from 'antd'
import { useTranslation } from 'react-i18next'
import { localizedText, normalizeLocale } from '@shared/localized'
import { MIRROR_PREFERENCES, type MirrorPreference, type MirrorTarget } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { useManageStore } from '../store/manage-store'

const { Text, Title } = Typography

const MIRROR_LABELS: Record<MirrorPreference, string> = {
  official: '官方源',
  huaweicloud: '华为云',
  aliyun: '阿里云',
  tuna: '清华 TUNA',
  ustc: '中科大 USTC'
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '8px 0' }}>
      <div style={{ width: 150, flexShrink: 0 }}>
        <Text>{label}</Text>
        {hint ? (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {hint}
            </Text>
          </div>
        ) : null}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

/**
 * 设置抽屉。
 *
 * 这里所有开关都对应真实的机器行为（写 PATH、改镜像配置文件、下载），
 * 所以每一项都写清楚"它会改什么"，而不是只给一个光秃秃的开关。
 */
export function SettingsDrawer() {
  const { t, i18n } = useTranslation()
  const open = useManageStore((state) => state.settingsOpen)
  const openSettings = useManageStore((state) => state.openSettings)
  const settings = useManageStore((state) => state.settings)
  const loadSettings = useManageStore((state) => state.loadSettings)
  const saveSettings = useManageStore((state) => state.saveSettings)
  const applyMirrors = useManageStore((state) => state.applyMirrors)
  const activation = useManageStore((state) => state.activation)
  const loadInstalled = useManageStore((state) => state.loadInstalled)
  const deactivate = useManageStore((state) => state.deactivate)
  const packOffline = useManageStore((state) => state.packOffline)
  const importOfflinePack = useManageStore((state) => state.importOfflinePack)
  const runHotUpdate = useManageStore((state) => state.runHotUpdate)
  const clearManifestOverride = useManageStore((state) => state.clearManifestOverride)
  const hotUpdateResult = useManageStore((state) => state.hotUpdateResult)
  const systemConfig = useManageStore((state) => state.systemConfig)
  const loadSystemConfig = useManageStore((state) => state.loadSystemConfig)
  const applySystemConfig = useManageStore((state) => state.applySystemConfig)
  const checkUpdate = useManageStore((state) => state.checkUpdate)
  const updateInfo = useManageStore((state) => state.updateInfo)
  const busy = useManageStore((state) => state.busy)

  const [gitName, setGitName] = useState('')
  const [gitEmail, setGitEmail] = useState('')

  const selections = useAppStore((state) => state.selections)
  const info = useAppStore((state) => state.info)

  useEffect(() => {
    if (open) {
      void loadSettings()
      void loadInstalled()
      void loadSystemConfig()
    }
  }, [open, loadSettings, loadInstalled, loadSystemConfig])

  const patchMirror = (target: MirrorTarget, patch: { enabled?: boolean; url?: string }): void => {
    if (!settings) return
    const mirrors = settings.mirrors.map((item) =>
      item.target === target ? { ...item, ...patch } : item
    )
    void saveSettings({ mirrors })
  }

  return (
    <Drawer
      open={open}
      onClose={() => openSettings(false)}
      title={t('settings.title')}
      width={680}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={() => openSettings(false)}>{t('common.close')}</Button>
        </div>
      }
    >
      {!settings ? (
        <Text type="secondary">{t('common.loading')}</Text>
      ) : (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Title level={5} style={{ margin: '4px 0' }}>
            {t('settings.download')}
          </Title>

          <Row label={t('settings.mirrorPreference')} hint={t('settings.mirrorPreferenceHint')}>
            <Select
              size="small"
              style={{ width: 220 }}
              value={settings.mirrorPreference}
              onChange={(value) => void saveSettings({ mirrorPreference: value })}
              options={MIRROR_PREFERENCES.map((value) => ({
                value,
                label: MIRROR_LABELS[value]
              }))}
            />
          </Row>

          <Row label={t('settings.proxy')} hint={t('settings.proxyHint')}>
            <Input
              size="small"
              style={{ width: 260 }}
              placeholder="http://127.0.0.1:7890"
              defaultValue={settings.proxy ?? ''}
              onBlur={(event) => {
                const value = event.target.value.trim()
                if (value !== (settings.proxy ?? '')) void saveSettings({ proxy: value || null })
              }}
            />
          </Row>

          <Row label={t('settings.concurrency')} hint={t('settings.concurrencyHint')}>
            <InputNumber
              size="small"
              min={1}
              max={3}
              value={settings.concurrency}
              onChange={(value) => void saveSettings({ concurrency: Number(value ?? 1) })}
            />
          </Row>

          <Divider style={{ margin: '10px 0' }} />
          <Title level={5} style={{ margin: '4px 0' }}>
            {t('settings.afterInstall')}
          </Title>

          <Row label={t('settings.activate')} hint={t('settings.activateHint')}>
            <Switch
              size="small"
              checked={settings.activateAfterInstall}
              onChange={(checked) => void saveSettings({ activateAfterInstall: checked })}
            />
          </Row>

          <Row label={t('settings.configureMirrors')} hint={t('settings.configureMirrorsHint')}>
            <Switch
              size="small"
              checked={settings.configureMirrors}
              onChange={(checked) => void saveSettings({ configureMirrors: checked })}
            />
          </Row>

          <Row label={t('settings.restorePoint')} hint={t('settings.restorePointHint')}>
            <Switch
              size="small"
              checked={settings.createRestorePoint}
              onChange={(checked) => void saveSettings({ createRestorePoint: checked })}
            />
          </Row>

          <Divider style={{ margin: '10px 0' }} />
          <Title level={5} style={{ margin: '4px 0' }}>
            {t('settings.mirrors')}
          </Title>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {t('settings.mirrorsHint')}
          </Text>

          {settings.mirrors.map((item) => (
            <Row key={item.target} label={item.target}>
              <Space size={8} style={{ width: '100%' }}>
                <Switch
                  size="small"
                  checked={item.enabled}
                  onChange={(checked) => patchMirror(item.target, { enabled: checked })}
                />
                <Input
                  size="small"
                  style={{ width: 320 }}
                  value={item.url}
                  disabled={!item.enabled}
                  onChange={(event) => patchMirror(item.target, { url: event.target.value })}
                />
              </Space>
            </Row>
          ))}

          <Button size="small" loading={busy} onClick={() => void applyMirrors()}>
            {t('settings.applyMirrors')}
          </Button>

          <Divider style={{ margin: '10px 0' }} />
          <Title level={5} style={{ margin: '4px 0' }}>
            {t('settings.offline')}
          </Title>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {t('settings.offlineHint')}
          </Text>
          <Space style={{ marginTop: 8 }}>
            <Button
              size="small"
              disabled={selections.length === 0}
              loading={busy}
              onClick={() => void packOffline(selections.map((item) => item.toolId))}
            >
              {t('settings.packOffline', { count: selections.length })}
            </Button>
            <Button size="small" loading={busy} onClick={() => void importOfflinePack()}>
              {t('settings.importOffline')}
            </Button>
          </Space>

          <Divider style={{ margin: '10px 0' }} />
          <Title level={5} style={{ margin: '4px 0' }}>
            {t('settings.hotUpdate')}
          </Title>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {t('settings.hotUpdateHint')}
          </Text>

          <Row label={t('settings.hotUpdateUrl')} hint={t('settings.hotUpdateUrlHint')}>
            <Input
              size="small"
              style={{ width: 340 }}
              placeholder="https://example.com/devkit/manifest-index.json"
              defaultValue={settings.manifestHotUpdateUrl ?? ''}
              onBlur={(event) => {
                const value = event.target.value.trim()
                if (value !== (settings.manifestHotUpdateUrl ?? '')) {
                  void saveSettings({ manifestHotUpdateUrl: value || null })
                }
              }}
            />
          </Row>

          <Row label={t('settings.hotUpdateAuto')} hint={t('settings.hotUpdateAutoHint')}>
            <Switch
              size="small"
              checked={settings.manifestHotUpdate}
              onChange={(checked) => void saveSettings({ manifestHotUpdate: checked })}
            />
          </Row>

          <Space>
            <Button
              size="small"
              disabled={!settings.manifestHotUpdateUrl}
              loading={busy}
              onClick={() => void runHotUpdate(settings.manifestHotUpdateUrl ?? '')}
            >
              {t('settings.hotUpdateRun')}
            </Button>
            <Button size="small" loading={busy} onClick={() => void clearManifestOverride()}>
              {t('settings.hotUpdateReset')}
            </Button>
          </Space>

          {hotUpdateResult ? (
            <div style={{ marginTop: 8 }}>
              {hotUpdateResult.updated.map((item) => (
                <div key={item.id}>
                  <Text type="secondary" style={{ fontSize: 12.5 }}>
                    ✔ {item.id} → {item.versions.join(' / ')}
                  </Text>
                </div>
              ))}
              {hotUpdateResult.rejected.length > 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: 6 }}
                  message={`${hotUpdateResult.rejected.length} ${t('settings.hotUpdateRejected')}`}
                  description={
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {hotUpdateResult.rejected.slice(0, 8).map((item, index) => (
                        <li key={`${item.id}-${index}`}>
                          <Text style={{ fontSize: 12 }}>{item.reason}</Text>
                        </li>
                      ))}
                    </ul>
                  }
                />
              ) : null}
            </div>
          ) : null}

          <Divider style={{ margin: '10px 0' }} />
          <Title level={5} style={{ margin: '4px 0' }}>
            {t('settings.system')}
          </Title>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {t('settings.systemHint')}
          </Text>

          <List
            size="small"
            dataSource={systemConfig}
            renderItem={(item) => (
              <List.Item
                actions={[
                  item.id === 'git-identity' ? (
                    <Space key="git" size={4}>
                      <Input
                        size="small"
                        style={{ width: 110 }}
                        placeholder={t('settings.gitName')}
                        value={gitName}
                        onChange={(event) => setGitName(event.target.value)}
                      />
                      <Input
                        size="small"
                        style={{ width: 170 }}
                        placeholder={t('settings.gitEmail')}
                        value={gitEmail}
                        onChange={(event) => setGitEmail(event.target.value)}
                      />
                      <Button
                        size="small"
                        loading={busy}
                        disabled={!gitName.trim() || !gitEmail.trim()}
                        onClick={() =>
                          void applySystemConfig({
                            id: 'git-identity',
                            gitName: gitName.trim(),
                            gitEmail: gitEmail.trim()
                          })
                        }
                      >
                        {t('settings.apply')}
                      </Button>
                    </Space>
                  ) : (
                    <Button
                      key={item.id}
                      size="small"
                      loading={busy}
                      disabled={item.configured}
                      onClick={() => void applySystemConfig({ id: item.id })}
                    >
                      {item.configured ? t('settings.configured') : t('settings.apply')}
                    </Button>
                  )
                ]}
              >
                <div style={{ minWidth: 0 }}>
                  <Space size={6}>
                    <Text>{localizedText(item.label, normalizeLocale(i18n.language), item.id)}</Text>
                    {item.requiresAdmin ? <Tag color="gold">{t('tool.requiresAdmin')}</Tag> : null}
                    {item.configured ? <Tag color="green">{t('settings.configured')}</Tag> : null}
                  </Space>
                  <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {item.detail}
                    </Text>
                  </div>
                  <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {localizedText(item.hint, normalizeLocale(i18n.language), '')}
                    </Text>
                  </div>
                </div>
              </List.Item>
            )}
          />

          <Divider style={{ margin: '10px 0' }} />
          <Title level={5} style={{ margin: '4px 0' }}>
            {t('settings.activation')}
          </Title>

          {settings.pathBackupFile ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 8 }}
              message={t('settings.pathBackup', { path: settings.pathBackupFile })}
            />
          ) : (
            <Text type="secondary" style={{ fontSize: 12.5 }}>
              {t('settings.pathBackupNone')}
            </Text>
          )}

          {activation && activation.records.length > 0 ? (
            <List
              size="small"
              dataSource={activation.records}
              renderItem={(record) => (
                <List.Item
                  actions={[
                    <Button
                      key="off"
                      size="small"
                      type="link"
                      danger
                      onClick={() => void deactivate(record.toolId)}
                    >
                      {t('settings.deactivate')}
                    </Button>
                  ]}
                >
                  <Space size={8} wrap>
                    <Text strong>{record.toolId}</Text>
                    <Tag color="green">{record.version}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {record.linkPath}
                    </Text>
                  </Space>
                </List.Item>
              )}
            />
          ) : (
            <Text type="secondary" style={{ fontSize: 12.5 }}>
              {t('settings.noActivation')}
            </Text>
          )}

          <Divider style={{ margin: '10px 0' }} />
          <Title level={5} style={{ margin: '4px 0' }}>
            {t('settings.about')}
          </Title>
          <div>
            <Text type="secondary" style={{ fontSize: 12.5 }}>
              devkit v{info?.version ?? '—'} · Electron {info?.electronVersion ?? '—'} · Node{' '}
              {info?.nodeVersion ?? '—'}
            </Text>
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12.5 }}>
              {t('settings.manifestDir')}：<Text code>{info?.manifestDir ?? '—'}</Text>
            </Text>
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12.5 }}>
              {t('settings.logDir')}：<Text code>{info?.logDir ?? '—'}</Text>
            </Text>
          </div>

          <Row label={t('settings.updateFeed')} hint={t('settings.updateFeedHint')}>
            <Input
              size="small"
              style={{ width: 340 }}
              placeholder="https://example.com/devkit/latest.json"
              defaultValue={settings.updateFeedUrl ?? ''}
              onBlur={(event) => {
                const value = event.target.value.trim()
                if (value !== (settings.updateFeedUrl ?? '')) {
                  void saveSettings({ updateFeedUrl: value || null })
                }
              }}
            />
          </Row>
          <Space>
            <Button size="small" loading={busy} onClick={() => void checkUpdate()}>
              {t('settings.checkUpdate')}
            </Button>
            {updateInfo?.hasUpdate && updateInfo.downloadUrl ? (
              <Button
                size="small"
                type="primary"
                onClick={() => void window.devkit.openExternal(updateInfo.downloadUrl ?? '')}
              >
                {t('settings.downloadUpdate', { version: updateInfo.latestVersion ?? '' })}
              </Button>
            ) : null}
          </Space>
          {updateInfo?.notes ? (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {updateInfo.notes}
              </Text>
            </div>
          ) : null}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('settings.privacy')}
          </Text>
        </Space>
      )}
    </Drawer>
  )
}
