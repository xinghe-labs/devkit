import { useEffect, useRef, useState } from 'react'
import { Button, Collapse, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { useLogStore } from '../store/log-store'
import { formatTime } from '../utils/format'

const { Text } = Typography

/**
 * 运行日志。
 *
 * 默认折叠：M0 阶段日志基本是噪音，常驻 220px 会把软件列表压得很矮。
 * 装到 M1 有真实安装过程时，再由安装页主动展开（受控模式）。
 */
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
    <Collapse
      size="small"
      items={[
        {
          key: 'log',
          label: (
            <Space size={8}>
              <Text strong style={{ fontSize: 13 }}>
                {t('log.title')}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {entries.length}
              </Text>
            </Space>
          ),
          extra: (
            <Button
              size="small"
              type="text"
              onClick={(event) => {
                // 阻止冒泡，否则点暂停会连带把面板收起来
                event.stopPropagation()
                setPaused((value) => !value)
              }}
            >
              {paused ? t('log.resumeScroll') : t('log.pauseScroll')}
            </Button>
          ),
          children: (
            <div className="dk-log-view dk-mono" ref={viewRef}>
              {entries.length === 0 ? (
                <div className="dk-log-line dk-log-debug">{t('log.empty')}</div>
              ) : (
                entries.map((entry, index) => (
                  <div
                    key={`${entry.ts}-${index}`}
                    className={`dk-log-line dk-log-${entry.level}`}
                  >
                    {`${formatTime(entry.ts)} [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}`}
                  </div>
                ))
              )}
            </div>
          )
        }
      ]}
    />
  )
}
