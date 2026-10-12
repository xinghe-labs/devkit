import { useEffect, useMemo } from 'react'
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Divider,
  Empty,
  Input,
  Layout,
  List,
  Menu,
  Segmented,
  Spin,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import { useTranslation } from 'react-i18next'
import { localizedText, normalizeLocale } from '@shared/localized'
import { pickRecommendedVersion } from '@shared/manifest'
import { TOOL_CATEGORIES, type Locale, type ToolCategory } from '@shared/types'
import { InstallFlow } from './components/InstallFlow'
import { InstalledDrawer } from './components/InstalledDrawer'
import { LogPanel } from './components/LogPanel'
import { ImportPresetButton, PresetBar } from './components/PresetBar'
import { SettingsDrawer } from './components/SettingsDrawer'
import { VscodeDrawer } from './components/VscodeDrawer'
import { ToolRow } from './components/ToolRow'
import { useAppStore, type CategoryFilter } from './store/app-store'
import { useInstallStore } from './store/install-store'
import { useLogStore } from './store/log-store'
import { useManageStore } from './store/manage-store'
import { formatBytes } from './utils/format'

const { Header, Content, Footer } = Layout
const { Text, Title } = Typography

const ANTD_LOCALES = { 'zh-CN': zhCN, 'en-US': enUS } as const

/**
 * 工具栏上的紧凑计数。
 * 刻意不用 Statistic：它自带 24px 的标题行和 margin，四个并排会吃掉约 90px 高度，
 * 而这些数字只需要一眼扫到。
 */
function InlineStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: 19, fontWeight: 600, lineHeight: 1, color: tone }}>{value}</span>
      <span style={{ fontSize: 12.5, color: 'rgba(0, 0, 0, 0.45)' }}>{label}</span>
    </div>
  )
}

