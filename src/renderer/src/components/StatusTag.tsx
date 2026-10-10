import { Tag, Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import type { DetectionResult, DetectionStatus } from '@shared/types'

const COLOR: Record<DetectionStatus, string> = {
  installed: 'green',
  'version-mismatch': 'blue',
  'path-missing': 'orange',
  'not-installed': 'default',
  error: 'red'
}

export function StatusTag({ result }: { result: DetectionResult | undefined }) {
  const { t } = useTranslation()

  if (!result) {
    return <Tag>…</Tag>
  }

  const label = t(`status.${result.status}`)
  const detail =
    result.status === 'version-mismatch' && result.installedVersion
      ? t('tool.installedVersion', { version: result.installedVersion })
      : result.error

  const tag = <Tag color={COLOR[result.status]}>{label}</Tag>

  return detail ? (
    <Tooltip title={detail}>
      <span>{tag}</span>
    </Tooltip>
  ) : (
    tag
  )
}
