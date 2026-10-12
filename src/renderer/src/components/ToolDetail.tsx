import { Button, Descriptions, Popover, Space, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { localizedText, normalizeLocale } from '@shared/localized'
import { pickRecommendedVersion } from '@shared/manifest'
import type { ToolManifest } from '@shared/types'
import { formatBytes } from '../utils/format'

const { Text, Paragraph } = Typography

const SCOPE_LABEL: Record<'user' | 'machine', { 'zh-CN': string; 'en-US': string }> = {
  user: { 'zh-CN': '用户级（不需要管理员）', 'en-US': 'Per-user (no admin)' },
  machine: { 'zh-CN': '机器级（需要管理员）', 'en-US': 'Per-machine (needs admin)' }
}

/** 从 URL 里取出主机名，用于"这个包是从哪来的" */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function shortHash(hash: string | undefined): string {
  if (!hash) return '—'
  return `${hash.slice(0, 16)}…`
}

/**
 * 工具详情（供应链透明）。
 *
 * 调研结论里有一条是明确的："只走官方直链 + SHA256 校验，界面上展示每个下载项的
 * 来源域名与哈希"。用户没法验证一个 100 MB 的二进制里装了什么，但至少应该能一眼看到
 * 它是从哪个域名下下来的、校验和是多少 —— 这也是与 Chocolatey/Scoop 那类
 * "第三方包仓库"最本质的差别。
 */
export function ToolDetail({ tool }: { tool: ToolManifest }) {
  const { t, i18n } = useTranslation()
  const locale = normalizeLocale(i18n.language)
  const recommended = pickRecommendedVersion(tool)

  const content = (
    <div style={{ width: 520 }}>
      <Descriptions size="small" column={1} bordered styles={{ label: { width: 96 } }}>
        <Descriptions.Item label={t('detail.homepage')}>
          {tool.homepage ? (
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() => void window.devkit.openExternal(tool.homepage ?? '')}
            >
              {tool.homepage}
            </Button>
          ) : (
            '—'
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('detail.license')}>
          {tool.license ? (
            <Space size={6}>
              <Text code>{tool.license.spdx}</Text>
              <Tag color={tool.license.redistributable ? 'green' : 'orange'}>
                {tool.license.redistributable ? t('detail.redistributable') : t('detail.notRedistributable')}
              </Tag>
            </Space>
          ) : (
            '—'
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('detail.tier')}>
          <Tag color={tool.tier === 'L1' ? 'cyan' : tool.tier === 'L2' ? 'purple' : 'magenta'}>
            {tool.tier} · {t(`tool.tier${tool.tier}`)}
          </Tag>
        </Descriptions.Item>
      </Descriptions>

      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 6 }}>
        {t('detail.versionsHint')}
      </Paragraph>

      <div className="dk-scroll" style={{ maxHeight: 260 }}>
        {tool.versions.map((version) => (
          <div
            key={version.version}
            style={{
              border: '1px solid #f0f0f0',
              borderRadius: 6,
              padding: '8px 10px',
              marginBottom: 8
            }}
          >
            <Space size={6} wrap>
              <Text strong>{version.version}</Text>
              <Tag>{version.channel}</Tag>
              {version.recommended ? <Tag color="blue">{t('tool.recommended')}</Tag> : null}
              {version.releaseDate ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {version.releaseDate}
                </Text>
              ) : null}
              {version.sizeBytes ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {formatBytes(version.sizeBytes)}
                </Text>
              ) : null}
            </Space>

            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('detail.scope')}：{localizedText(SCOPE_LABEL[version.installScope], locale, version.installScope)}
              </Text>
            </div>

            {version.source?.url ? (
              <>
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('detail.source')}：
                  </Text>
                  <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                    {hostOf(version.source.url)}
                  </Tag>
                </div>
                <Paragraph
                  copyable={{ text: version.source.url }}
                  style={{ fontSize: 11.5, margin: '4px 0 0', wordBreak: 'break-all' }}
                  type="secondary"
                >
                  {version.source.url}
                </Paragraph>
              </>
            ) : null}

            {version.source?.sha256 ? (
              <div style={{ marginTop: 4 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  SHA-256：
                </Text>
                <Text code copyable={{ text: version.source.sha256 }} style={{ fontSize: 11.5 }}>
                  {shortHash(version.source.sha256)}
                </Text>
              </div>
            ) : (
              <div style={{ marginTop: 4 }}>
                <Text type="warning" style={{ fontSize: 12 }}>
                  {t('detail.noHash')}
                </Text>
              </div>
            )}

            {version.mirrors && version.mirrors.length > 0 ? (
              <div style={{ marginTop: 4 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('detail.mirrors')}：
                </Text>
                {version.mirrors.map((mirror) => (
                  <Tag key={mirror.name} style={{ marginInlineEnd: 4 }}>
                    {mirror.name}
                  </Tag>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {recommended?.verify ? (
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          {t('detail.verify')}：<Text code>{recommended.verify.cmd}</Text>{' '}
          {(recommended.verify.args ?? []).join(' ')}
        </Paragraph>
      ) : null}
    </div>
  )

  return (
    <Popover content={content} title={localizedText(tool.name, locale, tool.id)} trigger="click" placement="right">
      <Button type="link" size="small" style={{ padding: 0, height: 'auto' }}>
        {t('detail.open')}
      </Button>
    </Popover>
  )
}
