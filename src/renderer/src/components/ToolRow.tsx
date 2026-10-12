import type { ReactNode } from 'react'
import { Button, Checkbox, List, Select, Space, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { localizedText, normalizeLocale } from '@shared/localized'
import { pickRecommendedVersion } from '@shared/manifest'
import type { DetectionResult, LicenseTier, ToolManifest } from '@shared/types'
import { useManageStore } from '../store/manage-store'
import { StatusTag } from './StatusTag'
import { ToolDetail } from './ToolDetail'

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

  // devkit 自己装过哪些版本（与"机器上原本有没有"是两件事）
  const installed = useManageStore((state) => state.installed)
  const activate = useManageStore((state) => state.activate)
  const busy = useManageStore((state) => state.busy)
  const mine = installed.filter((item) => item.toolId === tool.id)
  const activatedVersion = mine.find((item) => item.active)?.version ?? null

  const tags: ReactNode[] = [
    <StatusTag key="status" result={detection} />,
    <Tag key="tier" color={TIER_COLOR[tool.tier]}>
      {t(`tool.tier${tool.tier}`)}
    </Tag>
  ]

  if (mine.length > 0) {
    tags.push(
      <Tag key="mine" color="geekblue">
        {t('tool.devkitInstalled', { versions: mine.map((item) => item.version).join(' / ') })}
      </Tag>
    )
  }
  if (activatedVersion) {
    tags.push(
      <Tag key="activated" color="green">
        {t('tool.activated', { version: activatedVersion })}
      </Tag>
    )
  }

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
            <ToolDetail tool={tool} />
          </Space>

          <div className="dk-tool-desc">{localizedText(tool.description, locale, '—')}</div>

          {detection?.installedVersion ? (
            <div className="dk-tool-desc">
              {t('tool.installedVersion', { version: detection.installedVersion })}
            </div>
          ) : null}
        </div>

        <div style={{ width: 210, textAlign: 'right', flexShrink: 0, paddingTop: 2 }}>
          {mine.length > 0 && !activatedVersion && recommended?.activate ? (
            <div style={{ marginBottom: 4 }}>
              <Button
                size="small"
                type="link"
                loading={busy}
                onClick={() => void activate(tool.id, mine[mine.length - 1].version)}
              >
                {t('tool.activateLatest', { version: mine[mine.length - 1].version })}
              </Button>
            </div>
          ) : null}

          {tool.versions.length > 1 ? (
            <Select
              size="small"
              style={{ width: '100%' }}
              value={activeVersion}
              onChange={onVersionChange}
              options={tool.versions.map((version) => ({
                value: version.version,
                // 把渠道与发布日期一起给出来：用户选版本时最需要的上下文就是这个
                label: [
                  version.version,
                  version.recommended ? t('tool.recommended') : version.channel,
                  version.releaseDate ?? null
                ]
                  .filter(Boolean)
                  .join(' · ')
              }))}
            />
          ) : (
            <Text type="secondary" style={{ fontSize: 13 }}>
              {activeVersion ?? t('tool.noVersions')}
              {recommended?.releaseDate ? ` · ${recommended.releaseDate}` : ''}
            </Text>
          )}
        </div>
      </div>
    </List.Item>
  )
}