export default function App() {
  const { t } = useTranslation()

  const locale = useAppStore((state) => state.locale)
  const info = useAppStore((state) => state.info)
  const tools = useAppStore((state) => state.tools)
  const manifestErrors = useAppStore((state) => state.manifestErrors)
  const detections = useAppStore((state) => state.detections)
  const detecting = useAppStore((state) => state.detecting)
  const selected = useAppStore((state) => state.selected)
  const selectedVersions = useAppStore((state) => state.selectedVersions)
  const selections = useAppStore((state) => state.selections)
  const activeCategory = useAppStore((state) => state.activeCategory)
  const query = useAppStore((state) => state.query)
  const fatalError = useAppStore((state) => state.fatalError)

  const bootstrap = useAppStore((state) => state.bootstrap)
  const refreshDetection = useAppStore((state) => state.refreshDetection)
  const changeLocale = useAppStore((state) => state.changeLocale)
  const toggleTool = useAppStore((state) => state.toggleTool)
  const setSelectedVersion = useAppStore((state) => state.setSelectedVersion)
  const selectCategory = useAppStore((state) => state.selectCategory)
  const setQuery = useAppStore((state) => state.setQuery)
  const clearSelection = useAppStore((state) => state.clearSelection)

  const appendLog = useLogStore((state) => state.append)
  const setAllLogs = useLogStore((state) => state.setAll)

  const prepare = useInstallStore((state) => state.prepare)
  const applyProgress = useInstallStore((state) => state.applyProgress)
  const checkPending = useInstallStore((state) => state.checkPending)
  const preparing = useInstallStore((state) => state.busy)

  const openSettings = useManageStore((state) => state.openSettings)
  const openVscode = useManageStore((state) => state.openVscode)
  const openInstalled = useManageStore((state) => state.openInstalled)
  const notice = useManageStore((state) => state.notice)
  const setNotice = useManageStore((state) => state.setNotice)
  const loadSettings = useManageStore((state) => state.loadSettings)
  const loadPresets = useManageStore((state) => state.loadPresets)
  const loadInstalled = useManageStore((state) => state.loadInstalled)
  const checkUpdate = useManageStore((state) => state.checkUpdate)
  const updateInfo = useManageStore((state) => state.updateInfo)
  const updateDownloading = useManageStore((state) => state.updateDownloading)
  const downloadAndInstallUpdate = useManageStore((state) => state.downloadAndInstallUpdate)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), notice.kind === 'error' ? 8000 : 4000)
    return () => clearTimeout(timer)
  }, [notice, setNotice])

  useEffect(() => {
    let disposed = false

    void window.devkit.tailLog(500).then((entries) => {
      if (!disposed) setAllLogs(entries)
    })
    const unsubscribeLog = window.devkit.onLogLine((entry) => {
      if (!disposed) appendLog(entry)
    })
    const unsubscribeProgress = window.devkit.onInstallProgress((event) => {
      if (!disposed) applyProgress(event)
    })

    void bootstrap()
    void checkPending()
    void loadSettings()
    void loadPresets()
    void loadInstalled()

    // 启动时自动检查更新：只在这两件事都就绪后做（开关打开 + 配了更新源）。
    // 刻意静默失败 —— 更新源不可达不该打扰用户。
    void (async () => {
      try {
        const settings = await window.devkit.getSettings()
        if (settings.autoUpdate && settings.updateFeedUrl) await checkUpdate()
      } catch {
        // 忽略：更新检查失败不影响使用
      }
    })()

    return () => {
      disposed = true
      unsubscribeLog()
      unsubscribeProgress()
    }
  }, [
    appendLog,
    applyProgress,
    bootstrap,
    checkPending,
    checkUpdate,
    loadInstalled,
    loadPresets,
    loadSettings,
    setAllLogs
  ])

  const counts = useMemo(() => {
    let installed = 0
    let missing = 0
    let pathIssue = 0
    for (const tool of tools) {
      const status = detections[tool.id]?.status
      if (status === 'installed' || status === 'version-mismatch') installed += 1
      else if (status === 'path-missing') pathIssue += 1
      else missing += 1
    }
    return { installed, missing, pathIssue }
  }, [tools, detections])

  const categoryCounts = useMemo(() => {
    const map = new Map<ToolCategory, number>()
    for (const tool of tools) map.set(tool.category, (map.get(tool.category) ?? 0) + 1)
    return map
  }, [tools])

  const visibleTools = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return tools.filter((tool) => {
      if (activeCategory !== 'all' && tool.category !== activeCategory) return false
      if (keyword === '') return true

      const haystack = [
        tool.id,
        localizedText(tool.name, locale, ''),
        localizedText(tool.description, locale, ''),
        ...Object.values(tool.name ?? {}),
        ...Object.values(tool.description ?? {})
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(keyword)
    })
  }, [tools, activeCategory, query, locale])

  const selectedCount = useMemo(() => Object.values(selected).filter(Boolean).length, [selected])

  const estimatedBytes = useMemo(() => {
    let total = 0
    for (const tool of tools) {
      if (selected[tool.id] !== true) continue
      const recommended = pickRecommendedVersion(tool)
      const version = selectedVersions[tool.id] ?? recommended?.version
      const spec = tool.versions.find((item) => item.version === version) ?? recommended
      total += spec?.sizeBytes ?? 0
    }
    return total
  }, [tools, selected, selectedVersions])

  const menuItems = useMemo(
    () => [
      { key: 'all', label: `${t('common.all')} (${tools.length})` },
      ...TOOL_CATEGORIES.filter((category) => (categoryCounts.get(category) ?? 0) > 0).map(
        (category) => ({
          key: category,
          label: `${t(`category.${category}`)} (${categoryCounts.get(category) ?? 0})`
        })
      )
    ],
    [t, tools.length, categoryCounts]
  )

  return (
    <ConfigProvider locale={ANTD_LOCALES[normalizeLocale(locale)]}>
      <Layout style={{ height: '100vh' }}>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            height: 52,
            lineHeight: 'normal',
            paddingInline: 16,
            background: '#fff',
            borderBottom: '1px solid #f0f0f0'
          }}
        >
          <Title level={5} style={{ margin: 0 }}>
            {t('app.name')}
          </Title>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {t('app.tagline')}
          </Text>
          {info ? <Tag style={{ marginInline: 0 }}>{`v${info.version}`}</Tag> : null}

          <div style={{ flex: 1 }} />

          <Segmented
            size="small"
            value={locale}
            onChange={(value) => void changeLocale(value as Locale)}
            options={[
              { label: '中文', value: 'zh-CN' },
              { label: 'English', value: 'en-US' }
            ]}
          />
          <Button size="small" onClick={() => openVscode(true)}>
            {t('action.vscode')}
          </Button>
          <Button size="small" onClick={() => openInstalled(true)}>
            {t('action.installed')}
          </Button>
          <Button size="small" onClick={() => openSettings(true)}>
            {t('action.settings')}
          </Button>
          <Button size="small" onClick={() => void window.devkit.openLogDir()}>
            {t('action.openLogDir')}
          </Button>
        </Header>

        <Content
          style={{
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            overflow: 'hidden'
          }}
        >
          {fatalError ? (
            <Alert type="error" showIcon message={t('error.loadFailed', { message: fatalError })} />
          ) : null}

          {manifestErrors.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`${t('error.title')} (${manifestErrors.length})`}
              description={
                <div>
                  {t('error.hint')}
                  <ul style={{ margin: '6px 0 0 0', paddingLeft: 18 }}>
                    {manifestErrors.map((error) => (
                      <li key={error.file}>
                        <Text code>{error.file}</Text> {error.message}
                      </li>
                    ))}
                  </ul>
                </div>
              }
            />
          ) : null}

          {updateInfo?.hasUpdate ? (
            <Alert
              type="info"
              showIcon
              message={t('update.available', { version: updateInfo.latestVersion ?? '' })}
              description={t('update.hint')}
              action={
                <Button
                  size="small"
                  type="primary"
                  loading={updateDownloading}
                  onClick={() => void downloadAndInstallUpdate()}
                >
                  {updateDownloading ? t('update.downloading') : t('update.downloadAndInstall')}
                </Button>
              }
            />
          ) : null}

          {notice ? (
            <Alert
              type={notice.kind === 'warning' ? 'warning' : notice.kind === 'info' ? 'info' : notice.kind}
              showIcon
              closable
              message={notice.text}
              onClose={() => setNotice(null)}
            />
          ) : null}

          {/* 预设条：新人不知道要装什么时，点一个预设就够了 */}
          <Card size="small" styles={{ body: { padding: '6px 16px' } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <PresetBar />
              </div>
              <ImportPresetButton />
            </div>
          </Card>

          {/* 一条工具栏吃掉原来的「四个统计卡 + 搜索框 + 操作按钮」，把纵向空间全部让给软件列表 */}
          <Card size="small" styles={{ body: { padding: '8px 16px' } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <InlineStat label={t('summary.installed')} value={counts.installed} tone="#389e0d" />
              <Divider type="vertical" style={{ margin: 0, height: 18 }} />
              <InlineStat label={t('summary.missing')} value={counts.missing} />
              <Divider type="vertical" style={{ margin: 0, height: 18 }} />
              <InlineStat label={t('summary.pathIssue')} value={counts.pathIssue} tone="#d46b08" />
              <Divider type="vertical" style={{ margin: 0, height: 18 }} />
              <InlineStat label={t('summary.selected')} value={selectedCount} tone="#1677ff" />

              <div style={{ flex: 1 }} />

              <Input
                size="small"
                placeholder={t('common.search')}
                allowClear
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                style={{ width: 220 }}
              />
              <Button size="small" loading={detecting} onClick={() => void refreshDetection()}>
                {t('action.redetect')}
              </Button>
              <Button size="small" disabled={selectedCount === 0} onClick={clearSelection}>
                {t('action.clearSelection')}
              </Button>
            </div>
          </Card>

          <div style={{ flex: 1, display: 'flex', gap: 10, minHeight: 0 }}>
            <Card
              size="small"
              style={{ width: 196, flexShrink: 0 }}
              styles={{ body: { padding: 4, height: '100%', overflowY: 'auto' } }}
            >
              <Menu
                mode="inline"
                selectedKeys={[activeCategory]}
                items={menuItems}
                onClick={({ key }) => selectCategory(key as CategoryFilter)}
                style={{ border: 'none' }}
              />
            </Card>

            {/* 无标题无 extra：整张卡片就是列表，纵向空间全给内容 */}
            <Card
              size="small"
              style={{ flex: 1, minWidth: 0 }}
              styles={{
                body: {
                  padding: 0,
                  height: '100%',
                  overflow: 'hidden'
                }
              }}
            >
              <div className="dk-scroll" style={{ height: '100%' }}>
                {detecting && tools.length === 0 ? (
                  <div style={{ padding: 40, textAlign: 'center' }}>
                    <Spin />
                    <div style={{ marginTop: 12 }}>
                      <Text type="secondary">{t('app.detecting')}</Text>
                    </div>
                  </div>
                ) : visibleTools.length === 0 ? (
                  <Empty
                    style={{ marginTop: 48 }}
                    description={tools.length === 0 ? t('empty.manifest') : t('empty.tools')}
                  />
                ) : (
                  <List
                    size="large"
                    dataSource={visibleTools}
                    renderItem={(tool) => (
                      <ToolRow
                        key={tool.id}
                        tool={tool}
                        detection={detections[tool.id]}
                        selected={selected[tool.id] === true}
                        selectedVersion={selectedVersions[tool.id]}
                        onToggle={(checked) => toggleTool(tool.id, checked)}
                        onVersionChange={(version) => setSelectedVersion(tool.id, version)}
                      />
                    )}
                  />
                )}
              </div>
            </Card>
          </div>

          <LogPanel />
        </Content>

        <Footer
          style={{
            padding: '8px 16px',
            background: '#fff',
            borderTop: '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
            gap: 12
          }}
        >
          <Text style={{ fontSize: 13 }}>
            {t('summary.selected')} <Text strong>{selectedCount}</Text>
          </Text>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {formatBytes(estimatedBytes)}
          </Text>
          <div style={{ flex: 1 }} />
          <Tooltip title={selectedCount === 0 ? t('action.installDisabled') : ''}>
            <span>
              <Button
                type="primary"
                disabled={selectedCount === 0}
                loading={preparing}
                onClick={() => void prepare(selections)}
              >
                {t('action.install')}
              </Button>
            </span>
          </Tooltip>
        </Footer>

        <InstallFlow />
        <SettingsDrawer />
        <InstalledDrawer />
        <VscodeDrawer />
      </Layout>
    </ConfigProvider>
  )
}
