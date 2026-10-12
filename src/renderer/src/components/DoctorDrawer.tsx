import { useEffect } from 'react'
import { Alert, Button, Drawer, Empty, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { localizedText, normalizeLocale } from '@shared/localized'
import type { DoctorFinding, DoctorFixId, DoctorLevel, PathEntryKind } from '@shared/types'
import { useManageStore } from '../store/manage-store'

const { Text, Paragraph } = Typography

const LEVEL_COLOR: Record<DoctorLevel, string> = { ok: 'success', warn: 'warning', error: 'error' }
const LEVEL_LABEL: Record<DoctorLevel, { 'zh-CN': string; 'en-US': string }> = {
  ok: { 'zh-CN': '正常', 'en-US': 'OK' },
  warn: { 'zh-CN': '注意', 'en-US': 'Notice' },
  error: { 'zh-CN': '问题', 'en-US': 'Problem' }
}

const ENTRY_KIND_COLOR: Record<PathEntryKind, string> = {
  ok: 'default',
  missing: 'red',
  'unexpanded-var': 'orange',
  malformed: 'volcano',
  duplicate: 'gold'
}

const ENTRY_KIND_LABEL: Record<PathEntryKind, { 'zh-CN': string; 'en-US': string }> = {
  ok: { 'zh-CN': '正常', 'en-US': 'ok' },
  missing: { 'zh-CN': '目录不存在', 'en-US': 'missing' },
  'unexpanded-var': { 'zh-CN': '变量不存在', 'en-US': 'bad variable' },
  malformed: { 'zh-CN': '结构畸形', 'en-US': 'malformed' },
  duplicate: { 'zh-CN': '重复', 'en-US': 'duplicate' }
}

/**
 * 环境体检（FR-21）。
 *
 * 三条产品原则，界面上要能看出来：
 *  1. **只读优先** —— 打开抽屉只跑诊断，不写任何东西
 *  2. **修复前先备份** —— 按钮上写清楚会改什么，Popconfirm 里说明原文会备份到哪
 *  3. **机器级修复单独标出** —— 它需要管理员（会弹一次 UAC），不能和用户级的混在一起
 */
export function DoctorDrawer() {
  const { t, i18n } = useTranslation()
  const locale = normalizeLocale(i18n.language)

  const open = useManageStore((state) => state.doctorOpen)
  const openDoctor = useManageStore((state) => state.openDoctor)
  const report = useManageStore((state) => state.doctorReport)
  const running = useManageStore((state) => state.doctorRunning)
  const fixing = useManageStore((state) => state.doctorFixing)
  const runDoctor = useManageStore((state) => state.runDoctor)
  const applyFix = useManageStore((state) => state.applyDoctorFix)

  useEffect(() => {
    if (open) void runDoctor()
  }, [open, runDoctor])

  const findings = report?.findings ?? []
  const sorted = [...findings].sort((a, b) => {
    const weight = (level: DoctorLevel): number => (level === 'error' ? 0 : level === 'warn' ? 1 : 2)
    return weight(a.level) - weight(b.level)
  })

  const renderPathTable = (
    title: string,
    view: { entries: { index: number; raw: string; kind: PathEntryKind; reason: string | null }[] } | undefined,
    scopeNote: string
  ) => {
    if (!view) return null
    const problems = view.entries.filter((entry) => entry.kind !== 'ok')
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 12 }}>
          <Text strong>{title}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {view.entries.length} 条 · 其中 {problems.length} 条有问题
          </Text>
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {scopeNote}
        </Text>
        <Table
          size="small"
          rowKey="index"
          pagination={problems.length > 12 ? { pageSize: 12 } : false}
          style={{ marginTop: 6 }}
          dataSource={view.entries.filter((entry) => entry.kind !== 'ok')}
          locale={{ emptyText: t('doctor.pathClean') }}
          columns={[
            { title: '#', dataIndex: 'index', width: 48 },
            {
              title: t('doctor.pathEntry'),
              dataIndex: 'raw',
              render: (value: string) => (
                <Text code style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                  {value}
                </Text>
              )
            },
            {
              title: t('doctor.pathKind'),
              dataIndex: 'kind',
              width: 110,
              render: (kind: PathEntryKind) => (
                <Tag color={ENTRY_KIND_COLOR[kind]} style={{ marginInlineEnd: 0 }}>
                  {localizedText(ENTRY_KIND_LABEL[kind], locale, kind)}
                </Tag>
              )
            },
            {
              title: t('doctor.pathReason'),
              dataIndex: 'reason',
              render: (value: string | null) => (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {value ?? '—'}
                </Text>
              )
            }
          ]}
        />
      </>
    )
  }

  const renderFix = (fix: DoctorFinding['fix']) => {
    if (!fix) return null
    const machine = fix.scope === 'machine'
    return (
      <Popconfirm
        title={t('doctor.fixConfirmTitle')}
        description={
          <div style={{ maxWidth: 380 }}>
            <div>{t(machine ? 'doctor.fixConfirmMachine' : 'doctor.fixConfirmUser')}</div>
            <div style={{ marginTop: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('doctor.fixBackupNote')}
              </Text>
            </div>
          </div>
        }
        okText={t('doctor.fixRun')}
        cancelText={t('common.no')}
        onConfirm={() => void applyFix(fix.id as DoctorFixId)}
      >
        <Button size="small" type={machine ? 'default' : 'primary'} danger={machine} loading={fixing}>
          {localizedText(fix.label, locale, fix.id)}
        </Button>
      </Popconfirm>
    )
  }

  return (
    <Drawer
      open={open}
      onClose={() => openDoctor(false)}
      title={t('doctor.title')}
      width={860}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {t('doctor.readOnlyNote')}
          </Text>
          <Space>
            <Button loading={running} onClick={() => void runDoctor()}>
              {t('doctor.rerun')}
            </Button>
            <Button onClick={() => openDoctor(false)}>{t('common.close')}</Button>
          </Space>
        </div>
      }
    >
      {running && !report ? (
        <Text type="secondary">{t('doctor.running')}</Text>
      ) : !report ? (
        <Empty description={t('doctor.empty')} style={{ marginTop: 60 }} />
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert
            type={report.summary.error > 0 ? 'error' : report.summary.warn > 0 ? 'warning' : 'success'}
            showIcon
            message={t('doctor.summary', {
              error: report.summary.error,
              warn: report.summary.warn,
              ok: report.summary.ok
            })}
            description={t('doctor.summaryHint')}
          />

          {sorted.map((finding) => (
            <div
              key={finding.id}
              style={{
                border: '1px solid #f0f0f0',
                borderRadius: 6,
                padding: '10px 12px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Tag color={LEVEL_COLOR[finding.level]} style={{ marginInlineEnd: 0, minWidth: 46, textAlign: 'center' }}>
                  {localizedText(LEVEL_LABEL[finding.level], locale, finding.level)}
                </Tag>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text strong>{localizedText(finding.title, locale, finding.id)}</Text>
                  <Paragraph type="secondary" style={{ fontSize: 12.5, margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>
                    {localizedText(finding.detail, locale, '')}
                  </Paragraph>
                </div>
                {renderFix(finding.fix)}
              </div>

              {finding.evidence.length > 0 ? (
                <div style={{ marginTop: 6, paddingLeft: 54 }}>
                  {finding.evidence.slice(0, 12).map((line, index) => (
                    <div key={index}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        · {line}
                      </Text>
                    </div>
                  ))}
                  {finding.evidence.length > 12 ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('doctor.moreEvidence', { count: finding.evidence.length - 12 })}
                    </Text>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}

          {renderPathTable(t('doctor.userPath'), report.userPath, t('doctor.userPathNote'))}
          {renderPathTable(t('doctor.machinePath'), report.machinePath, t('doctor.machinePathNote'))}
        </Space>
      )}
    </Drawer>
  )
}
