import { useEffect, useMemo } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  ConfigProvider,
  Empty,
  Input,
  Layout,
  List,
  Menu,
  Row,
  Segmented,
  Space,
  Spin,
  Statistic,
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
import { LogPanel } from './components/LogPanel'
import { ToolRow } from './components/ToolRow'
import { useAppStore, type CategoryFilter } from './store/app-store'
import { useLogStore } from './store/log-store'
import { formatBytes } from './utils/format'

const { Header, Content, Footer } = Layout
const { Text, Title } = Typography

const ANTD_LOCALES = { 'zh-CN': zhCN, 'en-US': enUS } as const

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

  useEffect(() => {
    let disposed = false

    void window.devkit.tailLog(500).then((entries) => {
      if (!disposed) setAllLogs(entries)
    })
    const unsubscribe = window.devkit.onLogLine((entry) => {
      if (!disposed) appendLog(entry)
    })
    void bootstrap()

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [appendLog, bootstrap, setAllLogs])

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
            gap: 12,
            paddingInline: 20,
            background: '#fff',
            borderBottom: '1px solid #f0f0f0'
          }}
        >
          <Title level={4} style={{ margin: 0 }}>
            {t('app.name')}
          </Title>
          <Text type="secondary">{t('app.tagline')}</Text>
          {info ? <Tag>{`v${info.version}`}</Tag> : null}

          <div style={{ flex: 1 }} />

          <Segmented
            value={locale}
            onChange={(value) => void changeLocale(value as Locale)}
            options={[
              { label: '中文', value: 'zh-CN' },
              { label: 'English', value: 'en-US' }
            ]}
          />
          <Button size="small" onClick={() => void window.devkit.openLogDir()}>
            {t('action.openLogDir')}
          </Button>
        </Header>

        <Content
          style={{
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
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

          <Row gutter={12}>
            <Col span={6}>
              <Card size="small">
                <Statistic title={t('summary.installed')} value={counts.installed} />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title={t('summary.missing')} value={counts.missing} />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title={t('summary.pathIssue')} value={counts.pathIssue} />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title={t('summary.selected')} value={selectedCount} />
              </Card>
            </Col>
          </Row>

          <div style={{ flex: 1, display: 'flex', gap: 12, minHeight: 0 }}>
            <Card
              size="small"
              style={{ width: 220, flexShrink: 0 }}
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

            <Card
              size="small"
              style={{ flex: 1, minWidth: 0 }}
              styles={{
                body: {
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  height: '100%',
                  minHeight: 0
                }
              }}
              title={
                <Input
                  placeholder={t('common.search')}
                  allowClear
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  style={{ width: 280 }}
                />
              }
              extra={
                <Space>
                  <Button size="small" loading={detecting} onClick={() => void refreshDetection()}>
                    {t('action.redetect')}
                  </Button>
                  <Button size="small" disabled={selectedCount === 0} onClick={clearSelection}>
                    {t('action.clearSelection')}
                  </Button>
                </Space>
              }
            >
              <div className="dk-scroll" style={{ flex: 1, minHeight: 0 }}>
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
                    size="small"
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
            padding: '10px 20px',
            background: '#fff',
            borderTop: '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
            gap: 12
          }}
        >
          <Text>
            {t('summary.selected')} <Text strong>{selectedCount}</Text>
          </Text>
          <Text type="secondary">{formatBytes(estimatedBytes)}</Text>
          <div style={{ flex: 1 }} />
          <Tooltip title={t('action.installDisabled')}>
            <span>
              <Button type="primary" disabled>
                {t('action.install')}
              </Button>
            </span>
          </Tooltip>
        </Footer>
      </Layout>
    </ConfigProvider>
  )
}
