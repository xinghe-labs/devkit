import { useEffect, useState } from 'react'
import { Button, Input, Modal, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { localizedText, normalizeLocale } from '@shared/localized'
import type { PlanSelection, Preset } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { useManageStore } from '../store/manage-store'

const { Text } = Typography

/**
 * 预设方案条（FR-3）。
 *
 * 预设是这个产品"一键"体验的入口：新人不知道要装什么，点一个「前端开发」就够了。
 * 内置预设不能删，用户自建的可以删；预设只是一组勾选结果，不含任何命令。
 */
export function PresetBar() {
  const { t, i18n } = useTranslation()
  const locale = normalizeLocale(i18n.language)

  const presets = useManageStore((state) => state.presets)
  const loadPresets = useManageStore((state) => state.loadPresets)
  const savePreset = useManageStore((state) => state.savePreset)
  const deletePreset = useManageStore((state) => state.deletePreset)

  const tools = useAppStore((state) => state.tools)
  const selections = useAppStore((state) => state.selections)
  const applyPreset = useAppStore((state) => state.applyPreset)

  const [saveOpen, setSaveOpen] = useState(false)
  const [name, setName] = useState('')

  useEffect(() => {
    void loadPresets()
  }, [loadPresets])

  const applicable = (preset: Preset): PlanSelection[] => {
    // 清单里已经没有的工具（预设过期）自动跳过，而不是让整个预设失败
    const known = new Set(tools.map((tool) => tool.id))
    return preset.tools.filter((selection) => known.has(selection.toolId))
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Text type="secondary" style={{ fontSize: 12.5, flexShrink: 0 }}>
        {t('preset.label')}
      </Text>

      {presets.map((preset) => {
        const usable = applicable(preset)
        const missing = preset.tools.length - usable.length

        return (
          <Tooltip
            key={preset.id}
            title={
              <div>
                <div>{localizedText(preset.description, locale, '')}</div>
                {missing > 0 ? (
                  <div style={{ marginTop: 4 }}>{t('preset.missingTools', { count: missing })}</div>
                ) : null}
              </div>
            }
          >
            <Tag
              color={preset.builtin ? 'blue' : 'green'}
              style={{ cursor: usable.length > 0 ? 'pointer' : 'not-allowed', marginInlineEnd: 0 }}
              onClick={() => {
                if (usable.length > 0) applyPreset(usable)
              }}
              closable={!preset.builtin}
              onClose={(event) => {
                event.preventDefault()
                void deletePreset(preset.id)
              }}
            >
              {localizedText(preset.name, locale, preset.id)}
              <span style={{ opacity: 0.6, marginLeft: 4 }}>{usable.length}</span>
            </Tag>
          </Tooltip>
        )
      })}

      <div style={{ flex: 1 }} />

      <Popconfirm
        title={t('preset.saveTitle')}
        open={saveOpen}
        onOpenChange={setSaveOpen}
        okText={t('common.yes')}
        cancelText={t('common.no')}
        description={
          <Input
            size="small"
            placeholder={t('preset.namePlaceholder')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={{ width: 200, marginTop: 6 }}
          />
        }
        onConfirm={() => {
          void savePreset(name.trim() || 'my-preset', selections)
          setName('')
          setSaveOpen(false)
        }}
      >
        <Button size="small" type="link" disabled={selections.length === 0}>
          {t('preset.save')}
        </Button>
      </Popconfirm>
    </div>
  )
}

/** 导入预设：接受一段预设 JSON 文本 */
export function ImportPresetButton() {
  const { t } = useTranslation()
  const importPreset = useManageStore((state) => state.importPreset)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <Button size="small" type="link" onClick={() => setOpen(true)}>
        {t('preset.import')}
      </Button>
      <Modal
        open={open}
        title={t('preset.importTitle')}
        onCancel={() => setOpen(false)}
        onOk={() => {
          try {
            const parsed = JSON.parse(text) as unknown
            void importPreset(parsed)
            setText('')
            setError(null)
            setOpen(false)
          } catch (parseError) {
            setError((parseError as Error).message)
          }
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {t('preset.importHint')}
          </Text>
          <Input.TextArea
            rows={8}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder='{"id":"team-web","name":{"zh-CN":"团队前端"},"tools":[{"toolId":"nodejs"}]}'
          />
          {error ? <Text type="danger">{error}</Text> : null}
        </Space>
      </Modal>
    </>
  )
}
