import { useEffect, useRef, useState } from 'react'
import { Button, Card, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { useLogStore } from '../store/log-store'
import { formatTime } from '../utils/format'

const { Text } = Typography

export function LogPanel() {
  const { t } = useTranslation()
  const entries = useLogStore((state) => state.entries)
  const [paused, setPaused] = useState(false)
  const viewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (paused) return
    const element = viewRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [entries, paused])

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          <Text strong>{t('log.title')}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {entries.length}
          </Text>
        </Space>
      }
      extra={
        <Button size="small" type="text" onClick={() => setPaused((value) => !value)}>
          {paused ? t('log.resumeScroll') : t('log.pauseScroll')}
        </Button>
      }
      styles={{ body: { padding: 8 } }}
    >
      <div className="dk-log-view dk-mono" ref={viewRef}>
        {entries.length === 0 ? (
          <div className="dk-log-line dk-log-debug">{t('log.empty')}</div>
        ) : (
          entries.map((entry, index) => (
            <div key={`${entry.ts}-${index}`} className={`dk-log-line dk-log-${entry.level}`}>
              {`${formatTime(entry.ts)} [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}`}
            </div>
          ))
        )}
      </div>
    </Card>
  )
}
