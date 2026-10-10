import type { ReactNode } from 'react'
import { Checkbox, List, Select, Space, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { localizedText, normalizeLocale } from '@shared/localized'
import { pickRecommendedVersion } from '@shared/manifest'
import type { DetectionResult, LicenseTier, ToolManifest } from '@shared/types'
import { StatusTag } from './StatusTag'

const { Text } = Typography

const TIER_COLOR: Record<LicenseTier, string> = {
  L1: 'cyan',
  L2: 'purple',
  L3: 'magenta'
}

interface ToolRowProps {
  tool: ToolManifest
  detection: DetectionResult | undefined
  selected: boolean
  selectedVersion: string | undefined
  onToggle: (checked: boolean) => void
  onVersionChange: (version: string) => void
}

export function ToolRow({
  tool,
  detection,
  selected,
  selectedVersion,
  onToggle,
  onVersionChange
}: ToolRowProps) {
  const { t, i18n } = useTranslation()
  const locale = normalizeLocale(i18n.language)
  const recommended = pickRecommendedVersion(tool)
  const activeVersion = selectedVersion ?? recommended?.version

  const tags: ReactNode[] = [
    <StatusTag key="status" result={detection} />,
    <Tag key="tier" color={TIER_COLOR[tool.tier]}>
      {t(`tool.tier${tool.tier}`)}
    </Tag>
  ]

  if (tool.status === 'detect-only') {
    tags.push(<Tag key="detect-only">{t('tool.detectOnly')}</Tag>)
  }
  if (recommended?.installScope === 'machine') {
    tags.push(
      <Tag key="admin" color="gold">
        {t('tool.requiresAdmin')}
      </Tag>
    )
  }
  if (recommended?.requiresReboot) {
    tags.push(
      <Tag key="reboot" color="volcano">
        {t('tool.requiresReboot')}
      </Tag>
    )
  }

  return (
    <List.Item>
      <div style={{ display: 'flex', gap: 16, width: '100%', alignItems: 'flex-start' }}>
        <Checkbox
          checked={selected}
          onChange={(event) => onToggle(event.target.checked)}
          aria-label={localizedText(tool.name, locale, tool.id)}
          style={{ marginTop: 3 }}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={8} wrap>
            <Text strong style={{ fontSize: 15 }}>
              {localizedText(tool.name, locale, tool.id)}
            </Text>
            {tags}
          </Space>

          <div className="dk-tool-desc">{localizedText(tool.description, locale, '—')}</div>

          {detection?.installedVersion ? (
            <div className="dk-tool-desc">
              {t('tool.installedVersion', { version: detection.installedVersion })}
            </div>
          ) : null}
        </div>

        <div style={{ width: 210, textAlign: 'right', flexShrink: 0, paddingTop: 2 }}>
          {tool.versions.length > 1 ? (
            <Select
              size="small"
              style={{ width: '100%' }}
              value={activeVersion}
              onChange={onVersionChange}
              options={tool.versions.map((version) => ({
                value: version.version,
                label: version.recommended
                  ? `${version.version} · ${t('tool.recommended')}`
                  : version.version
              }))}
            />
          ) : (
            <Text type="secondary" style={{ fontSize: 13 }}>
              {activeVersion ?? t('tool.noVersions')}
            </Text>
          )}
        </div>
      </div>
    </List.Item>
  )
}
