import { useState } from 'react'
import { Alert, Button, Checkbox, Divider, Drawer, Space, Table, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { localizedText, normalizeLocale } from '@shared/localized'
import type { ProfileDiffEntry, ProfileToolState } from '@shared/types'
import { useInstallStore } from '../store/install-store'
import { useManageStore } from '../store/manage-store'

const { Text, Paragraph } = Typography

const STATE_COLOR: Record<ProfileToolState, string> = {
  missing: 'red',
  'version-differs': 'orange',
  'already-present': 'green',
  'installed-by-devkit': 'blue'
}

const STATE_LABEL: Record<ProfileToolState, { 'zh-CN': string; 'en-US': string }> = {
  missing: { 'zh-CN': '缺失', 'en-US': 'missing' },
  'version-differs': { 'zh-CN': '版本不同', 'en-US': 'version differs' },
  'already-present': { 'zh-CN': '本机已有', 'en-US': 'already present' },
  'installed-by-devkit': { 'zh-CN': 'devkit 已装', 'en-US': 'installed by devkit' }
}

/**
 * 环境档案 / 换机迁移（FR-22）。
 *
 * 交互刻意分成"看清 → 再动手"两步：
 *  1. 导入后先展示档案里到底有什么 + 与本机的差异表
 *  2. 恢复环境配置的四个选项默认**全不勾** —— 换机迁移会改 PATH / 环境变量，
 *     这种事必须用户自己点，不能默认帮他做
 *
 * 装软件不在这里做：把 selections 交给现有的安装流程（预检→下载→校验→安装→自检→激活）。
 */
export function ProfileDrawer() {
  const { t, i18n } = useTranslation()
  const locale = normalizeLocale(i18n.language)

  const open = useManageStore((state) => state.profileOpen)
  const openProfile = useManageStore((state) => state.openProfile)
  const busy = useManageStore((state) => state.busy)
  const imported = useManageStore((state) => state.importedProfile)
  const exported = useManageStore((state) => state.exportedProfile)
  const exportProfile = useManageStore((state) => state.exportProfile)
  const importProfile = useManageStore((state) => state.importProfile)
  const applyProfile = useManageStore((state) => state.applyProfile)

  const prepareInstall = useInstallStore((state) => state.prepare)

  const [includeGit, setIncludeGit] = useState(false)
  const [restore, setRestore] = useState({
    restoreUserPath: false,
    restoreEnv: false,
    restoreMirrors: false,
    restoreGit: false
  })

  return (
    <Drawer
      open={open}
      onClose={() => openProfile(false)}
      title={t('profile.title')}
      width={820}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={() => openProfile(false)}>{t('common.close')}</Button>
        </div>
      }
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Alert type="info" showIcon message={t('profile.whatItIs')} description={t('profile.whatItIsHint')} />

        {/* ---------- 导出 ---------- */}
        <div>
          <Text strong>{t('profile.export')}</Text>
          <Paragraph type="secondary" style={{ fontSize: 12.5, margin: '4px 0' }}>
            {t('profile.exportHint')}
          </Paragraph>
          <Space>
            <Checkbox checked={includeGit} onChange={(event) => setIncludeGit(event.target.checked)}>
              {t('profile.includeGit')}
            </Checkbox>
            <Button
              type="primary"
              loading={busy}
              onClick={() => void exportProfile({ includeGitIdentity: includeGit })}
            >
              {t('profile.exportRun')}
            </Button>
          </Space>
          {exported?.filePath ? (
            <div style={{ marginTop: 6 }}>
              <Text type="success" style={{ fontSize: 12.5 }}>
                {t('profile.exported', { path: exported.filePath })}
              </Text>
            </div>
          ) : null}
        </div>

        <Divider style={{ margin: '4px 0' }} />

        {/* ---------- 导入 ---------- */}
        <div>
          <Text strong>{t('profile.import')}</Text>
          <Paragraph type="secondary" style={{ fontSize: 12.5, margin: '4px 0' }}>
            {t('profile.importHint')}
          </Paragraph>
          <Button loading={busy} onClick={() => void importProfile()}>
            {t('profile.importRun')}
          </Button>

          {imported?.error ? (
            <Alert style={{ marginTop: 8 }} type="error" showIcon message={imported.error} />
          ) : null}

          {imported?.profile && imported.diff ? (
            <div style={{ marginTop: 10 }}>
              <Alert
                type="success"
                showIcon
                message={t('profile.importedFrom', { path: imported.filePath ?? '' })}
                description={
                  <div>
                    {(imported.description ?? []).map((line, index) => (
                      <div key={index}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          · {line}
                        </Text>
                      </div>
                    ))}
                  </div>
                }
              />

              <div style={{ marginTop: 10 }}>
                <Text strong>{t('profile.diffTitle')}</Text>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  {t('profile.diffSummary', {
                    install: imported.diff.summary.toInstall,
                    present: imported.diff.summary.alreadyPresent
                  })}
                </Text>
                <Table<ProfileDiffEntry>
                  size="small"
                  rowKey="toolId"
                  style={{ marginTop: 6 }}
                  pagination={imported.diff.tools.length > 10 ? { pageSize: 10 } : false}
                  dataSource={imported.diff.tools}
                  columns={[
                    {
                      title: t('profile.tool'),
                      dataIndex: 'toolId',
                      render: (_value, row) => (
                        <Space size={6}>
                          <Text>{row.name ? localizedText(row.name, locale, row.toolId) : row.toolId}</Text>
                          <Text type="secondary" style={{ fontSize: 11.5 }}>
                            {row.toolId}
                          </Text>
                        </Space>
                      )
                    },
                    {
                      title: t('profile.state'),
                      dataIndex: 'state',
                      width: 110,
                      render: (state: ProfileToolState) => (
                        <Tag color={STATE_COLOR[state]} style={{ marginInlineEnd: 0 }}>
                          {localizedText(STATE_LABEL[state], locale, state)}
                        </Tag>
                      )
                    },
                    {
                      title: t('profile.wantedVersion'),
                      dataIndex: 'wantedVersion',
                      width: 130,
                      render: (value: string | null) => <Text type="secondary">{value ?? '—'}</Text>
                    },
                    {
                      title: t('profile.currentVersion'),
                      dataIndex: 'currentVersion',
                      width: 130,
                      render: (value: string | null) => <Text type="secondary">{value ?? '—'}</Text>
                    }
                  ]}
                />
              </div>

              <div style={{ marginTop: 12 }}>
                <Text strong>{t('profile.restore')}</Text>
                <Paragraph type="secondary" style={{ fontSize: 12.5, margin: '4px 0' }}>
                  {t('profile.restoreHint')}
                </Paragraph>
                <Space direction="vertical" size={4}>
                  <Checkbox
                    checked={restore.restoreUserPath}
                    disabled={imported.diff.summary.pathEntries === 0}
                    onChange={(e) => setRestore((s) => ({ ...s, restoreUserPath: e.target.checked }))}
                  >
                    {t('profile.restorePath', { count: imported.diff.summary.pathEntries })}
                  </Checkbox>
                  <Checkbox
                    checked={restore.restoreEnv}
                    disabled={imported.diff.summary.envVars === 0}
                    onChange={(e) => setRestore((s) => ({ ...s, restoreEnv: e.target.checked }))}
                  >
                    {t('profile.restoreEnv', { count: imported.diff.summary.envVars })}
                  </Checkbox>
                  <Checkbox
                    checked={restore.restoreMirrors}
                    disabled={imported.profile.mirrors.filter((item) => item.url).length === 0}
                    onChange={(e) => setRestore((s) => ({ ...s, restoreMirrors: e.target.checked }))}
                  >
                    {t('profile.restoreMirrors', {
                      count: imported.profile.mirrors.filter((item) => item.url).length
                    })}
                  </Checkbox>
                  <Checkbox
                    checked={restore.restoreGit}
                    disabled={!imported.profile.git.userName || !imported.profile.git.userEmail}
                    onChange={(e) => setRestore((s) => ({ ...s, restoreGit: e.target.checked }))}
                  >
                    {t('profile.restoreGit')}
                  </Checkbox>
                </Space>

                <div style={{ marginTop: 10 }}>
                  <Space>
                    <Button
                      type="primary"
                      loading={busy}
                      disabled={imported.diff.summary.toInstall === 0}
                      onClick={() => {
                        // 装软件走现有流程：预检 → 下载 → 校验 → 安装 → 自检 → 激活
                        void prepareInstall(imported.profile!.selections)
                        openProfile(false)
                      }}
                    >
                      {t('profile.installAll', { count: imported.diff.summary.toInstall })}
                    </Button>
                    <Button
                      loading={busy}
                      disabled={!Object.values(restore).some(Boolean)}
                      onClick={() => void applyProfile(imported.profile!, restore)}
                    >
                      {t('profile.applyRestore')}
                    </Button>
                  </Space>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </Space>
    </Drawer>
  )
}
