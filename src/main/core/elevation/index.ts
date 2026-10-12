import { join } from 'node:path'
import type { InstallerCommand } from '../templates'
import { getUserDataDir } from '../../utils/app-paths'
import { logger } from '../report/logger'
import { runJob, type RunJobOptions } from './run-job'
import type { ElevationOutcome, ElevationStep } from './helper-script'

export { isElevated } from './helper-script'
export type { ElevationOutcome, ElevationStep, StepResult } from './helper-script'

/** 提权作业文件放在用户数据目录，卸载时随 devkit 一起清掉 */
export function getElevationDir(): string {
  return join(getUserDataDir(), 'elevation')
}

export async function runElevated(
  steps: ElevationStep[],
  onLog?: (message: string) => void
): Promise<ElevationOutcome> {
  const options: RunJobOptions = { jobDir: getElevationDir(), steps, onLog }
  const outcome = await runJob(options)
  logger.info(
    'elevation',
    `提权作业结束：${outcome.ok ? '成功' : '失败'}（提权=${outcome.elevated}，步骤 ${outcome.steps.length}）` +
      (outcome.error ? `，${outcome.error}` : '')
  )
  return outcome
}

/** 把一条安装命令包成一个提权步骤 */
export function toExecStep(label: string, command: InstallerCommand): ElevationStep {
  return { kind: 'exec', label, cmd: command.cmd, args: command.args, timeoutMs: 30 * 60 * 1000 }
}

/** 安装前创建系统还原点（FR-10） */
export async function createRestorePoint(onLog?: (message: string) => void): Promise<ElevationOutcome> {
  return runElevated(
    [
      {
        kind: 'restore-point',
        label: '创建系统还原点',
        description: `devkit 安装前自动创建（${new Date().toISOString()}）`
      }
    ],
    onLog
  )
}
