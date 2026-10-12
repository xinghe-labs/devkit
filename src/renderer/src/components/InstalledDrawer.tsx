import { useEffect } from 'react'
import { Alert, Button, Drawer, Empty, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { localizedText, normalizeLocale } from '@shared/localized'
import { indexById } from '@shared/manifest'
import { useAppStore } from '../store/app-store'
import { useManageStore } from '../store/manage-store'
import { formatBytes, formatTime } from '../utils/format'

const { Text } = Typography

/**
 * 「已安装」抽屉（FR-11 / FR-16）。
 *
 * 这里能做的三件事，正好是"装完之后的全部动作"：
 *  · 激活 / 切换版本（改 junction + 用户 PATH，不改安装文件）
 *  · 取消激活（把 PATH 与环境变量收回去，文件留着）
 *  · 卸载（删版本目录；如果删的是当前激活版本，会先取消激活）
 */
export function InstalledDrawer() {
  const { t, i18n } = useTranslation()
  const locale = normalizeLocale(i18n.language)

  const open = useManageStore((state) => state.installedOpen)
  const openInstalled = useManageStore((state) => state.openInstalled)
  const installed = useManageStore((state) => state.installed)
  const busy = useManageStore((state) => state.busy)
  const loadInstalled = useManageStore((state) => state.loadInstalled)
  const uninstall = useManageStore((state) => state.uninstall)
  const activate = useManageStore((state) => state.activate)

  const tools = useAppStore((state) => state.tools)

  useEffect(() => {
    if (open) void loadInstalled()
  }, [open, loadInstalled])

  const byId = indexById(tools)

  const grouped = new Map<string, typeof installed>()
  for (const item of installed) {
    const list = grouped.get(item.toolId) ?? []
    list.push(item)
    grouped.set(item.toolId, list)
  }

  return (
    <Drawer
      open={open}
      onClose={() => openInstalled(false)}
      title={t('installed.title')}
      width={720}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {t('installed.hint')}
          </Text>
          <Button onClick={() => openInstalled(false)}>{t('common.close')}</Button>
        </div>
      }
    >
      {installed.length === 0 ? (
        <Empty description={t('installed.empty')} style={{ marginTop: 60 }} />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {[...grouped.entries()].map(([toolId, versions]) => {
            const tool = byId.get(toolId)
            const active = versions.find((item) => item.active)

            return (
              <div key={toolId}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <Text strong>{tool ? localizedText(tool.name, locale, toolId) : toolId}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {toolId}
                  </Text>
                  {active ? (
                    <Tag color="green">{t('installed.active', { version: active.version })}</Tag>
                  ) : (
                    <Tag>{t('installed.inactive')}</Tag>
                  )}
                </div>

                {versions.map((item) => (
                  <div
                    key={`${item.toolId}@${item.version}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '6px 10px',
                      border: '1px solid #f0f0f0',
                      borderRadius: 6,
                      marginBottom: 6
                    }}
                  >
                    <Tag color={item.active ? 'green' : 'default'} style={{ minWidth: 74, textAlign: 'center' }}>
                      {item.version}
                    </Tag>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text type="secondary" style={{ fontSize: 12 }} code>
                        {item.installDir}
                      </Text>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {formatBytes(item.sizeBytes)}
                          {item.installedAt ? ` · ${formatTime(item.installedAt)}` : ''}
                          {item.activatable ? '' : ` · ${t('installed.notActivatable')}`}
                        </Text>
                      </div>
                    </div>

                    <Space size={4}>
                      {item.activatable && !item.active ? (
                        <Tooltip title={t('installed.activateHint')}>
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            loading={busy}
                            onClick={() => void activate(item.toolId, item.version)}
                          >
                            {t('installed.activate')}
                          </Button>
                        </Tooltip>
                      ) : null}

                      <Popconfirm
                        title={t('installed.uninstallTitle', { tool: toolId, version: item.version })}
                        description={t('installed.uninstallDesc')}
                        okText={t('common.yes')}
                        cancelText={t('common.no')}
                        onConfirm={() => void uninstall(item.toolId, item.version)}
                      >
                        <Button size="small" danger loading={busy}>
                          {t('installed.uninstall')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  </div>
                ))}
              </div>
            )
          })}

          <Alert type="info" showIcon message={t('installed.scopeNote')} />
        </Space>
      )}
    </Drawer>
  )
}
