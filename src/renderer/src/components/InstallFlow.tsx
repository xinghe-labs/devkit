import { useState } from 'react'
import { Alert, Button, Drawer, List, Modal, Progress, Space, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type { PlanItem, PlanItemState, PreflightCheck } from '@shared/types'
import { isItemFinished, unfinishedCount, useInstallStore } from '../store/install-store'
import { formatBytes } from '../utils/format'

const { Text } = Typography

const STATE_COLOR: Record<PlanItemState, string> = {
  pending: 'default',
  downloading: 'processing',
  verifying: 'processing',
  installing: 'processing',
  checking: 'processing',
  success: 'success',
  failed: 'error',
  skipped: 'warning',
  cancelled: 'default'
}

const CHECK_COLOR: Record<PreflightCheck['level'], string> = {
  ok: 'success',
  warn: 'warning',
  error: 'error'
}

function CheckRow({ check, label }: { check: PreflightCheck; label: string }) {
  return (
    <List.Item style={{ paddingBlock: 6 }}>
      <Space align="start" size={10}>
        <Tag color={CHECK_COLOR[check.level]} style={{ marginInlineEnd: 0, minWidth: 44, textAlign: 'center' }}>
          {label}
        </Tag>
        <Text>{check.message}</Text>
      </Space>
    </List.Item>
  )
}

function ItemRow({
  item,
  current,
  detailText
}: {
  item: PlanItem
  current: boolean
  detailText: string | null
}) {
  const { t } = useTranslation()
  return (
    <List.Item style={{ paddingBlock: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
        <Tag
          color={STATE_COLOR[item.state]}
          style={{ marginInlineEnd: 0, minWidth: 62, textAlign: 'center' }}
        >
          {t(`install.state.${item.state}`)}
        </Tag>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={8}>
            <Text strong={current}>{item.id}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {item.version}
            </Text>
          </Space>
          {item.error ? (
            <div style={{ color: '#cf1322', fontSize: 12, marginTop: 2 }}>{item.error}</div>
          ) : item.note ? (
            <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12, marginTop: 2 }}>{item.note}</div>
          ) : null}
        </div>
        {detailText ? (
          <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
            {detailText}
          </Text>
        ) : null}
      </div>
    </List.Item>
  )
}

/**
 * 安装流程：预检弹窗 → 进度抽屉 → 报告。
 *
 * 三个阶段共用一个 store 里的 phase，避免多个弹层互相打架。
 */
export function InstallFlow() {
  const { t } = useTranslation()
  const phase = useInstallStore((state) => state.phase)
  const preparation = useInstallStore((state) => state.preparation)
  const plan = useInstallStore((state) => state.plan)
  const currentItemId = useInstallStore((state) => state.currentItemId)
  const detail = useInstallStore((state) => state.detail)
  const busy = useInstallStore((state) => state.busy)
  const error = useInstallStore((state) => state.error)
  const pending = useInstallStore((state) => state.pending)
  const start = useInstallStore((state) => state.start)
  const cancel = useInstallStore((state) => state.cancel)
  const close = useInstallStore((state) => state.close)
  const resume = useInstallStore((state) => state.resume)
  const discardPending = useInstallStore((state) => state.discardPending)
  const exportReport = useInstallStore((state) => state.exportReport)

  const [exportedPath, setExportedPath] = useState<string | null>(null)

  const preflight = preparation?.preflight ?? null
  const items = plan?.items ?? []
  const finishedCount = items.filter(isItemFinished).length
  const percent = items.length === 0 ? 0 : Math.round((finishedCount / items.length) * 100)
  const running = phase === 'running'

  const detailText =
    detail?.received === undefined
      ? null
      : detail.total
        ? `${formatBytes(detail.received)} / ${formatBytes(detail.total)}`
        : `${formatBytes(detail.received)}`

  return (
    <>
      {/* ---------- 预检 ---------- */}
      <Modal
        open={phase === 'preflight'}
        title={t('install.preflightTitle')}
        width={720}
        onCancel={close}
        footer={[
          <Button key="back" onClick={close}>
            {t('install.back')}
          </Button>,
          <Button
            key="start"
            type="primary"
            loading={busy}
            disabled={!preflight?.ok}
            onClick={() => void start()}
          >
            {t('install.start')}
          </Button>
        ]}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type={preflight?.ok ? 'success' : 'error'}
            showIcon
            message={preflight?.ok ? t('install.preflightPassed') : t('install.preflightBlocked')}
            description={t('install.preflightHint')}
          />

          {plan ? (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('install.targetDir')}：<Text code>{plan.items[0]?.installDir ?? '—'}</Text>
              </Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('install.targetDirHint')}
              </Text>
              {preflight && preflight.totalDownloadBytes > 0 ? (
                <>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('install.downloadSize', {
                      size: formatBytes(preflight.totalDownloadBytes)
                    })}
                  </Text>
                </>
              ) : null}
            </div>
          ) : null}

          {error ? <Alert type="error" showIcon message={error} /> : null}

          <List
            size="small"
            dataSource={preflight?.checks ?? []}
            renderItem={(check) => (
              <CheckRow check={check} label={t(`install.check.${check.level}`)} />
            )}
          />
        </Space>
      </Modal>

      {/* ---------- 进度 / 报告 ---------- */}
      <Drawer
        open={running || phase === 'done'}
        width={720}
        title={running ? t('install.running') : t('install.finished')}
        maskClosable={false}
        onClose={() => {
          if (!running) close()
        }}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {running ? (
              <Button danger onClick={() => void cancel()}>
                {t('install.cancel')}
              </Button>
            ) : (
              <>
                <Button
                  onClick={() => {
                    void exportReport().then(setExportedPath)
                  }}
                >
                  {t('install.exportReport')}
                </Button>
                <Button type="primary" onClick={close}>
                  {t('install.close')}
                </Button>
              </>
            )}
          </div>
        }
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text strong>{t('install.overall')}</Text>
              <Text type="secondary">
                {finishedCount} / {items.length}
              </Text>
            </div>
            <Progress
              percent={percent}
              status={running ? 'active' : plan?.summary.failed ? 'exception' : 'success'}
            />
            {running && currentItemId ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {currentItemId} · {t(`install.state.${plan?.items.find((i) => i.id === currentItemId)?.state ?? 'pending'}`)}
                {detailText ? ` · ${detailText}` : ''}
              </Text>
            ) : null}
          </div>

          {error ? <Alert type="error" showIcon message={error} /> : null}

          {exportedPath ? (
            <Alert
              type="success"
              showIcon
              message={t('install.reportExported', { path: exportedPath })}
            />
          ) : null}

          {!running && plan && plan.summary.failed > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`${t('install.finished')}：${plan.summary.success} / ${plan.summary.total}`}
            />
          ) : null}

          <List
            size="small"
            header={<Text strong>{t('install.itemList')}</Text>}
            dataSource={items}
            renderItem={(item) => (
              <ItemRow
                item={item}
                current={item.id === currentItemId}
                detailText={item.id === currentItemId ? detailText : null}
              />
            )}
          />
        </Space>
      </Drawer>

      {/* ---------- 续跑提示 ---------- */}
      <Modal
        open={pending !== null && phase === 'idle'}
        title={t('install.pending.title')}
        width={560}
        closable={false}
        maskClosable={false}
        footer={[
          <Button key="discard" onClick={() => void discardPending()}>
            {t('install.pending.discard')}
          </Button>,
          <Button
            key="resume"
            type="primary"
            loading={busy}
            disabled={pending?.status !== 'ok'}
            onClick={() => void resume()}
          >
            {t('install.pending.resume')}
          </Button>
        ]}
      >
        {pending?.status === 'ok' ? (
          <Text>
            {t('install.pending.body', {
              id: pending.plan.planId,
              count: unfinishedCount(pending.plan)
            })}
          </Text>
        ) : pending?.status === 'invalid' ? (
          <Alert type="warning" showIcon message={t('install.pending.invalid', { reason: pending.reason })} />
        ) : null}
      </Modal>
    </>
  )
}
