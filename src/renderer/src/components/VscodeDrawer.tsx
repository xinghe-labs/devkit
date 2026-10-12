import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Drawer, Empty, Space, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { localizedText, normalizeLocale } from '@shared/localized'
import type { VscodeCategory } from '@shared/types'
import { useManageStore } from '../store/manage-store'

const { Text } = Typography

const CATEGORY_ORDER: VscodeCategory[] = ['general', 'frontend', 'java', 'python', 'go', 'rust', 'cpp']

/**
 * VS Code 插件面板（FR-7）。
 *
 * 刻意不"自动全装"：插件会改变编辑器行为，属于用户该自己决定的事。
 * 这里给一个按语言分类的推荐列表，用户勾选后逐条安装，每条单独上报结果 ——
 * 插件安装失败（网络、版本不兼容）很常见，不能让一条失败掩盖掉其余结果。
 */
export function VscodeDrawer() {
  const { t, i18n } = useTranslation()
  const locale = normalizeLocale(i18n.language)

  const open = useManageStore((state) => state.vscodeOpen)
  const openVscode = useManageStore((state) => state.openVscode)
  const status = useManageStore((state) => state.vscodeStatus)
  const extensions = useManageStore((state) => state.vscodeExtensions)
  const result = useManageStore((state) => state.vscodeResult)
  const busy = useManageStore((state) => state.busy)
  const loadVscode = useManageStore((state) => state.loadVscode)
  const installExtensions = useManageStore((state) => state.installExtensions)

  const [picked, setPicked] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (open) void loadVscode()
  }, [open, loadVscode])

  const pickedIds = Object.entries(picked)
    .filter(([, value]) => value)
    .map(([id]) => id)

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: extensions.filter((item) => item.category === category)
  })).filter((group) => group.items.length > 0)

  return (
    <Drawer
      open={open}
      onClose={() => openVscode(false)}
      title={t('vscode.title')}
      width={680}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {t('vscode.selected', { count: pickedIds.length })}
          </Text>
          <Space>
            <Button onClick={() => openVscode(false)}>{t('common.close')}</Button>
            <Button
              type="primary"
              loading={busy}
              disabled={!status?.available || pickedIds.length === 0}
              onClick={() => void installExtensions(pickedIds)}
            >
              {t('vscode.install')}
            </Button>
          </Space>
        </div>
      }
    >
      {!status ? (
        <Text type="secondary">{t('common.loading')}</Text>
      ) : !status.available ? (
        <Alert
          type="warning"
          showIcon
          message={t('vscode.unavailable')}
          description={
            <div>
              <Text>{t('vscode.unavailableHint')}</Text>
              <div style={{ marginTop: 6 }}>
                <Text code>{status.detail}</Text>
              </div>
            </div>
          }
        />
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert type="success" showIcon message={status.detail} />

          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {t('vscode.hint')}
          </Text>

          {result ? (
            <Alert
              type={result.ok ? 'success' : 'warning'}
              showIcon
              message={t('vscode.result', { ok: result.installed.length, failed: result.failed.length })}
              description={
                result.failed.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {result.failed.map((item) => (
                      <li key={item.id}>
                        <Text style={{ fontSize: 12 }}>
                          {item.id} —— {item.error}
                        </Text>
                      </li>
                    ))}
                  </ul>
                ) : null
              }
            />
          ) : null}

          {extensions.length === 0 ? (
            <Empty description={t('vscode.empty')} />
          ) : (
            grouped.map((group) => (
              <div key={group.category}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Text strong>{t(`vscode.category.${group.category}`)}</Text>
                  <Button
                    type="link"
                    size="small"
                    onClick={() =>
                      setPicked((state) => {
                        const next = { ...state }
                        const allPicked = group.items.every((item) => state[item.id] === true)
                        for (const item of group.items) next[item.id] = !allPicked
                        return next
                      })
                    }
                  >
                    {t('vscode.toggleGroup')}
                  </Button>
                </div>

                {group.items.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: 'flex',
                      gap: 10,
                      alignItems: 'flex-start',
                      padding: '6px 10px',
                      border: '1px solid #f0f0f0',
                      borderRadius: 6,
                      marginBottom: 6
                    }}
                  >
                    <Checkbox
                      checked={picked[item.id] === true}
                      onChange={(event) =>
                        setPicked((state) => ({ ...state, [item.id]: event.target.checked }))
                      }
                      style={{ marginTop: 3 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Space size={6} wrap>
                        <Text strong>{localizedText(item.name, locale, item.id)}</Text>
                        <Tag style={{ marginInlineEnd: 0 }}>{item.id}</Tag>
                      </Space>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {localizedText(item.description, locale, '')}
                        </Text>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </Space>
      )}
    </Drawer>
  )
}
